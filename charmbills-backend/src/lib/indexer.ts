import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { decryptPayrollData, EncryptedData } from '@shared/encryption';
import { getFromIPFS } from './ipfs-pinner';
import { PlanCache, WorkerCache, CompanyRecord } from '../db/schema';
import { 
  PAYROLL_NFT_TICKER,
  DEFAULT_RPC_HOST,
  DEFAULT_RPC_PORT,
  INDEXER_BATCH_SIZE,
  INDEXER_SCAN_INTERVAL_MS,
  SCROLL_FIXED_COST,
  SCROLL_FEE_ADDRESS_TESTNET4,
  MIN_OUTPUT_SATS,
  PLATFORM_FEE_ADDRESS,
  PLATFORM_FEE_BASIS_POINTS
} from '@shared/constants';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';
import * as scrolls from '../bitcoin/scrollsClient';
import { generateUnsignedTransactions } from '../charms/proverClient';
import { getDynamicFundingUtxo, fetchTransactionHex, verifyUtxoStatus } from './utxo-manager';
import { calculateScrollFee } from './charms-utils';

// =========================================================================
// CRITICAL FIX: Use the DEDICATED SCANNER BRIDGE for extractAndVerifySpell
// This preserves the prover bridge (charms_lib.js) for templating while
// using the scanner bridge (charms_protocol_scanner.js) for blockchain indexing
// =========================================================================
console.log("Loading from:", require.resolve("../charms/wasm/charms_protocol_scanner.js"));
const charms = require("../charms/wasm/charms_protocol_scanner.js");

// Load environment variables
dotenv.config();

// =========================================================================
// SYNC LOCK: Prevent redundant concurrent syncs
// This ensures that if one request has already started a sync, 
// subsequent API calls just return without starting a redundant second scan
// =========================================================================
let isSyncing = false;

export interface IndexerConfig {
  rpcUrl?: string;
  rpcUser?: string;
  rpcPassword?: string;
  startBlock?: number;
  batchSize?: number;
  scanIntervalMs?: number;
}

export class DerivableIndexer {
  private db: any;
  private config: IndexerConfig;
  private currentBlock: number;
  private rpcUrl: string;
  private rpcAuth: string;
  private wasmInitialized: boolean = false;
  
  // Tracking stats for professional logging
  private stats = {
    totalTxProcessed: 0,
    totalSpellsFound: 0,
    totalPayrollSpells: 0,
    totalErrors: 0,
    startTime: 0
  };

  constructor(db: any, config: IndexerConfig = {}) {
    this.db = db;
    
    const rpcUser = config.rpcUser || process.env.RPC_USER;
    const rpcPassword = config.rpcPassword || process.env.RPC_PASSWORD;
    
    if (!rpcUser || !rpcPassword) {
      throw new Error(
        'RPC credentials required. Set RPC_USER and RPC_PASSWORD in .env file or pass to config.'
      );
    }
    
    const host = DEFAULT_RPC_HOST;
    const port = DEFAULT_RPC_PORT;
    this.rpcUrl = config.rpcUrl || `http://${host}:${port}`;
    this.rpcAuth = 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64');
    
    this.config = {
      batchSize: INDEXER_BATCH_SIZE,
      scanIntervalMs: INDEXER_SCAN_INTERVAL_MS,
      ...config
    };
    
    this.currentBlock = config.startBlock || 
                        Number(process.env.INDEXER_START_BLOCK) || 
                        130800;
    
    console.log(`🔧 [INDEXER] Initialized with RPC URL: ${this.rpcUrl.replace(/:[^:]*@/, ':****@')}`);
    console.log(`🔧 [INDEXER] Starting from block: ${this.currentBlock}`);
    console.log(`🔧 [INDEXER] Batch size: ${this.config.batchSize}, Scan interval: ${this.config.scanIntervalMs}ms`);
  }

  // =========================================================================
  // Helper to convert Turso result to row object
  // =========================================================================
  private async dbGet(sql: string, args: any[] = []): Promise<any> {
    try {
      const result = await this.db.execute({ sql, args });
      return result.rows[0] || null;
    } catch (error) {
      console.error('[INDEXER] Database error in dbGet:', error);
      return null;
    }
  }

  private async dbRun(sql: string, args: any[] = []): Promise<any> {
    try {
      const result = await this.db.execute({ sql, args });
      return result;
    } catch (error) {
      console.error('[INDEXER] Database error in dbRun:', error);
      throw error;
    }
  }

  // =========================================================================
  // Helper to update plan status
  // =========================================================================
  private async updatePlanStatus(appId: string, status: 'active' | 'failed'): Promise<void> {
    try {
      await this.dbRun(
        'UPDATE plans SET status = ?, updatedAt = ? WHERE appId = ?',
        [status, new Date().toISOString(), appId]
      );
      console.log(`[INDEXER]   ✅ Plan status updated to '${status}': ${appId.substring(0, 16)}...`);
    } catch (error) {
      console.error(`[INDEXER]   ❌ Failed to update plan status:`, error);
    }
  }

  // =========================================================================
  // Helper to update audit log status
  // =========================================================================
  private async updateAuditLogStatus(txid: string, status: 'confirmed'): Promise<void> {
    try {
      await this.dbRun(
        'UPDATE audit_logs SET status = ? WHERE txid = ?',
        [status, txid]
      );
      console.log(`[INDEXER]   ✅ Audit log confirmed for tx: ${txid.substring(0, 16)}...`);
    } catch (error) {
      console.error(`[INDEXER]   ❌ Failed to update audit log:`, error);
    }
  }

  // =========================================================================
  // Helper to update worker after mint (for Stage 2 activation)
  // =========================================================================
  private async updateWorkerPostMint(
    walletAddress: string,
    planId: string,
    tokenUtxo: string,
    expiresAt: string,
    lastMintedPeriod: string
  ): Promise<void> {
    try {
      await this.dbRun(
        `UPDATE workers 
          SET currentTokenUtxo = ?, 
              expiresAt = ?, 
              lastMintedPeriod = ?,
              status = 'active',
              updatedAt = ?
          WHERE walletAddress = ? AND planId = ?`,
        [
          tokenUtxo,
          expiresAt,
          lastMintedPeriod,
          new Date().toISOString(),
          walletAddress,
          planId
        ]
      );
      console.log(`[INDEXER]   ✅ Worker ${walletAddress.substring(0, 16)}... updated to 'active' with token UTXO: ${tokenUtxo.substring(0, 20)}...`);
    } catch (error) {
      console.error(`[INDEXER]   ❌ Failed to update worker post-mint:`, error);
    }
  }

