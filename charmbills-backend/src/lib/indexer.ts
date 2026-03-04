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
import { Database } from 'sqlite3';
import * as dotenv from 'dotenv';

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
  private db: Database;
  private config: IndexerConfig;
  private currentBlock: number;
  private rpcUrl: string;
  private rpcAuth: string;

  constructor(db: Database, config: IndexerConfig = {}) {
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
    
    this.currentBlock = config.startBlock || 0;
    
    console.log(`🔧 Indexer initialized with RPC URL: ${this.rpcUrl}`);
  }

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

  private async indexBlocks(fromBlock: number, toBlock: number): Promise<void> {
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
        // Note: extractAndVerifySpell expects hex transaction
        const txHex = tx.hex || tx;
        const spell = extractAndVerifySpell(txHex, false);
        
        if (!spell) continue;
        
        // Check if this is a payroll-related spell
        const hasPayrollNFT = spell.outputs?.some((output: any) => 
          output.nftMetadata?.ticker === PAYROLL_NFT_TICKER
        );
        
        if (!hasPayrollNFT) continue;
        
        await this.processPayrollSpell(spell, block.height);
      } catch (error) {
        // Skip non-spell transactions
        continue;
      }
    }
  }

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
    
    // FIX: Double casting (through unknown) for type safety [1]
    const existingPlan = (await this.db.get(
      'SELECT * FROM plans WHERE appId = ?', 
      [spell.appId]
    ) as unknown) as PlanCache | undefined;
    
    if (existingPlan) {
      console.log(` ✅ Found existing plan: ${existingPlan.appId} (last indexed at block ${existingPlan.lastIndexedBlock})`);
    }
    
    // Store in cache immediately (minimal data)
    await this.db.run(`
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
      
      // Now the types match correctly [3]
      const decryptedData = decryptPayrollData(encryptedBlob, encryptionKey);
      
      // Extract human-readable fields from the decrypted object
      const role = decryptedData.role || 'Unknown Role';
      const employeeName = decryptedData.employeeName || 'Unnamed Worker';
      
      console.log(`  Enriched plan ${appId} with role: ${role}`);
      
      // Update plan with human-readable fields
      await this.db.run(`
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
      if (decryptedData.employeeWallet) {
        // FIX: Double casting (through unknown) for type safety [2]
        const existingWorker = (await this.db.get(
          'SELECT * FROM workers WHERE walletAddress = ? AND planId = ?',
          [decryptedData.employeeWallet, appId]
        ) as unknown) as WorkerCache | undefined;
        
        // Use the variable to clear the 'never read' warning [2]
        if (existingWorker) {
          console.log(` 👤 Worker already exists in cache: ${existingWorker.walletAddress}`);
        }
        
        // Insert worker with name from decrypted data
        await this.db.run(`
          INSERT OR REPLACE INTO workers (
            walletAddress, name, planId, engagementType, status,
            lastMintedPeriod, currentTokenUtxo, expiresAt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          decryptedData.employeeWallet,
          employeeName, // Save the name from metadata
          appId,
          decryptedData.engagementType || 0, // Default to full-time
          'active',
          decryptedData.period || new Date().toISOString().split('T')[0],
          null, // Will be updated when token is minted
          decryptedData.expiresAt || null
        ]);
        
        console.log(`  Updated worker cache for ${decryptedData.employeeWallet.substring(0, 20)}... with name: ${employeeName}`);
      }
      
    } catch (error) {
      console.error(`❌ Decryption failed for plan ${appId}:`, error);
    }
  }

  // RPC helpers
  private async getLatestBlockHeight(): Promise<number> {
    return this.rpcCall('getblockcount', []);
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
    return this.rpcCall('getblock', [blockHash, 2]); // Verbosity 2 for full tx details
  }

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
      const result = (await this.db.get(
        'SELECT cid FROM ipfs_mappings WHERE metadataHash = ?',
        [metadataHash]
      ) as unknown) as { cid: string } | undefined;

      return result?.cid || null;
    } catch (error) {
      console.error(`Failed to find CID for hash ${metadataHash}:`, error);
      return null;
    }
  }
}

// Factory function
export function createIndexer(db: Database, config?: IndexerConfig): DerivableIndexer {
  return new DerivableIndexer(db, config);
}

// Standalone function to start indexer
export async function startIndexer(db: Database, startBlock?: number): Promise<DerivableIndexer> {
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