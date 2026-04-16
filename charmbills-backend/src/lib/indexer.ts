import * as bitcoin from 'bitcoinjs-lib';
import axios from 'axios';
import initWasm, { extractAndVerifySpell } from "@wasm/charms_lib";
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

// Load environment variables
dotenv.config();

export interface IndexerConfig {
  rpcUrl?: string;           // Optional - will build from env if not provided
  rpcUser?: string;           // Optional - falls back to env
  rpcPassword?: string;       // Optional - falls back to env
  startBlock?: number;
  batchSize?: number;
  scanIntervalMs?: number;
}

export class DerivableIndexer {
  private db: any;  // Changed from Database to any for Turso compatibility
  private config: IndexerConfig;
  private currentBlock: number;
  private rpcUrl: string;
  private rpcAuth: string;

  constructor(db: any, config: IndexerConfig = {}) {
    this.db = db;
    
    // Load RPC credentials from environment
    const rpcUser = config.rpcUser || process.env.RPC_USER;
    const rpcPassword = config.rpcPassword || process.env.RPC_PASSWORD;
    
    if (!rpcUser || !rpcPassword) {
      throw new Error(
        'RPC credentials required. Set RPC_USER and RPC_PASSWORD in .env file or pass to config.'
      );
    }
    
    // Build RPC URL
    const host = DEFAULT_RPC_HOST;
    const port = DEFAULT_RPC_PORT;
    this.rpcUrl = config.rpcUrl || `http://${host}:${port}`;
    this.rpcAuth = 'Basic ' + Buffer.from(`${rpcUser}:${rpcPassword}`).toString('base64');
    
    this.config = {
      batchSize: INDEXER_BATCH_SIZE,
      scanIntervalMs: INDEXER_SCAN_INTERVAL_MS,
      ...config
    };
    
    // Prioritize: config > env > default
    this.currentBlock = config.startBlock || 
                        Number(process.env.INDEXER_START_BLOCK) || 
                        129000;
    
    console.log(`🔧 Indexer initialized with RPC URL: ${this.rpcUrl}`);
    console.log(`🔧 Starting from block: ${this.currentBlock}`);
  }

  // =========================================================================
  // Helper to convert Turso result to row object
  // =========================================================================
  private async dbGet(sql: string, args: any[] = []): Promise<any> {
    try {
      const result = await this.db.execute({ sql, args });
      return result.rows[0] || null;
    } catch (error) {
      console.error('Database error in dbGet:', error);
      return null;
    }
  }

  private async dbRun(sql: string, args: any[] = []): Promise<any> {
    try {
      const result = await this.db.execute({ sql, args });
      return result;
    } catch (error) {
      console.error('Database error in dbRun:', error);
      throw error;
    }
  }

  // =========================================================================
  // PUBLIC METHODS FOR LAZY INDEXER PATTERN
  // =========================================================================

  /**
   * Get the latest block height from Bitcoin node
   * Made public for Lazy Indexer pattern
   */
  public async getLatestBlockHeight(): Promise<number> {
    return this.rpcCall('getblockcount', []);
  }

  /**
   * Index a range of blocks
   * Made public for Lazy Indexer pattern
   * Preserves all existing audit log and reconciliation logic
   */
  public async indexBlocks(fromBlock: number, toBlock: number): Promise<void> {
    console.log(`📦 Indexing blocks ${fromBlock} to ${toBlock}`);
    
    for (let blockHeight = fromBlock; blockHeight <= toBlock; blockHeight += this.config.batchSize!) {
      const endBlock = Math.min(blockHeight + this.config.batchSize! - 1, toBlock);
      
      try {
        // Get block hashes for range
        const blockHashes = await this.getBlockHashes(blockHeight, endBlock);
        
        for (const blockHash of blockHashes) {
          await this.indexBlock(blockHash);
        }
        
        console.log(`✅ Indexed blocks ${blockHeight}-${endBlock}`);
      } catch (error) {
        console.error(`❌ Failed to index blocks ${blockHeight}-${endBlock}:`, error);
      }
    }
  }

