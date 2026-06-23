import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import { decryptPayrollData, EncryptedData } from '@shared/encryption';
import { getFromIPFS } from './ipfs-pinner';
import { PlanCache, WorkerCache, CompanyRecord } from '../db/schema';
import { ProverResult } from '@shared/types';
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
import { getDynamicFundingUtxo, fetchTransactionHex, verifyUtxoStatus, lockUtxo, unlockUtxo, getCurrentFeeRate, estimateTransactionVSize, calculateNetworkFee } from './utxo-manager';
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

// =========================================================================
// Structured Payment History Interface
// =========================================================================

export interface StructuredPaymentRecord {
  utxoId: string;
  timestamp: number;
  blockHeight: number;
  amountSats: number;
  salarySats: number;
  periodsPaid: number;
  paymentType: 'regular' | 'backpay' | 'bonus' | 'adjustment';
  txid: string;
  spentAt: string;
  departmentId: string;
  departmentName: string;
  workerRole: string;
  status: 'pending' | 'confirmed' | 'spent';
}

/**
 * Adds a structured payment record to worker's historicalTokens
 */
async function addStructuredPaymentRecord(
  db: any,
  walletAddress: string,
  planId: string,
  paymentRecord: StructuredPaymentRecord
): Promise<void> {
  console.log(`[INDEXER] Adding structured payment record for worker ${walletAddress.substring(0, 16)}...`);
  console.log(`[INDEXER] Payment: ${paymentRecord.amountSats} sats, period: ${paymentRecord.periodsPaid}, tx: ${paymentRecord.txid.substring(0, 16)}...`);
  
  const result = await db.execute({
    sql: 'SELECT historicalTokens FROM workers WHERE walletAddress = ? AND planId = ?',
    args: [walletAddress, planId]
  });
  
  let history: StructuredPaymentRecord[] = [];
  const row = result.rows[0];
  if (row && row.historicalTokens) {
    try {
      history = JSON.parse(row.historicalTokens);
    } catch (e) {
      console.warn(`[INDEXER] Failed to parse historicalTokens, starting fresh array`);
      history = [];
    }
  }
  
  history.push(paymentRecord);
  
  await db.execute({
    sql: 'UPDATE workers SET historicalTokens = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
    args: [JSON.stringify(history), new Date().toISOString(), walletAddress, planId]
  });
  
  console.log(`[INDEXER] ✅ Structured payment record added. History now has ${history.length} entries`);
}

/**
 * Updates an existing payment record status
 */
async function updatePaymentRecordStatus(
  db: any,
  walletAddress: string,
  planId: string,
  txid: string,
  status: 'confirmed' | 'spent'
): Promise<void> {
  console.log(`[INDEXER] Updating payment record status for worker ${walletAddress.substring(0, 16)}..., tx: ${txid.substring(0, 16)}..., status: ${status}`);
  
  const result = await db.execute({
    sql: 'SELECT historicalTokens FROM workers WHERE walletAddress = ? AND planId = ?',
    args: [walletAddress, planId]
  });
  
  const row = result.rows[0];
  if (!row || !row.historicalTokens) {
    console.warn(`[INDEXER] No historicalTokens found for worker ${walletAddress.substring(0, 16)}...`);
    return;
  }
  
  let history: StructuredPaymentRecord[] = [];
  try {
    history = JSON.parse(row.historicalTokens);
  } catch (e) {
    console.error(`[INDEXER] Failed to parse historicalTokens`);
    return;
  }
  
  let updated = false;
  for (let i = 0; i < history.length; i++) {
    if (history[i].txid === txid) {
      history[i].status = status;
      updated = true;
      console.log(`[INDEXER] Updated payment record status for tx: ${txid.substring(0, 16)}...`);
      break;
    }
  }
  
  if (updated) {
    await db.execute({
      sql: 'UPDATE workers SET historicalTokens = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
      args: [JSON.stringify(history), new Date().toISOString(), walletAddress, planId]
    });
    console.log(`[INDEXER] ✅ Payment record status updated`);
  }
}

/**
 * Gets department name for a planId
 */
async function getDepartmentName(db: any, planId: string): Promise<string> {
  const result = await db.execute({
    sql: 'SELECT department, ticker FROM plans WHERE appId = ?',
    args: [planId]
  });
  
  const row = result.rows[0];
  if (!row) {
    return 'Unknown Department';
  }
  
  if (row.department) {
    return row.department;
  }
  
  if (row.ticker) {
    return row.ticker.replace('-PAY', '');
  }
  
  return 'Unknown Department';
}

/**
 * Gets worker role for a wallet address and planId
 */
async function getWorkerRole(db: any, walletAddress: string, planId: string): Promise<string> {
  const result = await db.execute({
    sql: 'SELECT role FROM workers WHERE walletAddress = ? AND planId = ?',
    args: [walletAddress, planId]
  });
  
  const row = result.rows[0];
  return row?.role || 'Team Member';
}

// =========================================================================
// Batch Scroll Release Interface
// =========================================================================

interface MatureWorker {
  walletAddress: string;
  planId: string;
  salarySats: number;
  role: string;
  currentTokenUtxo: string;
  employerAddress: string;
  appId: string;
  vaultAddress: string;
  treasuryHexDest: string;
  treasuryAddress: string;
  anchorUtxo: string;
  ticker: string;
  remaining: number;
  metadataHash: string;
  scrollPolicy: number;
  payPeriodSeconds: number;
  compensationSats: number;
}

// =========================================================================
// MARK: DerivableIndexer Class
// =========================================================================

export class DerivableIndexer {
  private db: any;
  private config: IndexerConfig;
  private currentBlock: number;
  private rpcUrl: string;
  private rpcAuth: string;
  private wasmInitialized: boolean = false;
  
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