  // =========================================================================
  // Helper to create audit log
  // =========================================================================
  private async createAuditLog(
    id: string,
    type: 'PLAN_CREATED' | 'BATCH_MINT' | 'SCROLL_RELEASE' | 'TERMINATION' | 'TREASURY_FUNDING' | 'VAULT_WITHDRAWAL',
    details: string,
    txid: string,
    status: 'pending' | 'confirmed' | 'failed'
  ): Promise<void> {
    try {
      await this.dbRun(`
        INSERT INTO audit_logs (id, type, details, txid, timestamp, status)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [id, type, details, txid, new Date().toISOString(), status]);
    } catch (error) {
      console.error(`[INDEXER] Failed to create audit log:`, error);
    }
  }

  // =========================================================================
  // PUBLIC METHODS FOR LAZY INDEXER PATTERN
  // =========================================================================

  /**
   * Initialize WASM module - Uses the DEDICATED SCANNER BRIDGE
   * The scanner bridge is built with --target nodejs and exports extractAndVerifySpell
   */
  public async initWasm(): Promise<void> {
    if (!this.wasmInitialized) {
      console.log('[INDEXER] 🚀 Initializing Charms Scanner WASM...');
      
      // Check if the scanner bridge has the extractAndVerifySpell function
      if (typeof charms.extractAndVerifySpell !== 'function') {
        throw new Error("Scanner bridge missing 'extractAndVerifySpell'. Ensure charms_protocol_scanner.js was generated with --target nodejs");
      }
      
      this.wasmInitialized = true;
      console.log('[INDEXER] ✅ Charms Scanner Library Verified & Ready.');
    }
  }

  /**
   * Get the latest block height from Bitcoin node
   * Made public for Lazy Indexer pattern
   */
  public async getLatestBlockHeight(): Promise<number> {
    const start = Date.now();
    const height = await this.rpcCall('getblockcount', []);
    console.log(`[INDEXER] 📊 Latest block height: ${height} (fetched in ${Date.now() - start}ms)`);
    return height;
  }

  /**
   * Index a range of blocks
   * Made public for Lazy Indexer pattern
   * Preserves all existing audit log and reconciliation logic
   */
  public async indexBlocks(fromBlock: number, toBlock: number): Promise<void> {
    await this.initWasm();
    
    const totalBlocks = toBlock - fromBlock + 1;
    console.log(`[INDEXER] 📦 Indexing ${totalBlocks} blocks (${fromBlock} → ${toBlock})`);
    this.stats.startTime = Date.now();
    
    for (let blockHeight = fromBlock; blockHeight <= toBlock; blockHeight += this.config.batchSize!) {
      const endBlock = Math.min(blockHeight + this.config.batchSize! - 1, toBlock);
      const batchStart = Date.now();
      
      try {
        const blockHashes = await this.getBlockHashes(blockHeight, endBlock);
        console.log(`[INDEXER] 📋 Batch ${blockHeight}-${endBlock}: ${blockHashes.length} blocks to process`);
        
        for (const blockHash of blockHashes) {
          await this.indexBlock(blockHash);
        }
        
        const elapsed = Date.now() - batchStart;
        console.log(`[INDEXER] ✅ Indexed blocks ${blockHeight}-${endBlock} (${elapsed}ms, ${(totalBlocks / (elapsed / 1000)).toFixed(1)} blocks/sec)`);
        await this.saveLastIndexedBlock(endBlock);
        
      } catch (error) {
        console.error(`[INDEXER] ❌ Failed to index blocks ${blockHeight}-${endBlock}:`, error);
      }
    }
    
    const totalElapsed = Date.now() - this.stats.startTime;
    console.log(`[INDEXER] 📊 BATCH SUMMARY: Processed ${this.stats.totalTxProcessed} txs, ${this.stats.totalSpellsFound} spells, ${this.stats.totalPayrollSpells} payroll spells, ${this.stats.totalErrors} errors in ${totalElapsed}ms`);
    
    // =========================================================================
    // AUTOMATED RELEASES: After processing blocks, check for mature payroll tokens
    // =========================================================================
    const latestHeight = await this.getLatestBlockHeight();
    await this.processAutomatedReleases(latestHeight);
  }

  /**
   * Save the last indexed block to database
   * Uses a dedicated config table to persist progress
   */
  private async saveLastIndexedBlock(blockNumber: number): Promise<void> {
    try {
      await this.dbRun(`
        CREATE TABLE IF NOT EXISTS indexer_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )
      `, []);
      
      await this.dbRun(`
        INSERT OR REPLACE INTO indexer_config (key, value, updatedAt)
        VALUES ('lastIndexedBlock', ?, ?)
      `, [blockNumber.toString(), new Date().toISOString()]);
      
      console.log(`[INDEXER] 💾 Saved progress: last indexed block = ${blockNumber}`);
    } catch (error) {
      console.error(`[INDEXER] Failed to save last indexed block:`, error);
    }
  }

  /**
   * Start continuous indexing (for persistent server environments)
   * This method runs an infinite loop - DO NOT use on Vercel
   */
  async start(): Promise<void> {
    await this.initWasm();
    
    console.log(`[INDEXER] 🔄 Starting continuous indexing from block ${this.currentBlock}`);
    
    while (true) {
      try {
        const latestBlock = await this.getLatestBlockHeight();
        
        if (this.currentBlock <= latestBlock) {
          console.log(`[INDEXER] 📦 New blocks available: ${this.currentBlock} → ${latestBlock} (${latestBlock - this.currentBlock + 1} blocks)`);
          await this.indexBlocks(this.currentBlock, latestBlock);
          this.currentBlock = latestBlock + 1;
        } else {
          console.log(`[INDEXER] ⏳ No new blocks. Waiting ${this.config.scanIntervalMs}ms...`);
        }
        
        await new Promise(resolve => setTimeout(resolve, this.config.scanIntervalMs));
      } catch (error) {
        console.error('[INDEXER] ❌ Indexer error:', error);
        await new Promise(resolve => setTimeout(resolve, 60000));
      }
    }
  }

  // =========================================================================
  // PRIVATE METHODS
  // =========================================================================

  private async getBlockHashes(from: number, to: number): Promise<string[]> {
    const hashes = [];
    for (let i = from; i <= to; i++) {
      const hash = await this.rpcCall('getblockhash', [i]);
      hashes.push(hash);
    }
    return hashes;
  }

  private async getBlock(blockHash: string): Promise<any> {
    return this.rpcCall('getblock', [blockHash, 2]);
  }

  // =========================================================================
  // Helper to fetch raw transaction hex by txid
  // =========================================================================
  private async fetchRawTransactionHex(txid: string): Promise<string> {
    try {
      return await this.rpcCall('getrawtransaction', [txid]);
    } catch (error) {
      console.error(`[INDEXER] Failed to fetch raw transaction ${txid.substring(0, 16)}...:`, error);
      throw error;
    }
  }

  // =========================================================================
  // ASSET-LEDGER FILTERING HELPERS
  // =========================================================================

  /**
   * Fast filter: Check if transaction contains our App Verification Key or related patterns
   * This prevents calling the brittle WASM on irrelevant transactions
   * Optimized to catch both Stage 1 (Plan NFT Mint) and Stage 2 (Token Mint) transactions
   */
  private isCharmsPayTransaction(txHex: string): boolean {
    const hex = txHex.toLowerCase();
    
    // 1. MATCH: Our Specific App Identity (Verification Key)
    // This catches Stage 2 Token Mints where the VK is more visible
    const APP_VK = process.env.HARDCODED_APP_VK || "8e53ade8824e05fc31361802c86669b4bc62d5c1a190e5845bedf0f2be69610c";
    if (hex.includes(APP_VK.toLowerCase())) {
      console.log(`[INDEXER]   ✓ Matched App VK pattern`);
      return true;
    }

    // 2. MATCH: Our Department Ticker Pattern ("-PAY")
    // This catches Stage 1 Plan NFT Mints (e.g., "SALES-PAY")
    // "2d504159" is the hex representation of "-PAY"
    if (hex.includes("2d504159")) {
      console.log(`[INDEXER]   ✓ Matched department ticker pattern (-PAY)`);
      return true;
    }

    // 3. MATCH: General Charms Spell Marker
    // "6a057370656c6c" represents OP_RETURN + 5-byte "spell" string
    // This is a safety net to ensure we don't skip potential valid spells
    if (hex.includes("6a057370656c6c")) {
      console.log(`[INDEXER]   ✓ Matched OP_RETURN spell marker`);
      return true;
    }

    return false;
  }

  /**
   * Follow the Money Filter: Check if transaction spends a known asset
   * (Plan NFT from plans table or Worker Token from workers table)
   */
  private async isSpendingKnownAsset(tx: any): Promise<boolean> {
    if (!tx.vin || !Array.isArray(tx.vin)) return false;
    
    for (const input of tx.vin) {
      if (!input.txid || input.vout === undefined) continue;
      
      const inputUtxoId = `${input.txid}:${input.vout}`;
      
      // Check if this input spends a known Plan NFT from plans table
      const knownPlan = await this.dbGet('SELECT appId FROM plans WHERE nftUtxoId = ?', [inputUtxoId]);
      if (knownPlan) {
        console.log(`[INDEXER]   📌 Input ${inputUtxoId} is a known Plan NFT`);
        return true;
      }
      
      // Check if this input spends a known Worker Token from workers table
      const knownWorker = await this.dbGet('SELECT walletAddress FROM workers WHERE currentTokenUtxo = ?', [inputUtxoId]);
      if (knownWorker) {
        console.log(`[INDEXER]   📌 Input ${inputUtxoId} is a known Worker Token`);
        return true;
      }
    }
    
    return false;
  }

  // =========================================================================
  // MAIN INDEX BLOCK METHOD - Handles both Spell and Non-Spell Transactions
  // FIX: Added Asset-Ledger Filtering to prevent calling WASM on irrelevant transactions
  // FIX: Optimized filter catches both Stage 1 (Plan NFT) and Stage 2 (Token) transactions
  // FIX: Always call processPayrollSpell for any extracted spell
  // =========================================================================
  private async indexBlock(blockHash: string): Promise<void> {
    const blockStart = Date.now();
    const block = await this.getBlock(blockHash);
    const txCount = block.tx.length;
    
    console.log(`[INDEXER] 📦 Processing block ${block.height} | ${txCount} txns | Hash: ${blockHash.substring(0, 16)}...`);
    
    let blockSpellsFound = 0;
    let blockPayrollSpells = 0;
    let skippedCount = 0;
    
    if (process.env.NODE_ENV === 'development') {
      const testTx = block.tx[0];
      if (testTx) {
        const txId = bitcoin.Transaction.fromHex(testTx.hex || testTx).getId();
        console.log(`[INDEXER]   First tx in block: ${txId.substring(0, 16)}...`);
      }
    }
    
    for (const tx of block.tx) {
      const txStart = Date.now();
      this.stats.totalTxProcessed++;
      
      try {
        const rawTxHex = tx.hex || tx;
        
        // =========================================================================
        // ASSET-LEDGER FILTERING: Only process relevant transactions
        // First check: Does it contain our App VK, ticker pattern, or spell marker?
        // Second check: Does it spend a known asset from our database?
        // This prevents calling the brittle WASM on random Testnet4 transactions
        // =========================================================================
        const hasCharmsPattern = this.isCharmsPayTransaction(rawTxHex);
        const spendsKnownAsset = await this.isSpendingKnownAsset(tx);
        
        if (!hasCharmsPattern && !spendsKnownAsset) {
          skippedCount++;
          continue;
        }
        
        console.log(`[INDEXER] 🎯 Relevant CharmsPay Tx Detected: ${tx.txid.substring(0, 16)}...`);
        console.log(`[INDEXER]   hasCharmsPattern: ${hasCharmsPattern}, spendsKnownAsset: ${spendsKnownAsset}`);
        
        // =========================================================================
        // Fetch authority parent (first input) for context
        // =========================================================================
        let authorityParentHex: string | null = null;
        let madeRpcCalls = false;
        
        // Fetch parent for the first input (authority UTXO) only
        if (tx.vin && Array.isArray(tx.vin) && tx.vin.length > 0) {
          const firstInput = tx.vin[0];
          
          if (firstInput && firstInput.txid) {
            console.log(`[INDEXER]   🔍 fetching authority parent (Input 0)...`);
            
            try {
              authorityParentHex = await this.fetchRawTransactionHex(firstInput.txid);
              console.log(`[INDEXER]     ✓ Fetched authority parent: ${firstInput.txid.substring(0, 16)}... (${authorityParentHex.length} bytes)`);
              madeRpcCalls = true;
            } catch (err: any) {
              console.warn(`[INDEXER]     ✗ Failed to fetch authority parent: ${firstInput.txid.substring(0, 16)}... - ${err.message}`);
            }
          }
        }
        
        // =========================================================================
        // UNIVERSAL WASM FIX (Stage 1 & Stage 2)
        // We pass ONLY the 'bitcoin' hex string to the scanner.
        // This prevents the "Length 2" crash caused by the 'prev_txs' key.
        // The scanner will successfully extract the asset data (NFT or Token).
        // =========================================================================
        if (authorityParentHex) {
          // CRITICAL FIX: Pass ONLY the bitcoin hex, NO prev_txs
          const spellInput: any = { 
            bitcoin: rawTxHex
          };
          
          console.log(`[INDEXER]   📝 Built spellInput with ONLY bitcoin (no prev_txs)`);
          
          // =========================================================================
          // DEBUG: Log exact object being passed to WASM for debugging
          // This shows the structure and keys to verify correct format
          // =========================================================================
          console.log("[INDEXER]   [DEBUG] Exact object keys being passed to WASM:", Object.keys(spellInput));
          console.log("[INDEXER]   [DEBUG] spellInput structure (first 500 chars):", JSON.stringify(spellInput).substring(0, 500));
          console.log("[INDEXER]   [DEBUG] spellInput.bitcoin length:", spellInput.bitcoin?.length);
          
          try {
            console.log(`[INDEXER]   🧪 Calling extractAndVerifySpell...`);
            const startWasm = Date.now();
            const spell = charms.extractAndVerifySpell(spellInput, false);
            const wasmTime = Date.now() - startWasm;
            
            if (wasmTime > 1000) {
              console.log(`[INDEXER]   ⏱️ Slow WASM call: ${wasmTime}ms`);
            }
            
            if (spell) {
              this.stats.totalSpellsFound++;
              blockSpellsFound++;
              console.log(`[INDEXER]   ✅ Spell extracted successfully (version: ${spell.version})`);
              
              // =========================================================================
              // CRITICAL FIX: ALWAYS call processPayrollSpell for any extracted spell
              // The function will determine if it's a payroll spell (Plan NFT or Token Mint)
              // =========================================================================
              const isPayroll = await this.processPayrollSpell(spell, block.height, tx.txid);
              if (isPayroll) {
                blockPayrollSpells++;
                this.stats.totalPayrollSpells++;
              }
              
              // =========================================================================
              // STAGE 1 ACTIVATION: Detect Plan NFT Mint (mint-nft)
              // =========================================================================
              if (spell.type === 'mint-nft') {
                const appId = spell.appId || spell.app_id;
                console.log(`[INDEXER] 🛡️ STAGE 1: Validated Plan NFT on-chain: ${appId?.substring(0, 16)}...`);
                
                if (appId) {
                  await this.updatePlanStatus(appId, 'active');
                  await this.updateAuditLogStatus(tx.txid, 'confirmed');
                  console.log(`[INDEXER]   ✅ Plan NFT activated, audit log confirmed`);
                }
              }
              
              // =========================================================================
              // STAGE 2 ACTIVATION: Detect Token Mint (mint-token)
              // =========================================================================
              if (spell.type === 'mint-token') {
                console.log(`[INDEXER] 💸 STAGE 2: Validated Worker Tokens on-chain in tx: ${tx.txid}`);
                
                const appId = spell.appId || spell.app_id;
                let outputIndex = 0;
                
                // Loop through outputs in the spell to identify which workers were paid
                // Check spell.outputs first (new format), then fallback to spell.tx.outs
                let outputs = spell.outputs;
                if (!outputs || !Array.isArray(outputs)) {
                  outputs = spell.tx?.outs;
                }
                
                if (outputs && Array.isArray(outputs)) {
                  for (let idx = 0; idx < outputs.length; idx++) {
                    const output = outputs[idx];
                    
                    // Check if this output is a token output (tag 't' or has tokenAmount/worker address)
                    const isTokenOutput = (output.tag === 't') || 
                                          (output.tokenAmount !== undefined) ||
                                          (output.address && output.address.startsWith('tb1'));
                    
                    if (isTokenOutput) {
                      // Determine the wallet address
                      let walletAddress = output.address;
                      if (!walletAddress && output.dest) {
                        // Convert dest hex to address if needed
                        walletAddress = output.dest;
                      }
                      
                      if (walletAddress) {
                        const tokenUtxo = `${tx.txid}:${idx}`;
                        const expiresAt = output.expiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
                        const period = output.period || output.tokenAmount || 1;
                        const lastMintedPeriod = new Date().toISOString();
                        
                        console.log(`[INDEXER]   📝 Updating worker ${walletAddress.substring(0, 16)}... with token UTXO: ${tokenUtxo}`);
                        
                        await this.updateWorkerPostMint(
                          walletAddress,
                          appId,
                          tokenUtxo,
                          expiresAt,
                          lastMintedPeriod
                        );
                        outputIndex++;
                      }
                    }
                  }
                }
                
                console.log(`[INDEXER]   ✅ Updated ${outputIndex} workers with token UTXOs`);
                
                // Create audit log for batch mint
                const auditId = crypto.randomUUID();
                await this.createAuditLog(
                  auditId,
                  'BATCH_MINT',
                  `Batch mint confirmed at block ${block.height}`,
                  tx.txid,
                  'confirmed'
                );
                console.log(`[INDEXER]   ✅ Audit log created for batch mint`);
              }
            }
          } catch (spellError: any) {
            console.error(`[INDEXER]   ❌ WASM threw exception: ${spellError.message || spellError}`);
            this.stats.totalErrors++;
          }
        } else {
          console.log(`[INDEXER]   ⚠️ No authority parent hex found - skipping spell extraction`);
        }
        
        // =========================================================================
        // PART 2: Process Standard BTC Transfers (Vault Funding & Withdrawals)
        // =========================================================================
        await this.processStandardTransfers(tx, block.height);
        
        // =========================================================================
        // PART 3: Check for spent worker tokens (Settlement Reconciliation)
        // =========================================================================
        await this.reconcileSettlements(tx, block.height);
        
        // =========================================================================
        // PERFORMANCE FIX: Throttle only when RPC calls were made
        // =========================================================================
        if (madeRpcCalls) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        
        const txElapsed = Date.now() - txStart;
        if (txElapsed > 1000) {
          console.log(`[INDEXER]   ⚠️ Slow tx: ${tx.txid.substring(0, 16)}... took ${txElapsed}ms`);
        }
        
      } catch (error) {
        this.stats.totalErrors++;
        console.error(`[INDEXER]   ❌ Error processing transaction:`, error);
        continue;
      }
    }
    
    const blockElapsed = Date.now() - blockStart;
    console.log(`[INDEXER] ✅ Block ${block.height} complete | ${txCount} txns | ${skippedCount} skipped | ${blockSpellsFound} spells (${blockPayrollSpells} payroll) | ${blockElapsed}ms`);
  }

  // =========================================================================
  // PROCESS STANDARD TRANSFERS - Tracks both INCOMING and OUTGOING vault transactions
  // =========================================================================
  private async processStandardTransfers(tx: any, blockHeight: number): Promise<void> {
    let vaultAddresses: Array<{ address: string; appId: string }> = [];
    try {
      const result = await this.db.execute({
        sql: 'SELECT vaultAddress, appId FROM plans WHERE vaultAddress IS NOT NULL',
        args: []
      });
      vaultAddresses = result.rows || [];
    } catch (error) {
      return;
    }
    
    if (vaultAddresses.length === 0) return;
    
    const vaultAddressSet = new Set(vaultAddresses.map(v => v.address));
    const vaultAddressToAppId = new Map(vaultAddresses.map(v => [v.address, v.appId]));
    
    if (tx.vout && Array.isArray(tx.vout)) {
      for (let i = 0; i < tx.vout.length; i++) {
        const output = tx.vout[i];
        const outputAddress = output.scriptpubkey_address;
        
        if (!outputAddress) continue;
        
        if (vaultAddressSet.has(outputAddress)) {
          const valueSats = output.value;
          const appId = vaultAddressToAppId.get(outputAddress);
          console.log(`[INDEXER] 💰 Vault Funding: ${valueSats} sats → vault for ${appId?.substring(0, 16)}...`);
          
          await this.createAuditLog(
            crypto.randomUUID(),
            'TREASURY_FUNDING',
            `Confirmed funding of ${valueSats} sats to Scroll Vault`,
            tx.txid,
            'confirmed'
          );
        }
      }
    }
    
    if (tx.vin && Array.isArray(tx.vin)) {
      for (const vin of tx.vin) {
        const spentTxid = vin.txid;
        const spentVout = vin.vout;
        
        if (!spentTxid || spentVout === undefined) continue;
        
        try {
          const utxoResult = await this.rpcCall('gettxout', [spentTxid, spentVout, true]);
          
          if (utxoResult && utxoResult.scriptPubKey && utxoResult.scriptPubKey.address) {
            const inputAddress = utxoResult.scriptPubKey.address;
            
            if (vaultAddressSet.has(inputAddress)) {
              const appId = vaultAddressToAppId.get(inputAddress);
              let outgoingValue = 0;
              if (tx.vout && Array.isArray(tx.vout)) {
                outgoingValue = tx.vout.reduce((sum: number, out: any) => sum + (out.value || 0), 0);
              }
              console.log(`[INDEXER] 💸 Vault Withdrawal: ${outgoingValue} sats from vault for ${appId?.substring(0, 16)}...`);
              
              await this.createAuditLog(
                crypto.randomUUID(),
                'VAULT_WITHDRAWAL',
                `Funds withdrawn from Scroll Vault: ${outgoingValue} sats`,
                tx.txid,
                'confirmed'
              );
            }
          }
        } catch (utxoError) {
          continue;
        }
      }
    }
  }

  // =========================================================================
  // PROCESS PAYROLL SPELL - Extracts Plan NFT from OP_RETURN spell data
  // Also handles Stage 1 (mint-nft) and Stage 2 (mint-token) activation
  // FIX: Correct Map access for WASM Version 14+
  // Structure: spell.tx.outs[outputIndex] -> Map(appIndex) -> Map(metadata)
  // Returns: boolean - true if this was a payroll spell, false otherwise
  // FIX: Added employerAddress resolution from treasuryHexDest or existing plan
  // FIX: Non-Custodial Mode - Skip backend decryption, only save metadata hash
  // =========================================================================
private async processPayrollSpell(spell: any, blockHeight: number, txid: string): Promise<boolean> {
  console.log(`[INDEXER] 🔍 Processing payroll spell at block ${blockHeight}, txid: ${txid}`);
  
  // =========================================================================
  // DIAGNOSTIC: Dump the ENTIRE spell structure to understand where data lives
  // This eliminates all guesswork about the spell format
  // =========================================================================
  console.log("[INDEXER] 🔍 ========== SPELL DIAGNOSTIC START ==========");
  console.log("[INDEXER] 🔍 spell type:", typeof spell);
  console.log("[INDEXER] 🔍 spell constructor:", spell?.constructor?.name);
  console.log("[INDEXER] 🔍 spell keys:", Object.keys(spell));
  
  // Check for appId in various possible locations
  console.log("[INDEXER] 🔍 spell.appId:", spell.appId);
  console.log("[INDEXER] 🔍 spell.app_id:", spell.app_id);
  console.log("[INDEXER] 🔍 spell.id:", spell.id);
  
  // Check if spell has a 'data' or 'metadata' field
  if (spell.data) {
    console.log("[INDEXER] 🔍 spell.data type:", typeof spell.data);
    console.log("[INDEXER] 🔍 spell.data keys:", Object.keys(spell.data));
  }
  if (spell.metadata) {
    console.log("[INDEXER] 🔍 spell.metadata type:", typeof spell.metadata);
    console.log("[INDEXER] 🔍 spell.metadata keys:", Object.keys(spell.metadata));
  }
  
  // Check tx structure
  if (spell.tx) {
    console.log("[INDEXER] 🔍 spell.tx keys:", Object.keys(spell.tx));
    console.log("[INDEXER] 🔍 spell.tx.ins length:", spell.tx.ins?.length);
    console.log("[INDEXER] 🔍 spell.tx.outs type:", spell.tx.outs?.constructor?.name);
    console.log("[INDEXER] 🔍 spell.tx.outs length:", spell.tx.outs?.length);
    console.log("[INDEXER] 🔍 spell.tx.coins length:", spell.tx.coins?.length);
    
    // Deep inspect tx.outs if it's an array
    if (Array.isArray(spell.tx.outs)) {
      for (let i = 0; i < spell.tx.outs.length; i++) {
        const out = spell.tx.outs[i];
        console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] type:`, out?.constructor?.name);
        
        if (out instanceof Map) {
          console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] Map keys:`, Array.from(out.keys()));
          // Check each value in the Map
          for (const [key, value] of out.entries()) {
            console.log(`[INDEXER] 🔍   Map key "${key}" -> type: ${value?.constructor?.name}`);
            if (value instanceof Map) {
              console.log(`[INDEXER] 🔍     Inner Map keys:`, Array.from(value.keys()));
              // Try to extract ticker from inner Map
              const innerTicker = value.get('ticker');
              console.log(`[INDEXER] 🔍     Inner Map ticker:`, innerTicker);
            } else if (typeof value === 'object' && value !== null) {
              console.log(`[INDEXER] 🔍     Object keys:`, Object.keys(value));
              console.log(`[INDEXER] 🔍     Object ticker:`, value.ticker);
            }
          }
        } else if (typeof out === 'object' && out !== null) {
          console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] object keys:`, Object.keys(out));
          console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] ticker:`, out.ticker);
        }
      }
    }
  }
  
  // Check spell.outputs (alternative format)
  if (spell.outputs) {
    console.log("[INDEXER] 🔍 spell.outputs type:", spell.outputs?.constructor?.name);
    console.log("[INDEXER] 🔍 spell.outputs length:", spell.outputs?.length);
    if (Array.isArray(spell.outputs)) {
      for (let i = 0; i < spell.outputs.length; i++) {
        const out = spell.outputs[i];
        console.log(`[INDEXER] 🔍 spell.outputs[${i}] type:`, out?.constructor?.name);
        if (out instanceof Map) {
          console.log(`[INDEXER] 🔍 spell.outputs[${i}] Map keys:`, Array.from(out.keys()));
        } else if (typeof out === 'object' && out !== null) {
          console.log(`[INDEXER] 🔍 spell.outputs[${i}] object keys:`, Object.keys(out));
          console.log(`[INDEXER] 🔍 spell.outputs[${i}] ticker:`, out.ticker);
          console.log(`[INDEXER] 🔍 spell.outputs[${i}] appId:`, out.appId);
        }
      }
    }
  }
  
  // Check spell.app_public_inputs for appId
  if (spell.app_public_inputs) {
    console.log("[INDEXER] 🔍 spell.app_public_inputs type:", spell.app_public_inputs?.constructor?.name);
    if (spell.app_public_inputs instanceof Map) {
      console.log("[INDEXER] 🔍 spell.app_public_inputs Map keys:", Array.from(spell.app_public_inputs.keys()));
    } else if (typeof spell.app_public_inputs === 'object') {
      console.log("[INDEXER] 🔍 spell.app_public_inputs keys:", Object.keys(spell.app_public_inputs));
    }
  }
  
  // Try to stringify the whole spell (with Map handling)
  const seen = new WeakSet();
  const mapToObj = (obj: any): any => {
    if (obj === null || typeof obj !== 'object') return obj;
    if (seen.has(obj)) return "[Circular]";
    seen.add(obj);
    if (obj instanceof Map) {
      const result: any = {};
      for (const [k, v] of obj.entries()) {
        result[k] = mapToObj(v);
      }
      return result;
    }
    if (Array.isArray(obj)) {
      return obj.map(mapToObj);
    }
    const result: any = {};
    for (const key of Object.keys(obj)) {
      result[key] = mapToObj(obj[key]);
    }
    return result;
  };
  
  console.log("[INDEXER] 🔍 Full spell as object:", JSON.stringify(mapToObj(spell), null, 2).substring(0, 2000));
  console.log("[INDEXER] 🔍 ========== SPELL DIAGNOSTIC END ==========");
  
  // =========================================================================
  // Now try to extract appId from wherever it might be
  // =========================================================================
  let appId = spell.appId || spell.app_id;
  
  // If appId not found, try to find it in tx.coins or other locations
  if (!appId && spell.tx?.coins && Array.isArray(spell.tx.coins)) {
    for (const coin of spell.tx.coins) {
      if (coin.appId) appId = coin.appId;
      if (coin.app_id) appId = coin.app_id;
      if (coin.id) appId = coin.id;
    }
  }
  
  // If still not found, try to extract from app_public_inputs Map
  if (!appId && spell.app_public_inputs instanceof Map) {
    for (const [key, value] of spell.app_public_inputs.entries()) {
      if (typeof key === 'string' && (key.startsWith('n/') || key.startsWith('t/'))) {
        const parts = key.split('/');
        if (parts.length >= 2) {
          appId = parts[1];
          console.log(`[INDEXER]   📝 Extracted appId from app_public_inputs key: ${appId}`);
          break;
        }
      }
    }
  }
  
  if (!appId) {
    console.log('[INDEXER]   ⚠️ No appId found in spell');
    console.log('[INDEXER]   💡 This spell may not be a payroll spell, or the WASM needs updating');
    return false;
  }
  
  console.log(`[INDEXER]   ✅ Found appId: ${appId.substring(0, 16)}...`);
  
  let nftMetadata = null;
  let nftUtxoId = null;
  
  // =========================================================================
  // EXTRACT ANCHOR UTXO FROM spell.tx.ins (FIRST INPUT)
  // This is the UTXO that was consumed to create the appId
  // FIX: Resolves the "NOT NULL constraint failed: plans.anchorUtxo" error
  // =========================================================================
  let anchorUtxo: string | null = null;
  if (spell.tx && spell.tx.ins && Array.isArray(spell.tx.ins) && spell.tx.ins.length > 0) {
    anchorUtxo = spell.tx.ins[0];
    console.log(`[INDEXER]   ⚓ Anchor UTXO extracted: ${anchorUtxo}`);
  } else {
    console.log(`[INDEXER]   ⚠️ No anchor UTXO found in spell.tx.ins`);
  }
  
  // =========================================================================
  // EXTRACT NFT DESTINATION HEX FOR EMPLOYER ADDRESS RESOLUTION
  // This is the treasuryHexDest that was saved during company registration
  // =========================================================================
  let nftDestHex: string | null = null;
  if (spell.tx && spell.tx.coins && Array.isArray(spell.tx.coins) && spell.tx.coins.length > 0) {
    const firstCoin = spell.tx.coins[0];
    if (firstCoin && firstCoin.dest) {
      nftDestHex = firstCoin.dest;
      console.log(`[INDEXER]   📍 NFT destination hex: ${nftDestHex ? nftDestHex.substring(0, 50) : 'null'}...`);
    }
  }
  
  // =========================================================================
  // RESOLVE EMPLOYER ADDRESS FROM DATABASE
  // Check two places:
  // A) The existing pending plan record (preferred - for re-indexing)
  // B) The companies table using treasuryHexDest (fallback for fresh discovery)
  // =========================================================================
  let employerAddress: string | null = null;
  
  console.log(`[INDEXER]   🔍 Resolving employerAddress for appId: ${appId.substring(0, 16)}...`);
  
  // Check if plan already exists (for re-indexing scenario)
  const existingPlan = await this.dbGet('SELECT employerAddress FROM plans WHERE appId = ?', [appId]);
  if (existingPlan && existingPlan.employerAddress) {
    employerAddress = existingPlan.employerAddress;
    console.log(`[INDEXER]   ✅ Found employerAddress from existing plan: ${employerAddress ? employerAddress.substring(0, 20) : 'null'}...`);
  }
  
  // If not found in plans, try to resolve from companies table using NFT destination hex
  if (!employerAddress && nftDestHex) {
    console.log(`[INDEXER]   🔍 Looking up company by treasuryHexDest: ${nftDestHex.substring(0, 30)}...`);
    const company = await this.dbGet('SELECT employerAddress FROM companies WHERE treasuryHexDest = ?', [nftDestHex]);
    if (company && company.employerAddress) {
      employerAddress = company.employerAddress;
      console.log(`[INDEXER]   ✅ Found employerAddress from companies table: ${employerAddress ? employerAddress.substring(0, 20) : 'null'}...`);
    } else {
      console.log(`[INDEXER]   ⚠️ No company found with treasuryHexDest: ${nftDestHex.substring(0, 30)}...`);
    }
  }
  
  // If still not found, log warning and return false
  if (!employerAddress) {
    console.log(`[INDEXER]   ❌ Could not resolve employerAddress for appId ${appId.substring(0, 16)}...`);
    console.log(`[INDEXER]   💡 This plan will be skipped. Ensure company registration completed before minting.`);
    return false;
  }
  
  // =========================================================================
  // CORRECT MAP ACCESS FOR WASM VERSION 14+
  // Structure: spell.tx.outs[outputIndex] is a Map with app indices as keys
  // Each app index maps to another Map containing the actual metadata
  // =========================================================================
  if (spell.tx && spell.tx.outs && Array.isArray(spell.tx.outs)) {
    for (let outputIndex = 0; outputIndex < spell.tx.outs.length; outputIndex++) {
      const outputMap = spell.tx.outs[outputIndex];
      
      if (outputMap instanceof Map) {
        console.log(`[INDEXER]   📝 Output ${outputIndex} is a Map with ${outputMap.size} entries`);
        console.log(`[INDEXER]   📝 Map keys at output ${outputIndex}:`, Array.from(outputMap.keys()));
        
        // Iterate through app indices (keys like 0, 1, 2, etc.)
        for (const [appIndex, appMetadata] of outputMap.entries()) {
          if (appMetadata instanceof Map) {
            // Extract metadata using .get() method
            const ticker = appMetadata.get('ticker');
            const remaining = appMetadata.get('remaining');
            const metadataHash = appMetadata.get('metadataHash');
            const scrollPolicy = appMetadata.get('scrollPolicy');
            const payPeriodSeconds = appMetadata.get('payPeriodSeconds');
            const compensationSats = appMetadata.get('compensationSats');
            
            console.log(`[INDEXER]   📝 App Index ${appIndex}: ticker=${ticker}, remaining=${remaining}, metadataHash=${metadataHash?.substring(0, 16)}...`);
            
            // Check if this is a Plan NFT (ticker ends with -PAY)
            if (ticker && typeof ticker === 'string' && ticker.endsWith('-PAY')) {
              nftMetadata = {
                ticker,
                remaining,
                metadataHash,
                scrollPolicy,
                payPeriodSeconds,
                compensationSats
              };
              nftUtxoId = `${txid}:${outputIndex}`;
              console.log(`[INDEXER]   ✅ Found Plan NFT at output ${outputIndex}, app ${appIndex} | ticker: ${ticker} | remaining: ${remaining}`);
              break;
            }
            
            // Also check by metadataHash as fallback (Plan NFTs always have metadataHash)
            if (metadataHash && remaining !== undefined && !nftMetadata) {
              nftMetadata = {
                ticker: ticker || 'UNKNOWN-PAY',
                remaining,
                metadataHash,
                scrollPolicy,
                payPeriodSeconds,
                compensationSats
              };
              nftUtxoId = `${txid}:${outputIndex}`;
              console.log(`[INDEXER]   ✅ Found Plan NFT by metadataHash at output ${outputIndex}, app ${appIndex}`);
              break;
            }
          } else {
            console.log(`[INDEXER]   ⚠️ App metadata at index ${appIndex} is not a Map, type: ${appMetadata?.constructor?.name}`);
          }
        }
        
        if (nftMetadata) break;
      } else {
        console.log(`[INDEXER]   ⚠️ Output ${outputIndex} is not a Map, type: ${outputMap?.constructor?.name}`);
      }
    }
  }
  
  // =========================================================================
  // FALLBACK: Handle spell.outputs format (alternative structure)
  // =========================================================================
  if (!nftMetadata && spell.outputs) {
    console.log('[INDEXER]   🔍 Checking spell.outputs fallback...');
    for (let i = 0; i < spell.outputs.length; i++) {
      const output = spell.outputs[i];
      if (!output) continue;
      
      let ticker = null;
      let remaining = null;
      let metadataHash = null;
      let scrollPolicy = null;
      let payPeriodSeconds = null;
      let compensationSats = null;
      
      // Handle Map or plain object
      if (output && typeof output.get === 'function') {
        ticker = output.get('ticker');
        remaining = output.get('remaining');
        metadataHash = output.get('metadataHash');
        scrollPolicy = output.get('scrollPolicy');
        payPeriodSeconds = output.get('payPeriodSeconds');
        compensationSats = output.get('compensationSats');
      } else {
        ticker = output.ticker;
        remaining = output.remaining;
        metadataHash = output.metadataHash;
        scrollPolicy = output.scrollPolicy;
        payPeriodSeconds = output.payPeriodSeconds;
        compensationSats = output.compensationSats;
      }
      
      // Check for nftMetadata wrapper
      if (output.nftMetadata) {
        if (typeof output.nftMetadata.get === 'function') {
          ticker = output.nftMetadata.get('ticker') || ticker;
          remaining = output.nftMetadata.get('remaining') || remaining;
          metadataHash = output.nftMetadata.get('metadataHash') || metadataHash;
        } else {
          ticker = output.nftMetadata.ticker || ticker;
          remaining = output.nftMetadata.remaining || remaining;
          metadataHash = output.nftMetadata.metadataHash || metadataHash;
        }
      }
      
      if (ticker && typeof ticker === 'string' && ticker.endsWith('-PAY')) {
        nftMetadata = {
          ticker,
          remaining,
          metadataHash,
          scrollPolicy,
          payPeriodSeconds,
          compensationSats
        };
        nftUtxoId = `${txid}:${i}`;
        console.log(`[INDEXER]   📝 Found NFT metadata in spell.outputs at index ${i} | ticker: ${ticker}`);
        break;
      }
    }
  }
  
  if (!nftMetadata) {
    console.log('[INDEXER]   ⚠️ No NFT metadata found in spell');
    return false;
  }
  
  const ticker = nftMetadata.ticker;
  const remaining = nftMetadata.remaining;
  const metadataHash = nftMetadata.metadataHash;
  const scrollPolicy = nftMetadata.scrollPolicy;
  const payPeriodSeconds = nftMetadata.payPeriodSeconds;
  const compensationSats = nftMetadata.compensationSats;
  
  if (!ticker || !ticker.endsWith('-PAY')) {
    console.log(`[INDEXER]   ⚠️ Ticker ${ticker} is not a payroll ticker`);
    return false;
  }
  
  console.log(`[INDEXER]   ✅ Plan NFT: ${ticker} | appId=${appId.substring(0, 16)}... | remaining=${remaining} | period=${payPeriodSeconds}s | compensation=${compensationSats}sats`);
  console.log(`[INDEXER]   📍 UTXO: ${nftUtxoId}`);
  if (anchorUtxo) {
    console.log(`[INDEXER]   ⚓ Anchor UTXO: ${anchorUtxo}`);
  }
  console.log(`[INDEXER]   🏢 Employer Address: ${employerAddress.substring(0, 20)}...`);
  
  // =========================================================================
  // FIX: Updated INSERT to include employerAddress and status
  // This resolves the "NOT NULL constraint failed: plans.employerAddress" error
  // =========================================================================
  await this.dbRun(`
    INSERT OR REPLACE INTO plans (
      appId, nftUtxoId, anchorUtxo, employerAddress, ticker, compensationSats, 
      payPeriodSeconds, metadataHash, scrollPolicy, remaining, 
      status, lastIndexedBlock, createdAt, updatedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    appId,
    nftUtxoId,
    anchorUtxo || '',
    employerAddress,
    ticker,
    compensationSats || 0,
    payPeriodSeconds || 0,
    metadataHash || '',
    scrollPolicy || 0,
    remaining || 0,
    'active',  // Explicitly mark as active (confirmed on-chain)
    blockHeight,
    new Date().toISOString(),
    new Date().toISOString()
  ]);
  
  console.log(`[INDEXER]   ✅ Plan record saved to database with status 'active'`);
  
  await this.createAuditLog(
    crypto.randomUUID(),
    'PLAN_CREATED',
    `Plan NFT created: ${ticker}`,
    txid,
    'confirmed'
  );
  console.log(`[INDEXER]   ✅ Audit log created for Plan NFT: ${ticker}`);
  
  // =========================================================================
  // NON-CUSTODIAL MODE: Save encrypted metadata hash only
  // The frontend will handle decryption using the user's wallet
  // This ensures security: even if database is hacked, only encrypted data is exposed
  // =========================================================================
  if (metadataHash) {
    try {
      console.log(`[INDEXER]   📦 Saving encrypted metadata hash: ${metadataHash.substring(0, 32)}...`);
      
      // Instead of decrypting, we just update the database with the IPFS hash.
      // The Frontend will handle the actual decryption later.
      await this.dbRun(
        'UPDATE plans SET metadataHash = ? WHERE appId = ?',
        [metadataHash, appId]
      );
      
      console.log(`[INDEXER]   ✅ Metadata hash cached for appId: ${appId.substring(0, 8)}...`);
      console.log(`[INDEXER]   ℹ️ Non-Custodial Mode: Decryption will happen in the browser when user logs in.`);
    } catch (error) {
      // Non-Custodial Mode: This block no longer needs to crash if entropy is missing
      console.log(`[INDEXER]   ℹ️ Skipping backend decryption (Non-Custodial Mode Active)`);
      console.log(`[INDEXER]   📦 Metadata hash will be decrypted by frontend wallet.`);
    }
  }
  
  return true;
}

  private async enrichPlanWithMetadata(appId: string, metadataHash: string): Promise<void> {
    // =========================================================================
    // NON-CUSTODIAL MODE: This function is deprecated
    // Backend no longer decrypts metadata. The frontend handles decryption.
    // Keeping this function for reference but it will not be called.
    // =========================================================================
    console.log(`[INDEXER]   ℹ️ enrichPlanWithMetadata called but Non-Custodial Mode is active.`);
    console.log(`[INDEXER]   📦 Metadata hash ${metadataHash.substring(0, 32)}... will be decrypted by frontend.`);
    return;
  }

  // =========================================================================
  // PRODUCTION RECONCILIATION: Scans for spent worker tokens 
  // to move them to 'historicalTokens' and confirm audit logs.
  // =========================================================================
  private async reconcileSettlements(tx: any, blockHeight: number): Promise<void> {
    if (!tx.vin || !Array.isArray(tx.vin)) return;
    
    for (const vin of tx.vin) {
      const spentUtxoId = `${vin.txid}:${vin.vout}`;
      
      const workerResult = await this.dbGet(
        'SELECT walletAddress, planId FROM workers WHERE currentTokenUtxo = ? AND status = ?',
        [spentUtxoId, 'active']
      );
      const worker = workerResult as { walletAddress: string; planId: string } | undefined;
      
      if (worker) {
        console.log(`[INDEXER]   🔄 Worker token spent: ${spentUtxoId} | worker: ${worker.walletAddress.substring(0, 16)}...`);
        
        const timestamp = Math.floor(Date.now() / 1000);
        
        const existingWorkerResult = await this.dbGet(
          'SELECT historicalTokens FROM workers WHERE walletAddress = ? AND planId = ?',
          [worker.walletAddress, worker.planId]
        );
        const existingWorker = existingWorkerResult as { historicalTokens: string } | undefined;
        
        let history: any[] = [];
        if (existingWorker && existingWorker.historicalTokens) {
          try {
            history = JSON.parse(existingWorker.historicalTokens);
          } catch (e) {
            history = [];
          }
        }
        
        history.push({
          utxoId: spentUtxoId,
          timestamp: timestamp,
          spentAt: new Date().toISOString(),
          blockHeight: blockHeight
        });
        
        await this.dbRun(
          'UPDATE workers SET currentTokenUtxo = NULL, historicalTokens = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
          [JSON.stringify(history), new Date().toISOString(), worker.walletAddress, worker.planId]
        );
        
        const auditLogResult = await this.dbGet(
          'SELECT id FROM audit_logs WHERE txid = ? AND type = ?',
          [tx.txid, 'SCROLL_RELEASE']
        );
        const auditLog = auditLogResult as { id: string } | undefined;
        
        if (auditLog) {
          await this.dbRun(
            'UPDATE audit_logs SET status = "confirmed", timestamp = ? WHERE id = ?',
            [new Date().toISOString(), auditLog.id]
          );
          console.log(`[INDEXER]   ✅ Audit log confirmed for tx: ${tx.txid.substring(0, 16)}...`);
        } else {
          await this.createAuditLog(
            crypto.randomUUID(),
            'SCROLL_RELEASE',
            `Salary payment released for worker ${worker.walletAddress.substring(0, 16)}...`,
            tx.txid,
            'confirmed'
          );
          console.log(`[INDEXER]   ✅ Created audit log for Scroll release: ${tx.txid.substring(0, 16)}...`);
        }
      }
    }
  }

  // =========================================================================
  // AUTOMATED AGENT: Identifies worker tokens that have reached their expiresAt height
  // and triggers the Scroll settlement process automatically.
  // 
  // FIX: Added secondary UTXO status verification to ensure token hasn't been spent or reorged
  // =========================================================================
  private async processAutomatedReleases(currentBlockHeight: number): Promise<void> {
    console.log(`[INDEXER] ⏰ Checking for mature payroll tokens at height ${currentBlockHeight}...`);

    try {
      // Import verifyUtxoStatus from utxo-manager
      const { verifyUtxoStatus } = await import('./utxo-manager');
      
      // 1. Query workers who are 'active' and whose 'expiresAt' (block height) is <= current height
      // Join with 'plans' and 'companies' to get the necessary vault context
      const query = `
        SELECT w.*, p.appId, p.employerAddress, c.vaultAddress, c.treasuryHexDest, c.treasuryAddress
        FROM workers w
        JOIN plans p ON w.planId = p.appId
        JOIN companies c ON p.employerAddress = c.employerAddress
        WHERE w.status = 'active' 
        AND w.currentTokenUtxo IS NOT NULL
        AND CAST(w.expiresAt AS INTEGER) <= ?
      `;
      
      const result = await this.db.execute({ sql: query, args: [currentBlockHeight] });
      const matureWorkers = result.rows || [];

      if (matureWorkers.length === 0) return;

      console.log(`[INDEXER] 🎯 Found ${matureWorkers.length} workers eligible for automated payout.`);

      let releasedCount = 0;
      let skippedCount = 0;

      for (const worker of matureWorkers) {
        // =========================================================================
        // SECONDARY CHECK: Ensure the token hasn't been spent or reorged
        // This prevents duplicate releases for tokens already processed
        // =========================================================================
        console.log(`[INDEXER]   Verifying token status for worker ${worker.walletAddress.substring(0, 16)}...`);
        
        const tokenStatus = await verifyUtxoStatus(worker.currentTokenUtxo);
        
        if (!tokenStatus.confirmed) {
          console.warn(`[INDEXER]   ⚠️ Skipping release: Token ${worker.currentTokenUtxo} is not confirmed (still in mempool).`);
          skippedCount++;
          continue;
        }
        
        if (tokenStatus.spent) {
          console.warn(`[INDEXER]   ⚠️ Skipping release: Token ${worker.currentTokenUtxo} has already been spent.`);
          skippedCount++;
          continue;
        }
        
        console.log(`[INDEXER]   ✅ Token verified: confirmed=${tokenStatus.confirmed}, spent=${tokenStatus.spent}`);
        
        // Trigger the release
        await this.triggerScrollRelease(worker);
        releasedCount++;
      }
      
      console.log(`[INDEXER] 📊 Release summary: ${releasedCount} released, ${skippedCount} skipped (unconfirmed or spent)`);
      
    } catch (error: any) {
      console.error(`[INDEXER] ❌ Automated release check failed: ${error.message}`);
    }
  }

  // =========================================================================
  // TRIGGER SETTLEMENT: Builds the release tx and requests the Scroll signature.
  // =========================================================================
  private async triggerScrollRelease(worker: any): Promise<void> {
    try {
      console.log(`[INDEXER] 💸 Triggering release for worker: ${worker.walletAddress}`);
      console.log(`[INDEXER]   Salary: ${worker.salarySats} sats, Expires at block: ${worker.expiresAt}`);

      // 1. Build the transaction hex (carrying the spell and proof)
      const txToSign = await this.buildReleaseTxHex(worker);
      
      // 2. Fetch the parent hex of the worker token for Scroll verification
      const tokenTxid = worker.currentTokenUtxo.split(':')[0];
      const tokenHex = await this.fetchRawTransactionHex(tokenTxid);

      // 3. Request Scroll Signature (The Automated Release)
      const nonce = scrolls.deriveCompanyNonce(worker.employerAddress);
      console.log(`[INDEXER]   Requesting Scroll signature with nonce: ${nonce}`);
      
      const signedTx = await scrolls.requestScrollSignature(
        txToSign,
        [{ index: 0, nonce }], // Sign the token input spending from the vault
        [tokenHex]
      );

      // 4. Broadcast the fully signed transaction
      const txid = await this.rpcCall('sendrawtransaction', [signedTx]);
      console.log(`[INDEXER] ✅ Automated Payout Successful! TxID: ${txid}`);

      // 5. Update Audit Trail
      await this.createAuditLog(
        crypto.randomUUID(),
        'SCROLL_RELEASE',
        `Automated payout of ${worker.salarySats} sats for worker ${worker.walletAddress.substring(0, 16)}...`,
        txid,
        'confirmed'
      );
      
      console.log(`[INDEXER]   ✅ Audit log created for automated release`);

    } catch (error: any) {
      console.error(`[INDEXER] ❌ Automated release failed for ${worker.walletAddress}: ${error.message}`);
    }
  }

  // =========================================================================
  // PRODUCTION RELEASE BUILDER (Updated for Accounting Split):
  // - principal: Pulled from the deterministic Company Vault.
  // - fees/gas: Pulled from the Corporate Treasury (HR Manager's wallet).
  // - platform fee: 1% commission sent to CharmBills Treasury
  // =========================================================================
  private async buildReleaseTxHex(worker: any): Promise<string> {
    const salarySats = worker.salarySats;
    const employerAddress = worker.employerAddress;

    console.log(`[INDEXER] 🏗️ Building release transaction for worker: ${worker.walletAddress.substring(0, 16)}...`);
    console.log(`[INDEXER]   Salary amount: ${salarySats} sats`);

    // =========================================================================
    // PLATFORM FEE CALCULATION: 1% of worker's salary sent to CharmBills Treasury
    // =========================================================================
    const platformFeeSats = Math.floor(salarySats * (PLATFORM_FEE_BASIS_POINTS / 10000));
    const platformFeeAddress = process.env.PLATFORM_FEE_ADDRESS || PLATFORM_FEE_ADDRESS;
    
    console.log(`[INDEXER]   Platform fee: ${platformFeeSats} sats (${PLATFORM_FEE_BASIS_POINTS / 100}%) -> ${platformFeeAddress.substring(0, 20)}...`);

    // 1. FETCH INFRASTRUCTURE CONTEXT
    // Get the Company Record to find the Treasury (Fee Source)
    const companyResult = await this.db.execute({
      sql: 'SELECT treasuryAddress, treasuryHexDest FROM companies WHERE employerAddress = ?',
      args: [employerAddress]
    });
    const company = companyResult.rows[0];
    
    if (!company) {
      throw new Error(`Company not found for employer: ${employerAddress}`);
    }
    
    console.log(`[INDEXER]   Treasury address: ${company.treasuryAddress.substring(0, 20)}...`);
    console.log(`[INDEXER]   Treasury hex dest: ${company.treasuryHexDest.substring(0, 30)}...`);

    // Get the deterministic Vault (Salary Source)
    const vaultAddress = await scrolls.getCompanyVaultAddress(employerAddress);
    console.log(`[INDEXER]   Company Vault address: ${vaultAddress.substring(0, 20)}...`);

    // 2. SELECT UTXOs (Accounting Split)
    // Estimated fees for Scroll + Bitcoin network
    const estimatedFees = SCROLL_FIXED_COST + 2000;
    console.log(`[INDEXER]   Estimated fees: ${estimatedFees} sats`);

    // Select Fee UTXO from Treasury (for gas + scroll fee)
    const feeSponsorship = await getDynamicFundingUtxo(
      this.db, 
      company.treasuryAddress, 
      estimatedFees, 
      employerAddress
    );
    console.log(`[INDEXER]   Fee UTXO from Treasury: ${feeSponsorship.utxoId}, value: ${feeSponsorship.value} sats`);

    // Select Salary UTXO from Vault (Must cover worker's net salary)
    const salaryLiquidity = await getDynamicFundingUtxo(
      this.db, 
      vaultAddress, 
      salarySats, 
      employerAddress
    );
    console.log(`[INDEXER]   Salary UTXO from Vault: ${salaryLiquidity.utxoId}, value: ${salaryLiquidity.value} sats`);

    // 3. PREPARE SPELL REQUEST
    // We spend BOTH the vault UTXO (for salary) and the treasury UTXO (for fees)
    const releaseRequest: any = {
      type: 'scroll-release',
      authorityUtxo: worker.currentTokenUtxo,        // Input 0: The Token
      fundingUtxo: feeSponsorship.utxoId,            // Input 1: TREASURY (Pays the Fees)
      fundingUtxoValue: feeSponsorship.value,
      salaryUtxo: salaryLiquidity.utxoId,            // Input 2: VAULT (Pays the Worker)
      salaryUtxoValue: salaryLiquidity.value,
      changeAddress: company.treasuryAddress,        // Fee change returns to Treasury
      vaultChangeAddress: vaultAddress,              // Salary change stays in Vault
      feeRate: 2,
      outputs: [
        { address: worker.walletAddress, sats: salarySats },                           // 100% Salary to Worker
        { address: platformFeeAddress, sats: platformFeeSats },                        // 1% Platform Commission to CharmBills Treasury
        { address: SCROLL_FEE_ADDRESS_TESTNET4, sats: SCROLL_FIXED_COST }             // Scroll Service Fee
      ],
      planMetadata: {
        appId: worker.appId,
        anchorUtxo: worker.anchorUtxo                 // Required for ZK-witness derivation
      }
    };

    console.log(`[INDEXER]   Spell request prepared with ${releaseRequest.outputs.length} outputs`);

    // 4. FETCH PREVIOUS TRANSACTIONS (Required for Scroll/Prover)
    const tokenTxid = worker.currentTokenUtxo.split(':')[0];
    const tokenTxHex = await this.fetchRawTransactionHex(tokenTxid);
    
    // 5. CALL PROVER
    console.log(`[INDEXER]   Calling prover to generate unsigned transaction...`);
    
    const proverResult = await generateUnsignedTransactions(
      releaseRequest,
      [tokenTxHex, feeSponsorship.hex, salaryLiquidity.hex],
      company.treasuryHexDest,
      worker.appId
    );

    console.log(`[INDEXER]   ✅ Release transaction built successfully`);
    return proverResult.spellTxHex;
  }

  // RPC helpers
  private async rpcCall(method: string, params: any[]): Promise<any> {
    const start = Date.now();
    try {
      const response = await axios.post(
        this.rpcUrl,
        {
          jsonrpc: '1.0',
          id: 'charmbills-indexer-' + Date.now(),
          method,
          params
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: this.rpcAuth
          },
          timeout: 30000
        }
      );
      
      if (response.data.error) {
        throw new Error(`RPC error: ${response.data.error.message}`);
      }
      
      const elapsed = Date.now() - start;
      if (elapsed > 1000) {
        console.log(`[INDEXER]   ⚠️ Slow RPC call: ${method} took ${elapsed}ms`);
      }
      
      return response.data.result;
    } catch (error) {
      const elapsed = Date.now() - start;
      console.error(`[INDEXER] RPC call failed: ${method} after ${elapsed}ms`, error);
      if (axios.isAxiosError(error)) {
        throw new Error(`RPC connection failed: ${error.message}`);
      }
      throw error;
    }
  }

  private async findCIDByHash(metadataHash: string): Promise<string | null> {
    try {
      const result = await this.dbGet(
        'SELECT cid FROM ipfs_mappings WHERE metadataHash = ?',
        [metadataHash]
      );
      const row = result as { cid: string } | undefined;
      return row?.cid || null;
    } catch (error) {
      console.error(`[INDEXER] Failed to find CID for hash ${metadataHash.substring(0, 16)}...:`, error);
      return null;
    }
  }
}

