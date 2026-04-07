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
 * POST /api/workers/add
 * Adds a new worker to the registry (administrative action, no minting)
 * This creates a pending worker record that will receive tokens in the next payroll run
 * FIX: Align with schema.ts - uses planId instead of department/departmentId
 */
export async function addWorker(req: Request, res: Response) {
    // Destructure using 'planId' (which contains the department ID/appId)
    const { name, walletAddress, planId, role, engagementType, salarySats, status } = req.body;
    
    // Validate required fields - name, walletAddress, and planId are required
    if (!name || !walletAddress || !planId) {
        console.error('[WORKERS API] Missing required fields:', { name, walletAddress, planId });
        return res.status(400).json({ error: 'Missing required fields: name, walletAddress, and planId are required' });
    }
    
    console.log('[WORKERS API] Adding worker:', { name, walletAddress, planId, role, engagementType, salarySats });
    
    // Use provided values or defaults
    const workerRole = role || 'Team Member';
    const workerEngagementType = engagementType || 'full-time';
    const workerStatus = status || 'pending';
    const workerSalary = salarySats || 1000; // Minimal sats per period
    
    // FIX: Use planId (not department/departmentId) to match schema.ts
    db.run(
        `INSERT INTO workers (name, walletAddress, planId, role, engagementType, status, salarySats, updatedAt) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            name, 
            walletAddress, 
            planId, 
            workerRole, 
            workerEngagementType, 
            workerStatus, 
            workerSalary,
            new Date().toISOString()
        ],
        function(this: any, err: Error | null) {
            if (err) {
                console.error('[WORKERS API] Database error:', err);
                return res.status(500).json({ error: err.message });
            }
            
            console.log(`[WORKERS API] ✅ Worker added successfully with ID: ${this.lastID}`);
            res.status(201).json({ 
                success: true, 
                id: this.lastID,
                message: 'Worker added to registry successfully'
            });
        }
    );
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