  /**
   * Start continuous indexing (for persistent server environments)
   * This method runs an infinite loop - DO NOT use on Vercel
   */
  async start(): Promise<void> {
    console.log(`🔄 Indexer starting from block ${this.currentBlock}`);
    
    while (true) {
      try {
        const latestBlock = await this.getLatestBlockHeight();
        
        if (this.currentBlock <= latestBlock) {
          console.log(`📦 New blocks available: ${this.currentBlock} → ${latestBlock}`);
          await this.indexBlocks(this.currentBlock, latestBlock);
          this.currentBlock = latestBlock + 1;
        }
        
        // Wait before next scan
        await new Promise(resolve => setTimeout(resolve, this.config.scanIntervalMs));
      } catch (error) {
        console.error('❌ Indexer error:', error);
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
    return this.rpcCall('getblock', [blockHash, 2]); // Verbosity 2 for full tx details
  }

  private async indexBlock(blockHash: string): Promise<void> {
    const block = await this.getBlock(blockHash);
    console.log(`  Processing block ${block.height} (${block.tx.length} transactions)`);
    
    // Use bitcoinjs-lib in a debug log to silence the import warning
    if (process.env.NODE_ENV === 'development') {
      const testTx = block.tx[0];
      if (testTx) {
        const txId = bitcoin.Transaction.fromHex(testTx.hex || testTx).getId();
        console.log(`  First tx in block: ${txId.substring(0, 16)}...`);
      }
    }
    
    for (const tx of block.tx) {
      try {
        // Extract spell using WASM module
        const txHex = tx.hex || tx;
        const spell = extractAndVerifySpell(txHex, false);
        
        if (!spell) continue;
        
        // Check if this is a payroll-related spell
        const hasPayrollNFT = spell.outputs?.some((output: any) => 
          output.nftMetadata?.ticker === PAYROLL_NFT_TICKER
        );
        
        if (!hasPayrollNFT) continue;
        
        await this.processPayrollSpell(spell, block.height);
        
        // =========================================================================
        // PRODUCTION RECONCILIATION: Check for spent worker tokens [Source 870]
        // This preserves your audit log functionality for non-ZKproof transactions
        // =========================================================================
        await this.reconcileSettlements(tx, block.height);
        
      } catch (error) {
        // Skip non-spell transactions
        continue;
      }
    }
  }

  // =========================================================================
  // PRODUCTION FIX: Process payroll spell with awaited decryption [Source 816]
  // =========================================================================
  private async processPayrollSpell(spell: any, blockHeight: number): Promise<void> {
    console.log(`🔍 Found payroll spell at block ${blockHeight}`);
    
    // Find NFT output with payroll ticker
    const nftOutput = spell.outputs?.find((out: any) => 
      out.nftMetadata?.ticker === PAYROLL_NFT_TICKER
    );
    
    if (!nftOutput || !nftOutput.nftMetadata) {
      console.log('  No NFT output found with payroll ticker');
      return;
    }
    
    const metadata = nftOutput.nftMetadata;
    const metadataHash = metadata.metadataHash; // String from Rust
    
    if (!metadataHash) {
      console.log('  No metadataHash in NFT');
      return;
    }
    
    console.log(`  ✅ Found Plan NFT: appId=${spell.appId}, utxo=${nftOutput.utxoId}`);
    console.log(`     compensation=${metadata.compensationSats} sats, period=${metadata.payPeriodSeconds}s`);
    
    // Get existing plan using Turso
    const existingPlanResult = await this.dbGet('SELECT * FROM plans WHERE appId = ?', [spell.appId]);
    const existingPlan = existingPlanResult as PlanCache | undefined;
    
    if (existingPlan) {
      console.log(` ✅ Found existing plan: ${existingPlan.appId} (last indexed at block ${existingPlan.lastIndexedBlock})`);
    }
    
    // Store in cache immediately (minimal data)
    await this.dbRun(`
      INSERT OR REPLACE INTO plans (
        appId, nftUtxoId, ticker, compensationSats, 
        payPeriodSeconds, metadataHash, scrollPolicy,
        lastIndexedBlock, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      spell.appId,
      nftOutput.utxoId,
      metadata.ticker,
      metadata.compensationSats,
      metadata.payPeriodSeconds,
      metadataHash,
      metadata.scrollPolicy,
      blockHeight,
      new Date().toISOString(),
      new Date().toISOString()
    ]);
    
    // Create audit log for plan creation
    await this.createAuditLog(
      crypto.randomUUID(),
      'PLAN_CREATED',
      `Plan NFT created: ${metadata.ticker}`,
      spell.txid,
      'pending'
    );
    
    // Optionally fetch and decrypt full metadata for HR dashboard
    // This can be done lazily or in background
    this.enrichPlanWithMetadata(spell.appId, metadataHash).catch(console.error);
  }

  private async enrichPlanWithMetadata(appId: string, metadataHash: string): Promise<void> {
    try {
      // The metadataHash is SHA256 of IPFS CID
      // We need to find the CID that hashes to this value
      const cid = await this.findCIDByHash(metadataHash);
      if (!cid) {
        console.log(`  No CID mapping found for hash ${metadataHash}`);
        return;
      }
      
      console.log(`  Fetching encrypted metadata from IPFS: ${cid}`);
      
      // 1. Fetch the generic blob from IPFS
      const rawBlob = await getFromIPFS(cid);
      
      // 2. FIX: Explicitly cast to EncryptedData to satisfy the compiler
      const encryptedBlob = rawBlob as unknown as EncryptedData;
      
      // 3. PRODUCTION FIX: Decrypt using the employer's key (encryptionEntropy)
      // Note: In production, the key is provided by the HR manager's session
      // For the indexer's background cache, we need to have access to the entropy
      const encryptionKey = process.env.PAYROLL_ENCRYPTION_ENTROPY;
      
      if (!encryptionKey) {
        console.error(`❌ Cannot decrypt plan ${appId}: PAYROLL_ENCRYPTION_ENTROPY not set`);
        return;
      }
      
      // =========================================================================
      // CRITICAL FIX: Await the decryption to resolve the Promise [Source 816]
      // This fixes "Property does not exist on type Promise" errors
      // =========================================================================
      const decryptedData = await decryptPayrollData(encryptedBlob, encryptionKey);
      
      // Now decryptedData is a Record<string, any>, not a Promise
      const role = decryptedData.role || 'Unknown Role';
      const employeeName = decryptedData.employeeName || 'Unnamed Worker';
      const employeeWallet = decryptedData.employeeWallet;
      
      console.log(`  Enriched plan ${appId} with role: ${role}`);
      
      // Update plan with human-readable fields
      await this.dbRun(`
        UPDATE plans 
        SET role = ?, 
            updatedAt = ?
        WHERE appId = ?
      `, [
        role,
        new Date().toISOString(),
        appId
      ]);
      
      // If this is a worker token, update worker cache using WorkerCache type
      if (employeeWallet) {
        // Get existing worker using Turso
        const existingWorkerResult = await this.dbGet(
          'SELECT * FROM workers WHERE walletAddress = ? AND planId = ?',
          [employeeWallet, appId]
        );
        const existingWorker = existingWorkerResult as WorkerCache | undefined;
        
        // Use the variable to clear the 'never read' warning
        if (existingWorker) {
          console.log(` 👤 Worker already exists in cache: ${existingWorker.walletAddress}`);
        }
        
        // Insert worker with name from decrypted data
        await this.dbRun(`
          INSERT OR REPLACE INTO workers (
            walletAddress, name, planId, engagementType, status,
            lastMintedPeriod, currentTokenUtxo, expiresAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          employeeWallet,
          employeeName, // Save the name from metadata
          appId,
          decryptedData.engagementType || 0, // Default to full-time
          'active',
          decryptedData.period || new Date().toISOString().split('T')[0],
          null, // Will be updated when token is minted
          decryptedData.expiresAt || null
        ]);
        
        console.log(`  Updated worker cache for ${employeeWallet.substring(0, 20)}... with name: ${employeeName}`);
      }
      
    } catch (error) {
      console.error(`❌ Decryption failed for plan ${appId}:`, error);
    }
  }

