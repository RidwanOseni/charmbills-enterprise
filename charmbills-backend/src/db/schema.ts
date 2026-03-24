// charmbills-backend/src/db/schema.ts
import { EngagementType, ScrollPolicyType } from '@shared/types';
import { Database } from 'sqlite3';

export interface PlanCache {
  appId: string;
  nftUtxoId: string;
  ticker: string;
  role: string;
  compensationSats: number;
  payPeriodSeconds: number;
  metadataHash: string;
  scrollPolicy: ScrollPolicyType;
  lastIndexedBlock: number;
  createdAt: string;
  updatedAt: string;
  employerAddress: string;  // Add this - who owns this plan
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
}

// Database setup
export async function initDatabase(db: Database): Promise<void> {
  await db.exec(`
    -- Companies table FIRST (so plans can reference it)
    CREATE TABLE IF NOT EXISTS companies (
      employerAddress TEXT PRIMARY KEY,
      treasuryHexDest TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    -- Plans table with foreign key to companies
    CREATE TABLE IF NOT EXISTS plans (
      appId TEXT PRIMARY KEY,
      nftUtxoId TEXT UNIQUE NOT NULL,
      ticker TEXT NOT NULL,
      role TEXT,
      compensationSats INTEGER NOT NULL,
      payPeriodSeconds INTEGER NOT NULL,
      metadataHash TEXT NOT NULL,
      scrollPolicy INTEGER NOT NULL,
      lastIndexedBlock INTEGER NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      employerAddress TEXT NOT NULL,
      FOREIGN KEY (employerAddress) REFERENCES companies(employerAddress)
    );

    -- Workers table
    CREATE TABLE IF NOT EXISTS workers (
      walletAddress TEXT,
      name TEXT,
      planId TEXT,
      engagementType INTEGER NOT NULL,
      status TEXT NOT NULL,
      lastMintedPeriod TEXT,
      currentTokenUtxo TEXT,
      expiresAt TEXT,
      PRIMARY KEY (walletAddress, planId),
      FOREIGN KEY (planId) REFERENCES plans(appId)
    );

    -- Indexes
    CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
    CREATE INDEX IF NOT EXISTS idx_plans_ticker ON plans(ticker);
    CREATE INDEX IF NOT EXISTS idx_plans_employer ON plans(employerAddress);

    -- IPFS mappings
    CREATE TABLE IF NOT EXISTS ipfs_mappings (
      metadataHash TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    -- Multi-sig transactions
    CREATE TABLE IF NOT EXISTS multisig_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      employerAddress TEXT NOT NULL,
      commitTxHex TEXT NOT NULL,
      spellTxHex TEXT NOT NULL,
      threshold INTEGER NOT NULL,
      signers_json TEXT DEFAULT '[]',
      status TEXT DEFAULT 'pending',
      createdAt TEXT NOT NULL,
      FOREIGN KEY (employerAddress) REFERENCES companies(employerAddress)
    );
  `);
}

// Helper functions
export async function saveCompanyConfig(
  db: Database,
  employerAddress: string,
  treasuryHexDest: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO companies (employerAddress, treasuryHexDest, createdAt)
       VALUES (?, ?, ?)`,
      [employerAddress, treasuryHexDest, new Date().toISOString()],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

export async function getCompanyConfig(
  db: Database,
  employerAddress: string
): Promise<{ treasuryHexDest: string } | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT treasuryHexDest FROM companies WHERE employerAddress = ?',
      [employerAddress],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

export async function savePlanRecord(
  db: Database,
  plan: PlanCache
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT OR REPLACE INTO plans 
       (appId, nftUtxoId, ticker, role, compensationSats, payPeriodSeconds, 
        metadataHash, scrollPolicy, lastIndexedBlock, createdAt, updatedAt, employerAddress)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        plan.appId,
        plan.nftUtxoId,
        plan.ticker,
        plan.role,
        plan.compensationSats,
        plan.payPeriodSeconds,
        plan.metadataHash,
        plan.scrollPolicy,
        plan.lastIndexedBlock,
        plan.createdAt,
        plan.updatedAt,
        plan.employerAddress
      ],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}