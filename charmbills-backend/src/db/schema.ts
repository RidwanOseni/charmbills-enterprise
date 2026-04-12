// charmbills-backend/src/db/schema.ts
import { EngagementType, ScrollPolicyType } from '@shared/types';
import { Database } from 'sqlite3';

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

// Database setup
export async function initDatabase(db: Database): Promise<void> {
  console.log('[DB INIT] Creating database tables...');
  
  return new Promise((resolve, reject) => {
    db.serialize(() => {
      // Create companies table
      db.run(`
        CREATE TABLE IF NOT EXISTS companies (
            employerAddress TEXT PRIMARY KEY,
            treasuryAddress TEXT NOT NULL,
            treasuryHexDest TEXT NOT NULL,
            createdAt TEXT NOT NULL,
            updatedAt TEXT
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating companies:', err.message);
        else console.log('[DB INIT] ✅ companies table ready');
      });

      // Create locked_utxos table
      db.run(`
        CREATE TABLE IF NOT EXISTS locked_utxos (
            utxoId TEXT PRIMARY KEY,
            employerAddress TEXT NOT NULL,
            lockedAt TEXT NOT NULL,
            expiresAt TEXT NOT NULL
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating locked_utxos:', err.message);
        else console.log('[DB INIT] ✅ locked_utxos table ready');
      });

      // Create plans table
      db.run(`
        CREATE TABLE IF NOT EXISTS plans (
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
            lastIndexedBlock INTEGER DEFAULT 0,
            createdAt TEXT NOT NULL,
            updatedAt TEXT NOT NULL
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating plans:', err.message);
        else console.log('[DB INIT] ✅ plans table ready');
      });

      // Create workers table with historicalTokens column for payment history
      db.run(`
        CREATE TABLE IF NOT EXISTS workers (
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
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating workers:', err.message);
        else console.log('[DB INIT] ✅ workers table ready');
      });

      // Create ipfs_mappings table
      db.run(`
        CREATE TABLE IF NOT EXISTS ipfs_mappings (
            metadataHash TEXT PRIMARY KEY,
            cid TEXT NOT NULL,
            createdAt TEXT NOT NULL
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating ipfs_mappings:', err.message);
        else console.log('[DB INIT] ✅ ipfs_mappings table ready');
      });

      // Create multisig_transactions table
      db.run(`
        CREATE TABLE IF NOT EXISTS multisig_transactions (
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
        )
      `, (err) => {
        if (err) console.error('[DB INIT] Error creating multisig_transactions:', err.message);
        else console.log('[DB INIT] ✅ multisig_transactions table ready');
      });

      // Create indexes after tables are created
      const indexes = [
        `CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status)`,
        `CREATE INDEX IF NOT EXISTS idx_workers_plan ON workers(planId)`,
        `CREATE INDEX IF NOT EXISTS idx_plans_ticker ON plans(ticker)`,
        `CREATE INDEX IF NOT EXISTS idx_plans_employer ON plans(employerAddress)`,
        `CREATE INDEX IF NOT EXISTS idx_plans_nftUtxo ON plans(nftUtxoId)`,
        `CREATE INDEX IF NOT EXISTS idx_plans_remaining ON plans(remaining)`,
        `CREATE INDEX IF NOT EXISTS idx_locked_utxos_employer ON locked_utxos(employerAddress)`,
        `CREATE INDEX IF NOT EXISTS idx_locked_utxos_expires ON locked_utxos(expiresAt)`,
        `CREATE INDEX IF NOT EXISTS idx_ipfs_hash ON ipfs_mappings(metadataHash)`,
        `CREATE INDEX IF NOT EXISTS idx_multisig_employer ON multisig_transactions(employerAddress)`,
        `CREATE INDEX IF NOT EXISTS idx_multisig_status ON multisig_transactions(status)`
      ];

      let indexCount = 0;
      indexes.forEach((idxQuery) => {
        db.run(idxQuery, (err) => {
          if (err) console.error(`[DB INIT] Error creating index: ${err.message}`);
          indexCount++;
          if (indexCount === indexes.length) {
            console.log('[DB INIT] Database initialization complete');
            resolve();
          }
        });
      });
    });
  });
}

// ============================================================
// COMPANY HELPERS
// ============================================================

export async function saveCompanyConfig(
  db: Database,
  employerAddress: string,
  treasuryAddress: string,
  treasuryHexDest: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    db.run(
      `INSERT OR REPLACE INTO companies (employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?)`,
      [employerAddress, treasuryAddress, treasuryHexDest, now, now],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function getCompanyConfig(
  db: Database,
  employerAddress: string
): Promise<CompanyRecord | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
      [employerAddress],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export async function listCompanies(
  db: Database,
  limit: number = 50,
  offset: number = 0
): Promise<CompanyRecord[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      [limit, offset],
      (err: Error | null, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export async function deleteCompany(
  db: Database,
  employerAddress: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM companies WHERE employerAddress = ?',
      [employerAddress],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

// ============================================================
// UTXO LOCK HELPERS
// ============================================================

export async function lockUtxo(
  db: Database,
  utxoId: string,
  employerAddress: string,
  ttlSeconds: number = 3600
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    
    db.run(
      `INSERT INTO locked_utxos (utxoId, employerAddress, lockedAt, expiresAt)
       VALUES (?, ?, ?, ?)`,
      [utxoId, employerAddress, now, expiresAt],
      (err: Error | null) => {
        if (err) {
          if (err.message.includes('UNIQUE constraint failed')) {
            resolve(false);
          } else {
            reject(err);
          }
        } else {
          resolve(true);
        }
      }
    );
  });
}

export async function unlockUtxo(
  db: Database,
  utxoId: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM locked_utxos WHERE utxoId = ?',
      [utxoId],
      function(err: Error | null) {
        if (err) reject(err);
        else resolve(this.changes > 0);
      }
    );
  });
}

export async function isUtxoLocked(
  db: Database,
  utxoId: string
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT utxoId FROM locked_utxos WHERE utxoId = ? AND expiresAt > ?',
      [utxoId, new Date().toISOString()],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(!!row);
      }
    );
  });
}

export async function cleanupExpiredLocks(
  db: Database
): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM locked_utxos WHERE expiresAt <= ?',
      [new Date().toISOString()],
      function(err: Error | null) {
        if (err) reject(err);
        else resolve(this.changes);
      }
    );
  });
}

export async function getLockedUtxosForEmployer(
  db: Database,
  employerAddress: string
): Promise<LockedUtxo[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT utxoId, employerAddress, lockedAt, expiresAt FROM locked_utxos WHERE employerAddress = ? AND expiresAt > ?',
      [employerAddress, new Date().toISOString()],
      (err: Error | null, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

// ============================================================
// PLAN HELPERS
// ============================================================

export async function savePlanRecord(
  db: Database,
  plan: PlanCache
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO plans 
       (appId, nftUtxoId, ticker, employerAddress, department, 
        payPeriodSeconds, metadataHash, scrollPolicy, remaining, 
        lastIndexedBlock, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.appId,
        plan.nftUtxoId,
        plan.ticker,
        plan.employerAddress,
        plan.department || null,
        plan.payPeriodSeconds,
        plan.metadataHash,
        plan.scrollPolicy,
        plan.remaining,
        plan.lastIndexedBlock || 0,
        plan.createdAt,
        plan.updatedAt
      ],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function getPlanByAppId(
  db: Database,
  appId: string
): Promise<PlanCache | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM plans WHERE appId = ?',
      [appId],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export async function getPlanByNftUtxo(
  db: Database,
  nftUtxoId: string
): Promise<PlanCache | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM plans WHERE nftUtxoId = ?',
      [nftUtxoId],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export async function getPlansByEmployer(
  db: Database,
  employerAddress: string,
  limit: number = 50,
  offset: number = 0
): Promise<PlanCache[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM plans WHERE employerAddress = ? ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      [employerAddress, limit, offset],
      (err: Error | null, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export async function updatePlanRemaining(
  db: Database,
  appId: string,
  newRemaining: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE plans SET remaining = ?, updatedAt = ? WHERE appId = ?',
      [newRemaining, new Date().toISOString(), appId],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function updatePlanLastIndexedBlock(
  db: Database,
  appId: string,
  blockNumber: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE plans SET lastIndexedBlock = ?, updatedAt = ? WHERE appId = ?',
      [blockNumber, new Date().toISOString(), appId],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

// ============================================================
// WORKER HELPERS
// ============================================================

export async function saveWorkerRecord(
  db: Database,
  worker: WorkerCache
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO workers 
       (walletAddress, name, planId, engagementType, status, lastMintedPeriod, 
        currentTokenUtxo, expiresAt, salarySats, role, metadataHash, updatedAt, historicalTokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function getWorkersByPlan(
  db: Database,
  planId: string
): Promise<WorkerCache[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT * FROM workers WHERE planId = ? ORDER BY status DESC, name ASC',
      [planId],
      (err: Error | null, rows: any[]) => {
        if (err) reject(err);
        else resolve(rows || []);
      }
    );
  });
}

export async function getWorkerByAddress(
  db: Database,
  walletAddress: string
): Promise<WorkerCache | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT * FROM workers WHERE walletAddress = ? ORDER BY updatedAt DESC LIMIT 1',
      [walletAddress],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export async function updateWorkerStatus(
  db: Database,
  walletAddress: string,
  planId: string,
  status: 'active' | 'terminated' | 'pending'
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE workers SET status = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
      [status, new Date().toISOString(), walletAddress, planId],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function updateWorkerToken(
  db: Database,
  walletAddress: string,
  planId: string,
  tokenUtxo: string,
  expiresAt: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE workers SET currentTokenUtxo = ?, expiresAt = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
      [tokenUtxo, expiresAt, new Date().toISOString(), walletAddress, planId],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function updateWorkerMetadata(
  db: Database,
  walletAddress: string,
  planId: string,
  metadataHash: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'UPDATE workers SET metadataHash = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
      [metadataHash, new Date().toISOString(), walletAddress, planId],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

/**
 * ADDED: Targeted update for post-mint worker record
 * This preserves the worker's name and role from the registry
 * Only updates status, token UTXO, expiry, and last minted period
 * 
 * @param db - Database connection
 * @param walletAddress - Worker's wallet address
 * @param planId - Plan ID (appId)
 * @param tokenUtxo - The newly minted token UTXO ID
 * @param expiresAt - Expiration date of the token
 * @param lastMintedPeriod - Date string of when the token was minted
 */
export async function updateWorkerPostMint(
  db: Database,
  walletAddress: string,
  planId: string,
  tokenUtxo: string,
  expiresAt: string,
  lastMintedPeriod: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const query = `
      UPDATE workers 
      SET status = 'active', 
          currentTokenUtxo = ?, 
          expiresAt = ?, 
          lastMintedPeriod = ?,
          updatedAt = ?
      WHERE walletAddress = ? AND planId = ?
    `;
    db.run(query, [
      tokenUtxo,
      expiresAt,
      lastMintedPeriod,
      new Date().toISOString(),
      walletAddress,
      planId
    ], (err: Error | null) => err ? reject(err) : resolve());
  });
}

/**
 * Add a spent token UTXO to worker's historicalTokens audit trail
 * Used for Payment History feature
 */
export async function addHistoricalToken(
  db: Database,
  walletAddress: string,
  planId: string,
  spentUtxo: string,
  timestamp: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    // First get current historicalTokens
    db.get(
      'SELECT historicalTokens FROM workers WHERE walletAddress = ? AND planId = ?',
      [walletAddress, planId],
      (err: Error | null, row: any) => {
        if (err) return reject(err);
        
        let history: any[] = [];
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
        db.run(
          'UPDATE workers SET historicalTokens = ?, updatedAt = ? WHERE walletAddress = ? AND planId = ?',
          [JSON.stringify(history), new Date().toISOString(), walletAddress, planId],
          (err: Error | null) => err ? reject(err) : resolve()
        );
      }
    );
  });
}

// ============================================================
// IPFS MAPPING HELPERS
// ============================================================

export async function saveIpfsMapping(
  db: Database,
  metadataHash: string,
  cid: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO ipfs_mappings (metadataHash, cid, createdAt) VALUES (?, ?, ?)',
      [metadataHash, cid, new Date().toISOString()],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function getCidByMetadataHash(
  db: Database,
  metadataHash: string
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT cid FROM ipfs_mappings WHERE metadataHash = ?',
      [metadataHash],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row?.cid || null);
      }
    );
  });
}