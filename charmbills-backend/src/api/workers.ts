import { Request, Response } from 'express';
const db = new (require('sqlite3').Database)('./payroll.db');

/**
 * GET /api/workers
 * Fetches all workers for the Workforce Registry table
 * Includes name field from IPFS enrichment to display properly in dashboard
 */
export async function getWorkers(req: Request, res: Response) {
    // Select the 'name' field so it appears in the Registry card
    db.all('SELECT walletAddress, name, engagementType, status, lastMintedPeriod FROM workers', [], (err: Error | null, rows: any[]) => {
        if (err) {
            console.error('[WORKERS API] Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
}

/**
 * GET /api/dashboard/stats
 * Calculates "Next Payroll Run" based on the earliest expiration in the cache [3]
 */
export async function getDashboardStats(req: Request, res: Response) {
    db.get('SELECT MIN(lastMintedPeriod) as nextRun FROM workers WHERE status = "active"', [], (err: Error | null, row: any) => {
        if (err) {
            console.error('[DASHBOARD API] Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        // Returns null for "Waiting for first hire" state
        res.json({
            nextRun: row?.nextRun || null
        });
    });
}

/**
 * GET /api/workers/:address
 * Fetches worker metadata including Plan NFT details and IPFS CID for decryption
 * Used by Worker Portal to identify which Plan NFT and encrypted data are associated
 */
export async function getWorkerMetadata(req: Request, res: Response) {
    const { address } = req.params;
    
    // Join workers, plans, and ipfs_mappings to get the CID needed for decryption
    const query = `
        SELECT w.*, p.metadataHash, i.cid 
        FROM workers w
        JOIN plans p ON w.planId = p.appId
        JOIN ipfs_mappings i ON p.metadataHash = i.metadataHash
        WHERE w.walletAddress = ?
    `;

    db.get(query, [address], (err: Error | null, row: any) => {
        if (err) {
            console.error('[WORKERS API] Database error:', err);
            return res.status(500).json({ error: err.message });
        }
        if (!row) {
            return res.status(404).json({ error: "Worker record not found" });
        }
        res.json(row);
    });
}