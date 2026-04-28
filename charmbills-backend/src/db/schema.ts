// charmbills-backend/src/db/schema.ts
import { EngagementType, ScrollPolicyType } from '@shared/types';

export interface PlanCache {
  appId: string;
  nftUtxoId: string;
  anchorUtxo: string;
  ticker: string;
  employerAddress: string;
  department?: string;
  payPeriodSeconds: number;
  metadataHash: string;
  scrollPolicy: ScrollPolicyType | number;
  remaining: number;
  vaultAddress?: string;  // ADDED: Isolated vault address for this plan (for indexer tracking)
  lastIndexedBlock?: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkerCache {
  walletAddress: string;
  name?: string;
  planId: string;
  engagementType: EngagementType;
  status: 'active' | 'terminated' | 'pending';
  lastMintedPeriod: string;
  currentTokenUtxo?: string;
  expiresAt?: string;
  salarySats: number;
  role: string;
  metadataHash: string;
  updatedAt: string;
  // ADDED: For Payment History Audit Trail [16]
  historicalTokens: string; // JSON stringified array of spent UTXO IDs
}

export interface CompanyRecord {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  createdAt: string;
  updatedAt?: string;
}

export interface LockedUtxo {
  utxoId: string;
  employerAddress: string;
  lockedAt: string;
  expiresAt: string;
}

// Database setup for Turso
export async function initDatabase(db: any): Promise<void> {
  console.log('[DB INIT] Creating database tables...');
  
  const queries = [
    `CREATE TABLE IF NOT EXISTS companies (
        employerAddress TEXT PRIMARY KEY,
        treasuryAddress TEXT NOT NULL,
        treasuryHexDest TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT
    )`,
    
    `CREATE TABLE IF NOT EXISTS locked_utxos (
        utxoId TEXT PRIMARY KEY,
        employerAddress TEXT NOT NULL,
        lockedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS plans (
        appId TEXT PRIMARY KEY,
        nftUtxoId TEXT UNIQUE NOT NULL,
        anchorUtxo TEXT NOT NULL,
        ticker TEXT NOT NULL,
        employerAddress TEXT NOT NULL,
        department TEXT,
        payPeriodSeconds INTEGER NOT NULL,
        metadataHash TEXT NOT NULL,
        scrollPolicy INTEGER NOT NULL,
        remaining INTEGER NOT NULL DEFAULT 100,
        vaultAddress TEXT,
        lastIndexedBlock INTEGER DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS workers (
        walletAddress TEXT,
        name TEXT,
        planId TEXT,
        engagementType INTEGER NOT NULL,
        status TEXT NOT NULL,
        lastMintedPeriod TEXT,
        currentTokenUtxo TEXT,
        expiresAt TEXT,
        salarySats INTEGER,
        role TEXT,
        metadataHash TEXT,
        updatedAt TEXT,
        historicalTokens TEXT DEFAULT '[]',
        PRIMARY KEY (walletAddress, planId)
    )`,
    
    `CREATE TABLE IF NOT EXISTS ipfs_mappings (
        metadataHash TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        createdAt TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS multisig_transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        employerAddress TEXT NOT NULL,
        worker_address TEXT,
        commitTxHex TEXT NOT NULL,
        spellTxHex TEXT NOT NULL,
        threshold INTEGER NOT NULL,
        signers_json TEXT DEFAULT '[]',
        status TEXT DEFAULT 'pending',
        createdAt TEXT NOT NULL
    )`,
    
    `CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        details TEXT,
        txid TEXT,
        timestamp TEXT NOT NULL,
        status TEXT DEFAULT 'pending'
    )`,

    `CREATE TABLE IF NOT EXISTS indexer_config (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updatedAt TEXT NOT NULL
    )`,
    
    // Indexes
    `CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)`,
    `CREATE INDEX IF NOT EXISTS idx_workers_plan ON workers(planId)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_ticker ON plans(ticker)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_employer ON plans(employerAddress)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_nftUtxo ON plans(nftUtxoId)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_remaining ON plans(remaining)`,
    `CREATE INDEX IF NOT EXISTS idx_plans_vaultAddress ON plans(vaultAddress)`,
    `CREATE INDEX IF NOT EXISTS idx_locked_utxos_employer ON locked_utxos(employerAddress)`,
    `CREATE INDEX IF NOT EXISTS idx_locked_utxos_expires ON locked_utxos(expiresAt)`,
    `CREATE INDEX IF NOT EXISTS idx_ipfs_hash ON ipfs_mappings(metadataHash)`,
    `CREATE INDEX IF NOT EXISTS idx_multisig_employer ON multisig_transactions(employerAddress)`,
    `CREATE INDEX IF NOT EXISTS idx_multisig_status ON multisig_transactions(status)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_type ON audit_logs(type)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_txid ON audit_logs(txid)`,
    `CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(timestamp)`,
    `CREATE INDEX IF NOT EXISTS idx_indexer_config_key ON indexer_config(key)`,
  ];
  
  for (const query of queries) {
    try {
      await db.execute(query);
    } catch (err: any) {
      console.error(`[DB INIT] Error: ${err.message}`);
    }
  }
  
  console.log('[DB INIT] Database initialization complete');
}

// ============================================================
// COMPANY HELPERS
// ============================================================

export async function saveCompanyConfig(
  db: any,
  employerAddress: string,
  treasuryAddress: string,
  treasuryHexDest: string
): Promise<void> {
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT OR REPLACE INTO companies (employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?)`,
    args: [employerAddress, treasuryAddress, treasuryHexDest, now, now]
  });
}

export async function getCompanyConfig(
  db: any,
  employerAddress: string
): Promise<CompanyRecord | null> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
  return result.rows[0] || null;
}

export async function listCompanies(
  db: any,
  limit: number = 50,
  offset: number = 0
): Promise<CompanyRecord[]> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies ORDER BY createdAt DESC LIMIT ? OFFSET ?',
    args: [limit, offset]
  });
  return result.rows || [];
}

export async function deleteCompany(
  db: any,
  employerAddress: string
): Promise<void> {
  await db.execute({
    sql: 'DELETE FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
}

// ============================================================
// UTXO LOCK HELPERS
// ============================================================

export async function lockUtxo(
  db: any,
  utxoId: string,
  employerAddress: string,
  ttlSeconds: number = 3600
): Promise<boolean> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  
  try {
    await db.execute({
      sql: `INSERT INTO locked_utxos (utxoId, employerAddress, lockedAt, expiresAt)
            VALUES (?, ?, ?, ?)`,
      args: [utxoId, employerAddress, now, expiresAt]
    });
    return true;
  } catch (err: any) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return false;
    }
    throw err;
  }
}

export async function unlockUtxo(
  db: any,
  utxoId: string
): Promise<boolean> {
  const result = await db.execute({
    sql: 'DELETE FROM locked_utxos WHERE utxoId = ?',
    args: [utxoId]
  });
  return (result.rowsAffected || 0) > 0;
}

export async function isUtxoLocked(
  db: any,
  utxoId: string
): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE utxoId = ? AND expiresAt > ?',
    args: [utxoId, new Date().toISOString()]
  });
  return (result.rows?.length || 0) > 0;
}

export async function cleanupExpiredLocks(
  db: any
): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM locked_utxos WHERE expiresAt <= ?',
    args: [new Date().toISOString()]
  });
  return result.rowsAffected || 0;
}

export async function getLockedUtxosForEmployer(
  db: any,
  employerAddress: string
): Promise<LockedUtxo[]> {
  const result = await db.execute({
    sql: 'SELECT utxoId, employerAddress, lockedAt, expiresAt FROM locked_utxos WHERE employerAddress = ? AND expiresAt > ?',
    args: [employerAddress, new Date().toISOString()]
  });
  return result.rows || [];
}

// ============================================================
// PLAN HELPERS
// ============================================================

export async function savePlanRecord(
  db: any,
  plan: PlanCache
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO plans 
          (appId, nftUtxoId, ticker, employerAddress, department, 
           payPeriodSeconds, metadataHash, scrollPolicy, remaining, 
           vaultAddress, lastIndexedBlock, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      plan.appId,
      plan.nftUtxoId,
      plan.ticker,
      plan.employerAddress,
      plan.department || null,
      plan.payPeriodSeconds,
      plan.metadataHash,
      plan.scrollPolicy,
      plan.remaining,
      plan.vaultAddress || null,
      plan.lastIndexedBlock || 0,
      plan.createdAt,
      plan.updatedAt
    ]
  });
}

export async function getPlanByAppId(
  db: any,
  appId: string
): Promise<PlanCache | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM plans WHERE appId = ?',
    args: [appId]
  });
  return result.rows[0] || null;
}

export async function getPlanByNftUtxo(
  db: any,
  nftUtxoId: string
): Promise<PlanCache | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM plans WHERE nftUtxoId = ?',
    args: [nftUtxoId]
  });
  return result.rows[0] || null;
}

export async function getPlansByEmployer(
  db: any,
  employerAddress: string,
  limit: number = 50,
  offset: number = 0
): Promise<PlanCache[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM plans WHERE employerAddress = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?',
    args: [employerAddress, limit, offset]
  });
  return result.rows || [];
}

export async function updatePlanRemaining(
  db: any,
  appId: string,
  newRemaining: number
): Promise<void> {
  await db.execute({
    sql: 'UPDATE plans SET remaining = ?, updatedAt = ? WHERE appId = ?',
    args: [newRemaining, new Date().toISOString(), appId]
  });
}

export async function updatePlanVaultAddress(
  db: any,
  appId: string,
  vaultAddress: string
): Promise<void> {
  await db.execute({
    sql: 'UPDATE plans SET vaultAddress = ?, updatedAt = ? WHERE appId = ?',
    args: [vaultAddress, new Date().toISOString(), appId]
  });
}

export async function updatePlanLastIndexedBlock(
  db: any,
  appId: string,
  blockNumber: number
): Promise<void> {
  await db.execute({
    sql: 'UPDATE plans SET lastIndexedBlock = ?, updatedAt = ? WHERE appId = ?',
    args: [blockNumber, new Date().toISOString(), appId]
  });
}

// ============================================================
// WORKER HELPERS
// ============================================================

export async function saveWorkerRecord(
  db: any,
  worker: WorkerCache
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO workers 
          (walletAddress, name, planId, engagementType, status, lastMintedPeriod, 
           currentTokenUtxo, expiresAt, salarySats, role, metadataHash, updatedAt, historicalTokens)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      worker.walletAddress,
      worker.name || null,
      worker.planId,
      worker.engagementType,
      worker.status,
      worker.lastMintedPeriod,
      worker.currentTokenUtxo || null,
      worker.expiresAt || null,
      worker.salarySats,
      worker.role,
      worker.metadataHash,
      worker.updatedAt,
      worker.historicalTokens || '[]'
    ]
  });
}

export async function getWorkersByPlan(
  db: any,
  planId: string
): Promise<WorkerCache[]> {
  const result = await db.execute({
    sql: 'SELECT * FROM workers WHERE planId = ? ORDER BY status DESC, name ASC',
    args: [planId]
  });
  return result.rows || [];
}

export async function getWorkerByAddress(
  db: any,
  walletAddress: string
): Promise<WorkerCache | null> {
  const result = await db.execute({
    sql: 'SELECT * FROM workers WHERE walletAddress = ? ORDER BY updatedAt DESC LIMIT 1',
    args: [walletAddress]
  });
  return result.rows[0] || null;
}

export async function updateWorkerStatus(
  db: any,
  walletAddress: string,
  planId: string,
  status: 'active' | 'terminated' | 'pending'
): Promise<void> {
  await db.execute({
    sql: 'UPDATE workers SET status = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
    args: [status, new Date().toISOString(), walletAddress, planId]
  });
}

export async function updateWorkerToken(
  db: any,
  walletAddress: string,
  planId: string,
  tokenUtxo: string,
  expiresAt: string
): Promise<void> {
  await db.execute({
    sql: 'UPDATE workers SET currentTokenUtxo = ?, expiresAt = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
    args: [tokenUtxo, expiresAt, new Date().toISOString(), walletAddress, planId]
  });
}

export async function updateWorkerMetadata(
  db: any,
  walletAddress: string,
  planId: string,
  metadataHash: string
): Promise<void> {
  await db.execute({
    sql: 'UPDATE workers SET metadataHash = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
    args: [metadataHash, new Date().toISOString(), walletAddress, planId]
  });
}

/**
 * ADDED: Targeted update for post-mint worker record
 * This preserves the worker's name and role from the registry
 * Only updates status, token UTXO, expiry, and last minted period
 */
export async function updateWorkerPostMint(
  db: any,
  walletAddress: string,
  planId: string,
  tokenUtxo: string,
  expiresAt: string,
  lastMintedPeriod: string
): Promise<void> {
  await db.execute({
    sql: `UPDATE workers 
          SET status = 'active', 
              currentTokenUtxo = ?, 
              expiresAt = ?, 
              lastMintedPeriod = ?,
              updatedAt = ?
          WHERE walletAddress = ? AND planId = ?`,
    args: [
      tokenUtxo,
      expiresAt,
      lastMintedPeriod,
      new Date().toISOString(),
      walletAddress,
      planId
    ]
  });
}

/**
 * Add a spent token UTXO to worker's historicalTokens audit trail
 * Used for Payment History feature
 */
export async function addHistoricalToken(
  db: any,
  walletAddress: string,
  planId: string,
  spentUtxo: string,
  timestamp: number
): Promise<void> {
  // First get current historicalTokens
  const result = await db.execute({
    sql: 'SELECT historicalTokens FROM workers WHERE walletAddress = ? AND planId = ?',
    args: [walletAddress, planId]
  });
  
  let history: any[] = [];
  const row = result.rows[0];
  if (row && row.historicalTokens) {
    try {
      history = JSON.parse(row.historicalTokens);
    } catch (e) {
      history = [];
    }
  }
  
  // Add new entry
  history.push({
    utxoId: spentUtxo,
    timestamp: timestamp,
    spentAt: new Date().toISOString()
  });
  
  // Update the record
  await db.execute({
    sql: 'UPDATE workers SET historicalTokens = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
    args: [JSON.stringify(history), new Date().toISOString(), walletAddress, planId]
  });
}

// ============================================================
// AUDIT LOG HELPERS
// ============================================================

/**
 * Save an audit log entry for on-chain transaction tracking
 * Used to maintain a derivable audit trail from the blockchain
 */
export async function saveAuditLog(
  db: any,
  id: string,
  type: string,
  details: string,
  txid: string,
  status: 'pending' | 'confirmed' = 'pending'
): Promise<void> {
  const timestamp = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO audit_logs (id, type, details, txid, timestamp, status)
          VALUES (?, ?, ?, ?, ?, ?)`,
    args: [id, type, details, txid, timestamp, status]
  });
}