  private async updateWorkerPostMint(
    walletAddress: string,
    planId: string,
    tokenUtxo: string,
    expiresAtBlock: number,
    lastMintedPeriod: string
  ): Promise<void> {
    try {
      const expiresAtStr = expiresAtBlock.toString();
      
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
          expiresAtStr,
          lastMintedPeriod,
          new Date().toISOString(),
          walletAddress,
          planId
        ]
      );
      console.log(`[INDEXER]   ✅ Worker ${walletAddress.substring(0, 16)}... updated to 'active' with token UTXO: ${tokenUtxo.substring(0, 20)}...`);
      console.log(`[INDEXER]   📅 Token expires at block height: ${expiresAtBlock}`);
    } catch (error) {
      console.error(`[INDEXER]   ❌ Failed to update worker post-mint:`, error);
    }
  }

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

  public async initWasm(): Promise<void> {
    if (!this.wasmInitialized) {
      console.log('[INDEXER] 🚀 Initializing Charms Scanner WASM...');
      
      if (typeof charms.extractAndVerifySpell !== 'function') {
        throw new Error("Scanner bridge missing 'extractAndVerifySpell'. Ensure charms_protocol_scanner.js was generated with --target nodejs");
      }
      
      this.wasmInitialized = true;
      console.log('[INDEXER] ✅ Charms Scanner Library Verified & Ready.');
    }
  }

  public async getLatestBlockHeight(): Promise<number> {
    const start = Date.now();
    const height = await this.rpcCall('getblockcount', []);
    console.log(`[INDEXER] 📊 Latest block height: ${height} (fetched in ${Date.now() - start}ms)`);
    return height;
  }

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
    
    const latestHeight = await this.getLatestBlockHeight();
    console.log(`[INDEXER] 🔔 About to call processAutomatedReleases at height ${latestHeight}`);
    await this.processAutomatedReleases(latestHeight);
  }

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

  private async fetchRawTransactionHex(txid: string): Promise<string> {
    try {
      return await this.rpcCall('getrawtransaction', [txid]);
    } catch (error) {
      console.error(`[INDEXER] Failed to fetch raw transaction ${txid.substring(0, 16)}...:`, error);
      throw error;
    }
  }

  private isCharmsPayTransaction(txHex: string): boolean {
    const hex = txHex.toLowerCase();
    
    const APP_VK = process.env.HARDCODED_APP_VK || "8e53ade8824e05fc31361802c86669b4bc62d5c1a190e5845bedf0f2be69610c";
    if (hex.includes(APP_VK.toLowerCase())) {
      console.log(`[INDEXER]   ✓ Matched App VK pattern`);
      return true;
    }

    if (hex.includes("2d504159")) {
      console.log(`[INDEXER]   ✓ Matched department ticker pattern (-PAY)`);
      return true;
    }

    if (hex.includes("6a057370656c6c")) {
      console.log(`[INDEXER]   ✓ Matched OP_RETURN spell marker`);
      return true;
    }

    return false;
  }

  private async isSpendingKnownAsset(tx: any): Promise<boolean> {
    if (!tx.vin || !Array.isArray(tx.vin)) return false;
    
    for (const input of tx.vin) {
      if (!input.txid || input.vout === undefined) continue;
      
      const inputUtxoId = `${input.txid}:${input.vout}`;
      
      const knownPlan = await this.dbGet('SELECT appId FROM plans WHERE nftUtxoId = ?', [inputUtxoId]);
      if (knownPlan) {
        console.log(`[INDEXER]   📌 Input ${inputUtxoId} is a known Plan NFT`);
        return true;
      }
      
      const knownWorker = await this.dbGet('SELECT walletAddress FROM workers WHERE currentTokenUtxo = ?', [inputUtxoId]);
      if (knownWorker) {
        console.log(`[INDEXER]   📌 Input ${inputUtxoId} is a known Worker Token`);
        return true;
      }
    }
    
    return false;
  }

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
        
        const hasCharmsPattern = this.isCharmsPayTransaction(rawTxHex);
        const spendsKnownAsset = await this.isSpendingKnownAsset(tx);

        console.log(`[INDEXER] 📊 Tx ${tx.txid}: hasCharmsPattern=${hasCharmsPattern}, spendsKnownAsset=${spendsKnownAsset}`);
        
        if (!hasCharmsPattern && !spendsKnownAsset) {
          skippedCount++;
          continue;
        }
        
        console.log(`[INDEXER] 🎯 Relevant CharmsPay Tx Detected: ${tx.txid.substring(0, 16)}...`);
        console.log(`[INDEXER]   hasCharmsPattern: ${hasCharmsPattern}, spendsKnownAsset: ${spendsKnownAsset}`);
        
        let madeRpcCalls = false;
        const prevTxs: string[] = [];
        
        if (tx.vin && Array.isArray(tx.vin)) {
          console.log(`[INDEXER]   🔍 Fetching parent hexes for ${tx.vin.length} input(s)...`);
          
          for (let i = 0; i < tx.vin.length; i++) {
            const input = tx.vin[i];
            if (input && input.txid) {
              try {
                const parentHex = await this.fetchRawTransactionHex(input.txid);
                prevTxs.push(parentHex);
                console.log(`[INDEXER]     ✓ Fetched parent for input ${i}: ${input.txid.substring(0, 16)}... (${parentHex.length} bytes)`);
                madeRpcCalls = true;
              } catch (err: any) {
                console.warn(`[INDEXER]     ✗ Failed to fetch parent for input ${i}: ${input.txid.substring(0, 16)}... - ${err.message}`);
                prevTxs.push('');
              }
            } else {
              console.warn(`[INDEXER]     ⚠️ Input ${i} missing txid, skipping`);
              prevTxs.push('');
            }
          }
        }
        
        let spellInput: any = null;
        const inputCount = tx.vin?.length || 0;
        
        spellInput = { 
          bitcoin: rawTxHex
        };
        console.log(`[INDEXER]   📦 Passing raw bitcoin hex only (${rawTxHex.length} bytes). Input count: ${inputCount}, spendsKnownAsset: ${spendsKnownAsset}`);
        console.log(`[INDEXER]   [DEBUG] No prev_txs passed.`);
        
        if (spellInput) {
          console.log("[INDEXER]   [DEBUG] Exact object keys being passed to WASM:", Object.keys(spellInput));
          
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
              
              const isPayroll = await this.processPayrollSpell(spell, block.height, tx.txid);
              if (isPayroll) {
                blockPayrollSpells++;
                this.stats.totalPayrollSpells++;
              }
              
              if (spell.type === 'mint-nft') {
                const appId = spell.appId || spell.app_id;
                console.log(`[INDEXER] 🛡️ STAGE 1: Validated Plan NFT on-chain: ${appId?.substring(0, 16)}...`);
                
                if (appId) {
                  await this.updatePlanStatus(appId, 'active');
                  await this.updateAuditLogStatus(tx.txid, 'confirmed');
                  console.log(`[INDEXER]   ✅ Plan NFT activated, audit log confirmed`);
                }
              }
              
              if (spell.type === 'mint-token') {
                console.log(`[INDEXER] 💸 STAGE 2: Validated Worker Tokens on-chain in tx: ${tx.txid}`);
                
                const appId = spell.appId || spell.app_id;
                let outputIndex = 0;
                
                let payPeriodSeconds = 14400;
                try {
                  const planResult = await this.dbGet('SELECT payPeriodSeconds FROM plans WHERE appId = ?', [appId]);
                  if (planResult && planResult.payPeriodSeconds) {
                    payPeriodSeconds = planResult.payPeriodSeconds;
                  }
                } catch (err) {
                  console.warn(`[INDEXER]   ⚠️ Could not fetch payPeriodSeconds from plan, using default 14400`);
                }
                
                const blocksPerPeriod = Math.floor(payPeriodSeconds / 600);
                const expiresAtBlock = block.height + blocksPerPeriod;
                console.log(`[INDEXER]   📅 Token expiry block height: ${expiresAtBlock} (current ${block.height} + ${blocksPerPeriod} blocks)`);
                
                let outputs = spell.outputs;
                if (!outputs || !Array.isArray(outputs)) {
                  outputs = spell.tx?.outs;
                }
                
                if (outputs && Array.isArray(outputs)) {
                  for (let idx = 0; idx < outputs.length; idx++) {
                    const output = outputs[idx];
                    
                    const isTokenOutput = (output.tag === 't') || 
                                          (output.tokenAmount !== undefined) ||
                                          (output.address && output.address.startsWith('tb1'));
                    
                    if (isTokenOutput) {
                      let walletAddress = output.address;
                      if (!walletAddress && output.dest) {
                        walletAddress = output.dest;
                      }
                      
                      if (walletAddress) {
                        const tokenUtxo = `${tx.txid}:${idx}`;
                        const lastMintedPeriod = new Date().toISOString();
                        
                        console.log(`[INDEXER]   📝 Updating worker ${walletAddress.substring(0, 16)}... with token UTXO: ${tokenUtxo}`);
                        console.log(`[INDEXER]   📅 Token expires at block: ${expiresAtBlock}`);
                        
                        await this.updateWorkerPostMint(
                          walletAddress,
                          appId,
                          tokenUtxo,
                          expiresAtBlock,
                          lastMintedPeriod
                        );
                        outputIndex++;
                      }
                    }
                  }
                }
                
                console.log(`[INDEXER]   ✅ Updated ${outputIndex} workers with token UTXOs`);
                
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
        }
        
        await this.processStandardTransfers(tx, block.height);
        await this.reconcileSettlements(tx, block.height);
        
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

  private async processPayrollSpell(spell: any, blockHeight: number, txid: string): Promise<boolean> {
    console.log(`[INDEXER] 🔍 Processing payroll spell at block ${blockHeight}, txid: ${txid}`);
    
    console.log("[INDEXER] 🔍 ========== SPELL DIAGNOSTIC START ==========");
    console.log("[INDEXER] 🔍 spell type:", typeof spell);
    console.log("[INDEXER] 🔍 spell constructor:", spell?.constructor?.name);
    console.log("[INDEXER] 🔍 spell keys:", Object.keys(spell));
    
    console.log("[INDEXER] 🔍 spell.appId:", spell.appId);
    console.log("[INDEXER] 🔍 spell.app_id:", spell.app_id);
    console.log("[INDEXER] 🔍 spell.id:", spell.id);
    
    if (spell.data) {
      console.log("[INDEXER] 🔍 spell.data type:", typeof spell.data);
      console.log("[INDEXER] 🔍 spell.data keys:", Object.keys(spell.data));
    }
    if (spell.metadata) {
      console.log("[INDEXER] 🔍 spell.metadata type:", typeof spell.metadata);
      console.log("[INDEXER] 🔍 spell.metadata keys:", Object.keys(spell.metadata));
    }
    
    if (spell.tx) {
      console.log("[INDEXER] 🔍 spell.tx keys:", Object.keys(spell.tx));
      console.log("[INDEXER] 🔍 spell.tx.ins length:", spell.tx.ins?.length);
      console.log("[INDEXER] 🔍 spell.tx.outs type:", spell.tx.outs?.constructor?.name);
      console.log("[INDEXER] 🔍 spell.tx.outs length:", spell.tx.outs?.length);
      console.log("[INDEXER] 🔍 spell.tx.coins length:", spell.tx.coins?.length);
      
      if (Array.isArray(spell.tx.outs)) {
        for (let i = 0; i < spell.tx.outs.length; i++) {
          const out = spell.tx.outs[i];
          console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] type:`, out?.constructor?.name);
          
          if (out instanceof Map) {
            console.log(`[INDEXER] 🔍 spell.tx.outs[${i}] Map keys:`, Array.from(out.keys()));
            for (const [key, value] of out.entries()) {
              console.log(`[INDEXER] 🔍   Map key "${key}" -> type: ${value?.constructor?.name}`);
              if (value instanceof Map) {
                console.log(`[INDEXER] 🔍     Inner Map keys:`, Array.from(value.keys()));
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
    
    if (spell.app_public_inputs) {
      console.log("[INDEXER] 🔍 spell.app_public_inputs type:", spell.app_public_inputs?.constructor?.name);
      if (spell.app_public_inputs instanceof Map) {
        console.log("[INDEXER] 🔍 spell.app_public_inputs Map keys:", Array.from(spell.app_public_inputs.keys()));
      } else if (typeof spell.app_public_inputs === 'object') {
        console.log("[INDEXER] 🔍 spell.app_public_inputs keys:", Object.keys(spell.app_public_inputs));
      }
    }
    
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
    
    let appId = spell.appId || spell.app_id;
    
    if (!appId && spell.tx?.coins && Array.isArray(spell.tx.coins)) {
      for (const coin of spell.tx.coins) {
        if (coin.appId) appId = coin.appId;
        if (coin.app_id) appId = coin.app_id;
        if (coin.id) appId = coin.id;
      }
    }
    
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
    let hasWorkerTokens = false;
    let activatedWorkerCount = 0;
    
    let anchorUtxo: string | null = null;
    if (spell.tx && spell.tx.ins && Array.isArray(spell.tx.ins) && spell.tx.ins.length > 0) {
      anchorUtxo = spell.tx.ins[0];
      console.log(`[INDEXER]   ⚓ Anchor UTXO extracted: ${anchorUtxo}`);
    } else {
      console.log(`[INDEXER]   ⚠️ No anchor UTXO found in spell.tx.ins`);
    }
    
    let nftDestHex: string | null = null;
    if (spell.tx && spell.tx.coins && Array.isArray(spell.tx.coins) && spell.tx.coins.length > 0) {
      const firstCoin = spell.tx.coins[0];
      if (firstCoin && firstCoin.dest) {
        nftDestHex = firstCoin.dest;
        console.log(`[INDEXER]   📍 NFT destination hex: ${nftDestHex ? nftDestHex.substring(0, 50) : 'null'}...`);
      }
    }
    
    let employerAddress: string | null = null;
    
    console.log(`[INDEXER]   🔍 Resolving employerAddress for appId: ${appId.substring(0, 16)}...`);
    
    const existingPlan = await this.dbGet('SELECT employerAddress FROM plans WHERE appId = ?', [appId]);
    if (existingPlan && existingPlan.employerAddress) {
      employerAddress = existingPlan.employerAddress;
      console.log(`[INDEXER]   ✅ Found employerAddress from existing plan: ${employerAddress ? employerAddress.substring(0, 20) : 'null'}...`);
    }
    
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
    
    if (!employerAddress) {
      console.log(`[INDEXER]   ❌ Could not resolve employerAddress for appId ${appId.substring(0, 16)}...`);
      console.log(`[INDEXER]   💡 This plan will be skipped. Ensure company registration completed before minting.`);
      return false;
    }
    
    if (spell.tx && spell.tx.outs && Array.isArray(spell.tx.outs)) {
      for (let outputIndex = 0; outputIndex < spell.tx.outs.length; outputIndex++) {
        const outputMap = spell.tx.outs[outputIndex];
        
        if (outputMap instanceof Map) {
          console.log(`[INDEXER]   📝 Output ${outputIndex} is a Map with ${outputMap.size} entries`);
          console.log(`[INDEXER]   📝 Map keys at output ${outputIndex}:`, Array.from(outputMap.keys()));
          
          for (const [appIndex, appData] of outputMap.entries()) {
            console.log(`[INDEXER]   🔍 App Index ${appIndex}: appData type = ${typeof appData}, is Map = ${appData instanceof Map}, value = ${appData}`);
            
            if (appData instanceof Map) {
              const ticker = appData.get('ticker');
              const remaining = appData.get('remaining');
              const metadataHash = appData.get('metadataHash');
              const scrollPolicy = appData.get('scrollPolicy');
              const payPeriodSeconds = appData.get('payPeriodSeconds');
              const compensationSats = appData.get('compensationSats');
              
              console.log(`[INDEXER]   📝 App Index ${appIndex}: ticker=${ticker}, remaining=${remaining}, metadataHash=${metadataHash?.substring(0, 16)}...`);
              
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
            } else if (typeof appData === 'number') {
              console.log(`[INDEXER]   💎 Found Worker Token at output ${outputIndex}, app ${appIndex} | Amount: ${appData}`);
              hasWorkerTokens = true;
              
              const coin = spell.tx?.coins?.[outputIndex];
              if (coin && coin.dest) {
                let walletAddress = '';
                if (coin.dest instanceof Uint8Array) {
                  walletAddress = Buffer.from(coin.dest).toString('hex');
                } else if (typeof coin.dest === 'string') {
                  walletAddress = coin.dest;
                }
                
                console.log(`[INDEXER]   👤 Worker dest hex: ${walletAddress.substring(0, 30)}...`);
                
                const pendingWorker = await this.dbGet(
                  `SELECT walletAddress FROM workers 
                   WHERE planId = ? AND status = 'minting_pending' 
                   LIMIT 1`,
                  [appId]
                );
                
                if (pendingWorker && pendingWorker.walletAddress) {
                  const tokenUtxo = `${txid}:${outputIndex}`;
                  const lastMintedPeriod = new Date().toISOString();
                  
                  let payPeriodSeconds = 14400;
                  try {
                    const planResult = await this.dbGet('SELECT payPeriodSeconds FROM plans WHERE appId = ?', [appId]);
                    if (planResult && planResult.payPeriodSeconds) {
                      payPeriodSeconds = planResult.payPeriodSeconds;
                    }
                  } catch (err) {
                    console.warn(`[INDEXER]   ⚠️ Could not fetch payPeriodSeconds, using default 14400`);
                  }
                  
                  const blocksPerPeriod = Math.floor(payPeriodSeconds / 600);
                  const expiresAtBlock = blockHeight + blocksPerPeriod;
                  
                  console.log(`[INDEXER]   📝 Activating worker ${pendingWorker.walletAddress.substring(0, 16)}... with token UTXO: ${tokenUtxo}`);
                  console.log(`[INDEXER]   📅 Token expires at block: ${expiresAtBlock}`);
                  
                  await this.updateWorkerPostMint(
                    pendingWorker.walletAddress,
                    appId,
                    tokenUtxo,
                    expiresAtBlock,
                    lastMintedPeriod
                  );
                  activatedWorkerCount++;
                } else {
                  console.log(`[INDEXER]   ⚠️ No pending worker found for token output at index ${outputIndex}`);
                }
              } else {
                console.warn(`[INDEXER]   ⚠️ No coin dest found for output ${outputIndex}`);
              }
            } else {
              console.log(`[INDEXER]   ⚠️ App metadata at index ${appIndex} is not a Map or Number, type: ${appData?.constructor?.name}`);
            }
          }
          
          if (nftMetadata) break;
        } else {
          console.log(`[INDEXER]   ⚠️ Output ${outputIndex} is not a Map, type: ${outputMap?.constructor?.name}`);
        }
      }
    }
    
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
    
        // Check if plan already exists to preserve anchorUtxo
        const existingPlanRecord = await this.dbGet('SELECT anchorUtxo FROM plans WHERE appId = ?', [appId]);
    
        if (existingPlan) {
          // Update only mutable fields, preserve anchorUtxo
          await this.dbRun(`
            UPDATE plans SET 
              nftUtxoId = ?,
              remaining = ?,
              status = 'active',
              lastIndexedBlock = ?,
              updatedAt = ?
            WHERE appId = ?
          `, [nftUtxoId, remaining, blockHeight, new Date().toISOString(), appId]);
          console.log(`[INDEXER]   ✅ Plan record updated (preserved anchorUtxo: ${existingPlan.anchorUtxo})`);
        } else {
          // First time seeing this plan - INSERT all fields including anchorUtxo
          await this.dbRun(`
            INSERT INTO plans (
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
            'active',
            blockHeight,
            new Date().toISOString(),
            new Date().toISOString()
          ]);
          console.log(`[INDEXER]   ✅ New plan record inserted with anchorUtxo: ${anchorUtxo}`);
        }
    
    console.log(`[INDEXER]   ✅ Plan record saved to database with status 'active'`);
    
    // Create BATCH_MINT audit log if workers were activated
    if (hasWorkerTokens && activatedWorkerCount > 0) {
      const auditId = crypto.randomUUID();
      await this.createAuditLog(
        auditId,
        'BATCH_MINT',
        `Batch mint confirmed at block ${blockHeight} for ${activatedWorkerCount} workers`,
        txid,
        'confirmed'
      );
      console.log(`[INDEXER]   ✅ BATCH_MINT audit log created for ${activatedWorkerCount} workers`);
    }
    
    // Only create PLAN_CREATED audit log if this is NOT a token mint transaction
    if (!hasWorkerTokens) {
      await this.createAuditLog(
        crypto.randomUUID(),
        'PLAN_CREATED',
        `Plan NFT created: ${ticker}`,
        txid,
        'confirmed'
      );
      console.log(`[INDEXER]   ✅ Audit log created for Plan NFT: ${ticker}`);
    } else {
      console.log(`[INDEXER]   ℹ️ Skipping PLAN_CREATED audit log (token mint transaction - plan updated only)`);
    }
    
    if (metadataHash) {
      try {
        console.log(`[INDEXER]   📦 Saving encrypted metadata hash: ${metadataHash.substring(0, 32)}...`);
        
        await this.dbRun(
          'UPDATE plans SET metadataHash = ? WHERE appId = ?',
          [metadataHash, appId]
        );
        
        console.log(`[INDEXER]   ✅ Metadata hash cached for appId: ${appId.substring(0, 8)}...`);
        console.log(`[INDEXER]   ℹ️ Non-Custodial Mode: Decryption will happen in the browser when user logs in.`);
      } catch (error) {
        console.log(`[INDEXER]   ℹ️ Skipping backend decryption (Non-Custodial Mode Active)`);
        console.log(`[INDEXER]   📦 Metadata hash will be decrypted by frontend wallet.`);
      }
    }
    
    return true;
  }

  private async reconcileSettlements(tx: any, blockHeight: number): Promise<void> {
    if (!tx.vin || !Array.isArray(tx.vin)) return;
    
    for (const vin of tx.vin) {
      const spentUtxoId = `${vin.txid}:${vin.vout}`;
      
      const workerResult = await this.dbGet(`
        SELECT w.walletAddress, w.planId, w.salarySats, w.role, w.lastMintedPeriod, w.status,
               p.department, p.ticker
        FROM workers w
        LEFT JOIN plans p ON w.planId = p.appId
        WHERE w.currentTokenUtxo = ? AND w.status = ?
      `, [spentUtxoId, 'active']);
      
      const worker = workerResult as {
        walletAddress: string;
        planId: string;
        salarySats: number;
        role: string;
        lastMintedPeriod: string;
        status: string;
        department: string;
        ticker: string;
      } | undefined;
      
      if (worker) {
        console.log(`[INDEXER]   🔄 Worker token spent: ${spentUtxoId} | worker: ${worker.walletAddress.substring(0, 16)}...`);
        console.log(`[INDEXER]   Salary: ${worker.salarySats} sats/period, Role: ${worker.role}`);
        
        const timestamp = Math.floor(Date.now() / 1000);
        
        const departmentName = worker.department || (worker.ticker ? worker.ticker.replace('-PAY', '') : 'Unknown');
        const workerRole = worker.role || 'Team Member';
        
        let periodsPaid = 1;
        if (worker.lastMintedPeriod) {
          periodsPaid = 1;
        }
        
        const amountPaid = worker.salarySats * periodsPaid;
        
        const structuredRecord: StructuredPaymentRecord = {
          utxoId: spentUtxoId,
          timestamp: timestamp,
          blockHeight: blockHeight,
          amountSats: amountPaid,
          salarySats: worker.salarySats,
          periodsPaid: periodsPaid,
          paymentType: 'regular',
          txid: tx.txid,
          spentAt: new Date().toISOString(),
          departmentId: worker.planId,
          departmentName: departmentName,
          workerRole: workerRole,
          status: 'spent'
        };
        
        console.log(`[INDEXER]   📝 Creating structured payment record:`);
        console.log(`[INDEXER]     Amount: ${structuredRecord.amountSats} sats`);
        console.log(`[INDEXER]     Department: ${structuredRecord.departmentName}`);
        console.log(`[INDEXER]     Role: ${structuredRecord.workerRole}`);
        console.log(`[INDEXER]     Periods: ${structuredRecord.periodsPaid}`);
        console.log(`[INDEXER]     Block: ${structuredRecord.blockHeight}`);
        
        await addStructuredPaymentRecord(
          this.db,
          worker.walletAddress,
          worker.planId,
          structuredRecord
        );
        
        await this.dbRun(
          'UPDATE workers SET currentTokenUtxo = NULL, status = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
          ['pending', new Date().toISOString(), worker.walletAddress, worker.planId]
        );
        
        console.log(`[INDEXER]   ✅ Worker token cleared, status set to 'pending'`);
        
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
            `Salary payment released for worker ${worker.walletAddress.substring(0, 16)}... (${structuredRecord.amountSats} sats, ${structuredRecord.periodsPaid} period(s))`,
            tx.txid,
            'confirmed'
          );
          console.log(`[INDEXER]   ✅ Created audit log for Scroll release: ${tx.txid.substring(0, 16)}...`);
        }
      }
    }
  }

  /**
   * Triggers batch Scroll release for multiple mature workers in a single transaction
   * ARCHITECTURE: Vault pays salaries only. Treasury pays ALL fees (Scroll + network + platform)
   */
  private async triggerBatchScrollRelease(workers: MatureWorker[], currentBlockHeight: number): Promise<void> {
    if (workers.length === 0) {
      console.log(`[INDEXER] 📭 No workers provided for batch release`);
      return;
    }
    
    console.log(`[INDEXER] 💸 Triggering BATCH release for ${workers.length} workers...`);
    console.log(`[INDEXER]   Current block height: ${currentBlockHeight}`);
    
    for (const worker of workers) {
      console.log(`[INDEXER]   Worker: ${worker.walletAddress.substring(0, 16)}..., Salary: ${worker.salarySats} sats, Role: ${worker.role}`);
    }
    
    const firstWorker = workers[0];
    const employerAddress = firstWorker.employerAddress;
    const vaultAddress = firstWorker.vaultAddress;
    const treasuryHexDest = firstWorker.treasuryHexDest;
    const treasuryAddress = firstWorker.treasuryAddress;
    
    // =========================================================================
    // SALARY CALCULATION (Vault only)
    // =========================================================================
    const totalSalarySats = workers.reduce((sum, w) => sum + w.salarySats, 0);
    const vaultRequired = totalSalarySats;
    
    console.log(`[INDEXER]   Total salary from vault: ${vaultRequired} sats for ${workers.length} workers`);
    
    // =========================================================================
    // FEE CALCULATION (Treasury pays all fees)
    // =========================================================================

    const NFT_CARRYING_COST = 1000;
    const platformFeeSats = Math.floor(totalSalarySats * (PLATFORM_FEE_BASIS_POINTS / 10000));
    const platformFeeAddress = process.env.PLATFORM_FEE_ADDRESS || PLATFORM_FEE_ADDRESS;
    
    // Dynamic network fee calculation
    const inputCount = 3;
    const outputCount = workers.length + 2;
    // Inside triggerBatchScrollRelease, replace the network fee calculation:
    const baseVSize = estimateTransactionVSize(inputCount, outputCount);
    const proofFloor = 1500;
    const perWorkerWeight = 100;
    const PROOF_OVERHEAD_BYTES = proofFloor + (workers.length * perWorkerWeight);
    const totalVSize = baseVSize + PROOF_OVERHEAD_BYTES;
    const networkFee = await calculateNetworkFee(totalVSize, 'halfHour');

    console.log(`[INDEXER] Network fee: ${networkFee} sats (base=${baseVSize}, proof overhead=${PROOF_OVERHEAD_BYTES}, total=${totalVSize} vB)`);
    
    const totalFeesRequired = SCROLL_FIXED_COST + networkFee + platformFeeSats + NFT_CARRYING_COST;
    
    console.log(`[INDEXER]   Platform fee: ${platformFeeSats} sats (${PLATFORM_FEE_BASIS_POINTS / 100}%) -> ${platformFeeAddress.substring(0, 20)}...`);
    console.log(`[INDEXER]   Scroll fixed fee: ${SCROLL_FIXED_COST} sats`);
    console.log(`[INDEXER]   Network fee: ${networkFee} sats (${totalVSize} vB @ dynamic rate)`);
    console.log(`[INDEXER]   Total fees from treasury: ${totalFeesRequired} sats`);
    
    // =========================================================================
    // SELECT VAULT UTXO (Salary only - no fees)
    // =========================================================================
    let vaultUtxo: any;
    try {
      console.log(`[INDEXER]   Selecting vault UTXO from: ${vaultAddress.substring(0, 20)}...`);
      
      vaultUtxo = await getDynamicFundingUtxo(
        this.db,
        vaultAddress,
        vaultRequired,
        employerAddress
      );
      console.log(`[INDEXER]   ✅ Vault UTXO selected: ${vaultUtxo.utxoId}, value: ${vaultUtxo.value} sats`);
    } catch (error: any) {
      console.error(`[INDEXER]   ❌ Failed to select vault UTXO: ${error.message}`);
      console.log(`[INDEXER]   💡 Skipping batch release for this cycle. Will retry on next scan.`);
      return;
    }
    
    // =========================================================================
    // SELECT TREASURY UTXO (All fees: Scroll + network + platform)
    // =========================================================================
    let treasuryUtxo: any;
    try {
      console.log(`[INDEXER]   Selecting treasury UTXO from: ${treasuryAddress.substring(0, 20)}...`);
      
      treasuryUtxo = await getDynamicFundingUtxo(
        this.db,
        treasuryAddress,
        totalFeesRequired,
        employerAddress,
        [vaultUtxo.utxoId]
      );
      console.log(`[INDEXER]   ✅ Treasury UTXO selected: ${treasuryUtxo.utxoId}, value: ${treasuryUtxo.value} sats`);
    } catch (error: any) {
      console.error(`[INDEXER]   ❌ Failed to select treasury UTXO: ${error.message}`);
      await unlockUtxo(this.db, vaultUtxo.utxoId);
      console.log(`[INDEXER]   🔓 Unlocked vault UTXO: ${vaultUtxo.utxoId}`);
      return;
    }
    
    // =========================================================================
    // CALCULATE TREASURY CHANGE
    // =========================================================================
    const totalTreasuryInput = treasuryUtxo.value;
    const totalTreasuryOutput = platformFeeSats + SCROLL_FIXED_COST + networkFee;
    const treasuryChangeSats = totalTreasuryInput - totalTreasuryOutput;

    // Only add change output if amount meets dust limit (>= 1000 sats)
    const hasTreasuryChange = treasuryChangeSats >= 1000;

    if (treasuryChangeSats > 0 && treasuryChangeSats < 1000) {
        console.log(`[INDEXER] Change (${treasuryChangeSats} sats) is below dust limit. Adding to fee instead.`);
    }

    // =========================================================================
    // BUILD OUTPUTS ARRAY DYNAMICALLY
    // =========================================================================
      const outputs: any[] = [
      ...workers.map(w => ({ address: w.walletAddress, sats: w.salarySats })),
      { address: platformFeeAddress, sats: platformFeeSats },
      { address: SCROLL_FEE_ADDRESS_TESTNET4, sats: SCROLL_FIXED_COST },
      { address: vaultAddress, sats: NFT_CARRYING_COST, nftMetadata: {
          appId: workers[0].appId,
          ticker: workers[0].ticker,
          remaining: workers[0].remaining,
          metadataHash: workers[0].metadataHash,
          scrollPolicy: workers[0].scrollPolicy,
          payPeriodSeconds: workers[0].payPeriodSeconds,
          compensationSats: workers[0].compensationSats,
          anchorUtxo: workers[0].anchorUtxo
      }}
  ];

    // Only add treasury change if it has value
    if (hasTreasuryChange) {
        outputs.push({ address: treasuryAddress, sats: treasuryChangeSats });
    }

    // =========================================================================
    // BUILD BATCH SPELL REQUEST
    // =========================================================================
    const releaseRequest: any = {
        type: 'scroll-release',
        authorityUtxos: workers.map(w => w.currentTokenUtxo),
        fundingUtxo: treasuryUtxo.utxoId,
        fundingUtxoValue: treasuryUtxo.value,
        salaryUtxo: vaultUtxo.utxoId,
        salaryUtxoValue: vaultUtxo.value,
        changeAddress: treasuryAddress,
        vaultChangeAddress: vaultAddress,
        feeRate: 2,
        outputs: outputs,
        hasTreasuryChange: hasTreasuryChange,
        planMetadata: {
            appId: workers[0].appId,
            anchorUtxo: workers[0].anchorUtxo,
            ticker: workers[0].ticker,
            remaining: workers[0].remaining,
            metadataHash: workers[0].metadataHash,
            scrollPolicy: workers[0].scrollPolicy,
            payPeriodSeconds: workers[0].payPeriodSeconds,
            compensationSats: workers[0].compensationSats
        }
    };
    
    console.log(`[INDEXER]   Spell request prepared with ${releaseRequest.outputs.length} outputs`);
    
    // =========================================================================
    // FETCH PREVIOUS TRANSACTIONS
    // =========================================================================
    const tokenTxids = workers.map(w => w.currentTokenUtxo.split(':')[0]);
    console.log(`[INDEXER]   Fetching ${tokenTxids.length} token transactions for context...`);
    
    const prevTxHexes: string[] = [];
    for (const tokenTxid of tokenTxids) {
      try {
        const tokenTxHex = await this.fetchRawTransactionHex(tokenTxid);
        prevTxHexes.push(tokenTxHex);
        console.log(`[INDEXER]     ✓ Fetched token tx: ${tokenTxid.substring(0, 16)}...`);
      } catch (err: any) {
        console.error(`[INDEXER]     ❌ Failed to fetch token tx: ${tokenTxid.substring(0, 16)}...`);
        await unlockUtxo(this.db, vaultUtxo.utxoId);
        await unlockUtxo(this.db, treasuryUtxo.utxoId);
        throw err;
      }
    }
    
    prevTxHexes.push(treasuryUtxo.hex);
    prevTxHexes.push(vaultUtxo.hex);
    
    console.log(`[INDEXER]   Total prev_txs: ${prevTxHexes.length}`);
    
    // =========================================================================
    // CALL PROVER
    // =========================================================================
    console.log(`[INDEXER]   Calling prover to generate unsigned batch transaction...`);
    
    let proverResult: ProverResult;
    try {
      proverResult = await generateUnsignedTransactions(
        releaseRequest,
        prevTxHexes,
        treasuryHexDest,
        workers[0].appId
      );
      console.log(`[INDEXER]   ✅ Batch release transaction built successfully`);
    } catch (error: any) {
      console.error(`[INDEXER]   ❌ Prover failed: ${error.message}`);
      await unlockUtxo(this.db, vaultUtxo.utxoId);
      await unlockUtxo(this.db, treasuryUtxo.utxoId);
      console.log(`[INDEXER]   🔓 Unlocked vault and treasury UTXOs`);
      return;
    }
    
    // =========================================================================
    // REQUEST SCROLL SIGNATURE
    // =========================================================================
    const nonce = scrolls.deriveCompanyNonce(employerAddress);
    console.log(`[INDEXER]   Requesting Scroll signature with nonce: ${nonce}`);
    
    let signedTx: string;
    try {
      signedTx = await scrolls.requestScrollSignature(
        proverResult.spellTxHex,
        [{ index: 0, nonce }],
        [prevTxHexes[0]]
      );
    } catch (error: any) {
      console.error(`[INDEXER]   ❌ Scroll signature failed: ${error.message}`);
      await unlockUtxo(this.db, vaultUtxo.utxoId);
      await unlockUtxo(this.db, treasuryUtxo.utxoId);
      console.log(`[INDEXER]   🔓 Unlocked vault and treasury UTXOs`);
      return;
    }
    
    // =========================================================================
    // BROADCAST TRANSACTION
    // =========================================================================
    console.log(`[INDEXER]   Broadcasting batch release transaction...`);
    
    let txid: string;
    try {
      txid = await this.rpcCall('sendrawtransaction', [signedTx]);
      console.log(`[INDEXER] ✅ Batch Payout Successful! TxID: ${txid}`);
    } catch (error: any) {
      console.error(`[INDEXER]   ❌ Broadcast failed: ${error.message}`);
      await unlockUtxo(this.db, vaultUtxo.utxoId);
      await unlockUtxo(this.db, treasuryUtxo.utxoId);
      console.log(`[INDEXER]   🔓 Unlocked vault and treasury UTXOs`);
      return;
    }
    
    // =========================================================================
    // UPDATE WORKER RECORDS
    // =========================================================================
    for (const worker of workers) {
      await this.dbRun(
        'UPDATE workers SET currentTokenUtxo = NULL, status = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
        ['pending', new Date().toISOString(), worker.walletAddress, worker.planId]
      );
      console.log(`[INDEXER]   ✅ Worker ${worker.walletAddress.substring(0, 16)}... token cleared`);
    }
    
    await this.createAuditLog(
      crypto.randomUUID(),
      'SCROLL_RELEASE',
      `Batch payout for ${workers.length} workers: total ${totalSalarySats} sats (fee: ${platformFeeSats} sats)`,
      txid,
      'confirmed'
    );
    console.log(`[INDEXER]   ✅ Batch audit log created for ${workers.length} workers`);
    
    await unlockUtxo(this.db, vaultUtxo.utxoId);
    await unlockUtxo(this.db, treasuryUtxo.utxoId);
    console.log(`[INDEXER]   🔓 Unlocked vault and treasury UTXOs (now spent)`);
    
    console.log(`[INDEXER] 📊 Batch release completed: ${workers.length} workers paid, TXID: ${txid.substring(0, 16)}...`);
  }

  private async processAutomatedReleases(currentBlockHeight: number): Promise<void> {
    console.log(`[INDEXER] ⏰ Checking for mature payroll tokens at height ${currentBlockHeight}...`);
  
    try {
      const { verifyUtxoStatus } = await import('./utxo-manager');
      
      console.log(`[INDEXER] 🔍 Querying workers with expiresAt <= ${currentBlockHeight}`);
      
      const query = `
      SELECT w.*, p.appId, p.anchorUtxo, p.ticker, p.remaining, p.metadataHash,
            p.scrollPolicy, p.payPeriodSeconds, p.compensationSats,
            p.employerAddress, c.vaultAddress, c.treasuryHexDest, c.treasuryAddress
      FROM workers w
      JOIN plans p ON w.planId = p.appId
      JOIN companies c ON p.employerAddress = c.employerAddress
      WHERE w.status = 'active' 
      AND w.currentTokenUtxo IS NOT NULL
      AND w.expiresAt IS NOT NULL
      AND w.expiresAt != ''
      AND CAST(w.expiresAt AS INTEGER) <= ?
    `;
      
      const result = await this.db.execute({ sql: query, args: [currentBlockHeight] });
      const matureWorkersRaw = result.rows || [];
  
      console.log(`[INDEXER] 📊 Query returned ${matureWorkersRaw.length} mature workers`);
  
      if (matureWorkersRaw.length === 0) {
        console.log(`[INDEXER] 📭 No mature tokens found at height ${currentBlockHeight}`);
        return;
      }
  
      const verifiedWorkers: MatureWorker[] = [];
      
      for (const worker of matureWorkersRaw) {
        console.log(`[INDEXER]   Worker: ${worker.name}, expiresAt: ${worker.expiresAt}, currentHeight: ${currentBlockHeight}, mature: ${currentBlockHeight >= parseInt(worker.expiresAt, 10)}`);
        
        console.log(`[INDEXER]   Verifying token status for worker ${worker.walletAddress.substring(0, 16)}...`);
        console.log(`[INDEXER]   Token expires at block: ${worker.expiresAt}, current block: ${currentBlockHeight}`);
        
        const tokenStatus = await verifyUtxoStatus(worker.currentTokenUtxo);
        
        if (!tokenStatus.confirmed) {
          console.warn(`[INDEXER]   ⚠️ Skipping worker: Token ${worker.currentTokenUtxo} is not confirmed (still in mempool).`);
          continue;
        }
        
        if (tokenStatus.spent) {
          console.warn(`[INDEXER]   ⚠️ Skipping worker: Token ${worker.currentTokenUtxo} has already been spent.`);
          continue;
        }
        
        console.log(`[INDEXER]   ✅ Token verified: confirmed=${tokenStatus.confirmed}, spent=${tokenStatus.spent}`);
        
        verifiedWorkers.push({
          walletAddress: worker.walletAddress,
          planId: worker.planId,
          salarySats: worker.salarySats,
          role: worker.role,
          currentTokenUtxo: worker.currentTokenUtxo,
          employerAddress: worker.employerAddress,
          appId: worker.appId,
          vaultAddress: worker.vaultAddress,
          treasuryHexDest: worker.treasuryHexDest,
          treasuryAddress: worker.treasuryAddress,
          anchorUtxo: worker.anchorUtxo,
          ticker: worker.ticker,
          remaining: worker.remaining,
          metadataHash: worker.metadataHash,
          scrollPolicy: worker.scrollPolicy,
          payPeriodSeconds: worker.payPeriodSeconds,
          compensationSats: worker.compensationSats
        });
      }
      
      if (verifiedWorkers.length === 0) {
        console.log(`[INDEXER] 📭 No verified workers found after token status checks`);
        return;
      }
      
      console.log(`[INDEXER] 🎯 Found ${verifiedWorkers.length} verified workers eligible for automated batch payout.`);
      
      const employerGroups = new Map<string, MatureWorker[]>();
      for (const worker of verifiedWorkers) {
        if (!employerGroups.has(worker.employerAddress)) {
          employerGroups.set(worker.employerAddress, []);
        }
        employerGroups.get(worker.employerAddress)!.push(worker);
      }
      
      console.log(`[INDEXER] 📊 Grouped by employer: ${employerGroups.size} employer(s)`);
      
      let totalReleased = 0;
      let totalFailed = 0;
      
      for (const [employer, workers] of employerGroups.entries()) {
        console.log(`[INDEXER] 🏢 Processing batch for employer: ${employer.substring(0, 20)}... (${workers.length} workers)`);
        
        try {
          await this.triggerBatchScrollRelease(workers, currentBlockHeight);
          totalReleased += workers.length;
        } catch (error: any) {
          console.error(`[INDEXER] ❌ Batch release failed for employer ${employer.substring(0, 20)}...: ${error.message}`);
          totalFailed += workers.length;
        }
      }
      
      console.log(`[INDEXER] 📊 Release summary: ${totalReleased} released, ${totalFailed} failed`);
      
    } catch (error: any) {
      console.error(`[INDEXER] ❌ Automated release check failed: ${error.message}`);
    }
  }

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
// =========================================================================

export async function syncIndexer(db: any, maxBlocksToScan: number = 50): Promise<void> {
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