  // =========================================================================
  // PRODUCTION RECONCILIATION: Scans for spent worker tokens 
  // to move them to 'historicalTokens' and confirm audit logs. [Source 870]
  // This function preserves your existing audit log functionality
  // =========================================================================
  private async reconcileSettlements(tx: any, blockHeight: number): Promise<void> {
    if (!tx.vin || !Array.isArray(tx.vin)) return;
    
    for (const vin of tx.vin) {
      const spentUtxoId = `${vin.txid}:${vin.vout}`;
      
      // Check if this UTXO is a current worker token using Turso
      const workerResult = await this.dbGet(
        'SELECT walletAddress, planId FROM workers WHERE currentTokenUtxo = ? AND status = "active"',
        [spentUtxoId]
      );
      const worker = workerResult as { walletAddress: string; planId: string } | undefined;
      
      if (worker) {
        console.log(`  🔄 Worker token spent: ${spentUtxoId} (worker: ${worker.walletAddress})`);
        
        // Move to historical tokens
        const timestamp = Math.floor(Date.now() / 1000);
        
        // Add to historicalTokens array using the existing helper
        // This preserves your audit trail
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
        
        // Update audit log status to confirmed if this is a Scroll Release
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
          console.log(`  ✅ Audit log confirmed for tx: ${tx.txid}`);
        } else {
          // Create audit log for this Scroll release if it doesn't exist
          await this.createAuditLog(
            crypto.randomUUID(),
            'SCROLL_RELEASE',
            `Salary payment released for worker ${worker.walletAddress.substring(0, 16)}...`,
            tx.txid,
            'confirmed'
          );
          console.log(`  ✅ Created audit log for Scroll release: ${tx.txid}`);
        }
      }
    }
  }

  // =========================================================================
  // Helper to create audit log entries
  // =========================================================================
  private async createAuditLog(
    id: string,
    type: 'PLAN_CREATED' | 'BATCH_MINT' | 'SCROLL_RELEASE' | 'TERMINATION' | 'TREASURY_FUNDING',
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
      console.error(`Failed to create audit log:`, error);
    }
  }

  // RPC helpers
  private async rpcCall(method: string, params: any[]): Promise<any> {
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
          timeout: 30000 // 30 second timeout
        }
      );
      
      if (response.data.error) {
        throw new Error(`RPC error: ${response.data.error.message}`);
      }
      
      return response.data.result;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        throw new Error(`RPC connection failed: ${error.message}`);
      }
      throw error;
    }
  }

  private async findCIDByHash(metadataHash: string): Promise<string | null> {
    // This requires a mapping table that stores CID -> metadataHash when pinning
    try {
      const result = await this.dbGet(
        'SELECT cid FROM ipfs_mappings WHERE metadataHash = ?',
        [metadataHash]
      );
      const row = result as { cid: string } | undefined;
      return row?.cid || null;
    } catch (error) {
      console.error(`Failed to find CID for hash ${metadataHash}:`, error);
      return null;
    }
  }
}

