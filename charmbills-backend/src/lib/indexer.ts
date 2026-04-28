import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { decryptPayrollData, EncryptedData } from '@shared/encryption';
import { getFromIPFS } from './ipfs-pinner';
import { PlanCache, WorkerCache } from '../db/schema';
import { 
  PAYROLL_NFT_TICKER,
  DEFAULT_RPC_HOST,
  DEFAULT_RPC_PORT,
  INDEXER_BATCH_SIZE,
  INDEXER_SCAN_INTERVAL_MS
} from '@shared/constants';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';

// =========================================================================
// CRITICAL FIX: Use the DEDICATED SCANNER BRIDGE for extractAndVerifySpell
// This preserves the prover bridge (charms_lib.js) for templating while
// using the scanner bridge (charms_protocol_scanner.js) for blockchain indexing
// =========================================================================
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
        // Build spellInput with original transaction hex
        // prev_txs as array with exactly 1 parent (authority only)
        // =========================================================================
        if (authorityParentHex) {
          const prevTxObjects = [{ bitcoin: authorityParentHex }];
          
          const spellInput: any = { 
            bitcoin: rawTxHex,
            prev_txs: prevTxObjects 
          };
          
          console.log(`[INDEXER]   📝 Built spellInput with 1 prev_txs`);
          
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
              
              // Process payroll spell
              let isPayrollSpell = false;
              
              if (spell.outputs?.some((output: any) => 
                output.nftMetadata?.ticker && output.nftMetadata.ticker.endsWith('-PAY')
              )) {
                isPayrollSpell = true;
              }
              
              if (!isPayrollSpell && spell.tx && spell.tx.outs) {
                for (const out of spell.tx.outs) {
                  if (out && out.ticker && typeof out.ticker === 'string') {
                    if (out.ticker.endsWith('-PAY')) {
                      isPayrollSpell = true;
                      break;
                    }
                  }
                }
              }
              
              if (!isPayrollSpell && spell.tx && spell.tx.outs) {
                for (const out of spell.tx.outs) {
                  if (out && out.ticker === 'CHARMS-PAY') {
                    isPayrollSpell = true;
                    break;
                  }
                }
              }
              
              if (isPayrollSpell) {
                this.stats.totalPayrollSpells++;
                blockPayrollSpells++;
                console.log(`[INDEXER]   💰 PAYROLL SPELL DETECTED! Processing...`);
                await this.processPayrollSpell(spell, block.height, tx.txid);
              } else {
                console.log(`[INDEXER]   ℹ️ Spell found but not a payroll spell`);
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
  // =========================================================================
  private async processPayrollSpell(spell: any, blockHeight: number, txid: string): Promise<void> {
    console.log(`[INDEXER] 🔍 Processing payroll spell at block ${blockHeight}, txid: ${txid}`);
    
    const appId = spell.appId;
    if (!appId) {
      console.log('[INDEXER]   ⚠️ No appId found in spell');
      return;
    }
    
    let nftMetadata = null;
    let nftUtxoId = null;
    
    if (spell.tx && spell.tx.outs) {
      for (let i = 0; i < spell.tx.outs.length; i++) {
        const out = spell.tx.outs[i];
        if (out && typeof out === 'object') {
          if (out.ticker && typeof out.ticker === 'string' && out.ticker.endsWith('-PAY')) {
            nftMetadata = out;
            nftUtxoId = `${txid}:${i}`;
            console.log(`[INDEXER]   📝 Found NFT metadata at output ${i} | ticker: ${out.ticker} | remaining: ${out.remaining}`);
            break;
          }
          if (out.metadataHash && out.remaining !== undefined) {
            nftMetadata = out;
            nftUtxoId = `${txid}:${i}`;
            console.log(`[INDEXER]   📝 Found NFT metadata at output ${i} (by metadataHash)`);
            break;
          }
        }
      }
    }
    
    if (!nftMetadata && spell.outputs) {
      for (let i = 0; i < spell.outputs.length; i++) {
        const out = spell.outputs[i];
        if (out && out.nftMetadata && out.nftMetadata.ticker && out.nftMetadata.ticker.endsWith('-PAY')) {
          nftMetadata = out.nftMetadata;
          nftUtxoId = out.utxoId || `${txid}:${i}`;
          console.log(`[INDEXER]   📝 Found NFT metadata in spell.outputs at index ${i}`);
          break;
        }
      }
    }
    
    if (!nftMetadata) {
      console.log('[INDEXER]   ⚠️ No NFT metadata found in spell');
      return;
    }
    
    const ticker = nftMetadata.ticker;
    const remaining = nftMetadata.remaining;
    const metadataHash = nftMetadata.metadataHash;
    const scrollPolicy = nftMetadata.scrollPolicy;
    const payPeriodSeconds = nftMetadata.payPeriodSeconds;
    const compensationSats = nftMetadata.compensationSats;
    
    if (!ticker || !ticker.endsWith('-PAY')) {
      console.log(`[INDEXER]   ⚠️ Ticker ${ticker} is not a payroll ticker`);
      return;
    }
    
    console.log(`[INDEXER]   ✅ Plan NFT: ${ticker} | appId=${appId.substring(0, 16)}... | remaining=${remaining} | period=${payPeriodSeconds}s | compensation=${compensationSats}sats`);
    console.log(`[INDEXER]   📍 UTXO: ${nftUtxoId}`);
    
    await this.dbRun(`
      INSERT OR REPLACE INTO plans (
        appId, nftUtxoId, ticker, compensationSats, 
        payPeriodSeconds, metadataHash, scrollPolicy,
        remaining, lastIndexedBlock, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      appId,
      nftUtxoId,
      ticker,
      compensationSats || 0,
      payPeriodSeconds || 0,
      metadataHash || '',
      scrollPolicy || 0,
      remaining || 0,
      blockHeight,
      new Date().toISOString(),
      new Date().toISOString()
    ]);
    
    await this.createAuditLog(
      crypto.randomUUID(),
      'PLAN_CREATED',
      `Plan NFT created: ${ticker}`,
      txid,
      'confirmed'
    );
    console.log(`[INDEXER]   ✅ Audit log created for Plan NFT: ${ticker}`);
    
    if (metadataHash) {
      this.enrichPlanWithMetadata(appId, metadataHash).catch(console.error);
    }
  }

  private async enrichPlanWithMetadata(appId: string, metadataHash: string): Promise<void> {
    try {
      const cid = await this.findCIDByHash(metadataHash);
      if (!cid) {
        console.log(`[INDEXER]   No CID mapping found for hash ${metadataHash.substring(0, 16)}...`);
        return;
      }
      
      console.log(`[INDEXER]   📦 Fetching encrypted metadata from IPFS: ${cid}`);
      
      const rawBlob = await getFromIPFS(cid);
      const encryptedBlob = rawBlob as unknown as EncryptedData;
      const encryptionKey = process.env.PAYROLL_ENCRYPTION_ENTROPY;
      
      if (!encryptionKey) {
        console.error(`[INDEXER]   ❌ Cannot decrypt plan ${appId}: PAYROLL_ENCRYPTION_ENTROPY not set`);
        return;
      }
      
      const decryptedData = await decryptPayrollData(encryptedBlob, encryptionKey);
      const role = decryptedData.role || 'Unknown Role';
      const employeeName = decryptedData.employeeName || 'Unnamed Worker';
      const employeeWallet = decryptedData.employeeWallet;
      
      console.log(`[INDEXER]   🔓 Decrypted plan ${appId.substring(0, 16)}... | role: ${role} | name: ${employeeName}`);
      
      await this.dbRun(`
        UPDATE plans 
        SET role = ?, 
            updatedAt = ?
        WHERE appId = ?
      `, [role, new Date().toISOString(), appId]);
      
      if (employeeWallet) {
        await this.dbRun(`
          INSERT OR REPLACE INTO workers (
            walletAddress, name, planId, engagementType, status,
            lastMintedPeriod, currentTokenUtxo, expiresAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          employeeWallet,
          employeeName,
          appId,
          decryptedData.engagementType || 0,
          'active',
          decryptedData.period || new Date().toISOString().split('T')[0],
          null,
          decryptedData.expiresAt || null
        ]);
        
        console.log(`[INDEXER]   ✅ Updated worker cache for ${employeeWallet.substring(0, 20)}... | name: ${employeeName}`);
      }
      
    } catch (error) {
      console.error(`[INDEXER]   ❌ Decryption failed for plan ${appId}:`, error);
    }
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
  // Helper to create audit log entries
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