// =========================================================================
// LAZY INDEXER PATTERN FOR SERVERLESS (Vercel) DEPLOYMENT
// FIX: Non-blocking sync with sync lock to prevent redundant concurrent scans
// =========================================================================

export async function syncIndexer(db: any, maxBlocksToScan: number = 50): Promise<void> {
  // SYNC LOCK: If a sync is already in progress, skip this call
  if (isSyncing) {
    console.log('[LAZY INDEXER] ⏭️ Sync already in progress, skipping duplicate request');
    return;
  }
  
  isSyncing = true;
  console.log('[LAZY INDEXER] 🚀 Starting partial sync...');
  const syncStart = Date.now();
  
  const indexer = new DerivableIndexer(db);
  
  try {
    await indexer.initWasm();
    
    const latestBlock = await indexer.getLatestBlockHeight();
    
    let startBlock = Number(process.env.INDEXER_START_BLOCK) || 129000;
    try {
      await db.execute({
        sql: `CREATE TABLE IF NOT EXISTS indexer_config (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        )`,
        args: []
      });
      
      const result = await db.execute({
        sql: 'SELECT value FROM indexer_config WHERE key = ?',
        args: ['lastIndexedBlock']
      });
      const row = result.rows[0];
      if (row && row.value) {
        startBlock = parseInt(row.value, 10);
        console.log(`[LAZY INDEXER] 📍 Resumed from saved block: ${startBlock}`);
      } else {
        console.log(`[LAZY INDEXER] 📍 No saved progress, starting from: ${startBlock}`);
      }
    } catch (err) {
      console.error('[LAZY INDEXER] Failed to get last processed block:', err);
    }
    
    console.log(`[LAZY INDEXER] 📊 Status: last processed=${startBlock}, latest=${latestBlock}, gap=${latestBlock - startBlock} blocks`);
    
    if (latestBlock > startBlock) {
      const blocksToScan = Math.min(latestBlock - startBlock, maxBlocksToScan);
      const endBlock = startBlock + blocksToScan;
      
      console.log(`[LAZY INDEXER] 🔄 Syncing ${blocksToScan} blocks (${startBlock + 1} → ${endBlock})`);
      
      await indexer.indexBlocks(startBlock + 1, endBlock);
      
      const syncElapsed = Date.now() - syncStart;
      console.log(`[LAZY INDEXER] ✅ Sync complete! Processed up to block ${endBlock} in ${syncElapsed}ms`);
    } else {
      console.log(`[LAZY INDEXER] ✅ No new blocks to sync (up to date)`);
    }
  } catch (error) {
    console.error('[LAZY INDEXER] ❌ Sync failed:', error);
  } finally {
    isSyncing = false;
    console.log('[LAZY INDEXER] 🔓 Sync lock released');
  }
}

export function createIndexer(db: any, config?: IndexerConfig): DerivableIndexer {
  return new DerivableIndexer(db, config);
}

export async function startIndexer(db: any, startBlock?: number): Promise<DerivableIndexer> {
  const indexer = createIndexer(db, { startBlock });
  
  process.on('SIGINT', async () => {
    console.log('\n[INDEXER] 🛑 Received SIGINT, shutting down...');
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n[INDEXER] 🛑 Received SIGTERM, shutting down...');
    process.exit(0);
  });
  
  await indexer.start();
  
  return indexer;
}