/**
 * Update audit log status when transaction is confirmed
 */
export async function updateAuditLogStatus(
  db: any,
  id: string,
  status: 'confirmed'
): Promise<void> {
  await db.execute({
    sql: 'UPDATE audit_logs SET status = ? WHERE id = ?',
    args: [status, id]
  });
}

/**
 * Get audit logs for a specific type or time range
 */
export async function getAuditLogs(
  db: any,
  type?: string,
  limit: number = 50,
  offset: number = 0
): Promise<any[]> {
  let sql = 'SELECT * FROM audit_logs';
  const args: any[] = [];
  
  if (type) {
    sql += ' WHERE type = ?';
    args.push(type);
  }
  
  sql += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
  args.push(limit, offset);
  
  const result = await db.execute({ sql, args });
  return result.rows || [];
}

// ============================================================
// IPFS MAPPING HELPERS
// ============================================================

export async function saveIpfsMapping(
  db: any,
  metadataHash: string,
  cid: string
): Promise<void> {
  await db.execute({
    sql: 'INSERT OR IGNORE INTO ipfs_mappings (metadataHash, cid, createdAt) VALUES (?, ?, ?)',
    args: [metadataHash, cid, new Date().toISOString()]
  });
}

export async function getCidByMetadataHash(
  db: any,
  metadataHash: string
): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT cid FROM ipfs_mappings WHERE metadataHash = ?',
    args: [metadataHash]
  });
  const row = result.rows[0];
  return row?.cid || null;
}