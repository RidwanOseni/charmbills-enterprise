// charmbills-backend/src/db/schema.ts
import { EngagementType, ScrollPolicyType } from '@shared/types';
import { Database } from 'sqlite3'; // or pg for PostgreSQL

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
}

export interface WorkerCache {
  walletAddress: string;
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
      updatedAt TEXT NOT NULL
    );

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

    CREATE INDEX IF NOT EXISTS idx_workers_status ON workers(status);
    CREATE INDEX IF NOT EXISTS idx_plans_ticker ON plans(ticker);

    -- CID Mapping Table for Production Readiness
    CREATE TABLE IF NOT EXISTS ipfs_mappings (
        metadataHash TEXT PRIMARY KEY,
        cid TEXT NOT NULL,
        createdAt TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_ipfs_hash ON ipfs_mappings(metadataHash);

    -- Multi-signature Transaction Tracking for Corporate Governance [1]
    CREATE TABLE IF NOT EXISTS multisig_transactions (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,          -- 'plan-creation' | 'vault-freeze' | 'payment-release'
      category TEXT NOT NULL,      -- 'operational' (2-of-3) | 'corporate' (3-of-5)
      description TEXT,            -- e.g., 'Terminate Alex Chen & Freeze Vault'
      worker_address TEXT,         -- Direct link to worker for RBAC
      commitTxHex TEXT NOT NULL,   -- PSBT hex
      spellTxHex TEXT NOT NULL,    -- PSBT hex
      threshold INTEGER NOT NULL,  -- 2 or 3
      signers_json TEXT DEFAULT '[]', -- JSON array of who has already signed
      status TEXT DEFAULT 'pending', -- 'pending' | 'broadcasted' | 'failed'
      createdAt TEXT NOT NULL
    );
  `);
}