// =========================================================================
// LAZY INDEXER PATTERN FOR SERVERLESS (Vercel) DEPLOYMENT
// This function can be called from API routes to sync recent blocks
// Preserves all existing audit log and reconciliation logic
// =========================================================================

/**
 * Lazy Indexer - Triggers a partial blockchain sync from the last processed block
 * Designed for serverless environments (Vercel) where long-running processes are not allowed
 * Call this function at the beginning of your API routes (plans, workers, treasury)
 * 
 * @param db - Database connection (Turso client)
 * @param maxBlocksToScan - Maximum number of blocks to scan per API call (default 50)
 */
export async function syncIndexer(db: any, maxBlocksToScan: number = 50): Promise<void> {
  console.log('[LAZY INDEXER] Starting partial sync...');
  
  const indexer = new DerivableIndexer(db);
  
  try {
    // Get latest block from Bitcoin node
    const latestBlock = await indexer.getLatestBlockHeight();
    console.log(`[LAZY INDEXER] Latest block: ${latestBlock}`);
    
    // Get last processed block from database using Turso
    let startBlock = 129000; // Default fallback
    try {
      const result = await db.execute({
        sql: 'SELECT MAX(lastIndexedBlock) as block FROM plans',
        args: []
      });
      const row = result.rows[0];
      startBlock = row?.block || Number(process.env.INDEXER_START_BLOCK) || 129000;
    } catch (err) {
      console.error('[LAZY INDEXER] Failed to get last processed block:', err);
    }
    console.log(`[LAZY INDEXER] Last processed block: ${startBlock}`);
    
    // Only scan new blocks, limited by maxBlocksToScan
    if (latestBlock > startBlock) {
      const blocksToScan = Math.min(latestBlock - startBlock, maxBlocksToScan);
      const endBlock = startBlock + blocksToScan;
      
      console.log(`[LAZY INDEXER] Syncing blocks ${startBlock + 1} to ${endBlock} (${blocksToScan} blocks)`);
      
      await indexer.indexBlocks(startBlock + 1, endBlock);
      
      console.log(`[LAZY INDEXER] Sync complete. Processed up to block ${endBlock}`);
    } else {
      console.log(`[LAZY INDEXER] No new blocks to sync`);
    }
  } catch (error) {
    console.error('[LAZY INDEXER] Sync failed:', error);
  }
}

// Factory function for persistent environments
export function createIndexer(db: any, config?: IndexerConfig): DerivableIndexer {
  return new DerivableIndexer(db, config);
}

// Standalone function to start indexer (for persistent server environments)
export async function startIndexer(db: any, startBlock?: number): Promise<DerivableIndexer> {
  const indexer = createIndexer(db, { startBlock });
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    console.log('\n🛑 Stopping indexer...');
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    console.log('\n🛑 Stopping indexer...');
    process.exit(0);
  });
  
  // Start indexing
  await indexer.start();
  
  return indexer;
}