import { Request, Response } from 'express';
import axios from 'axios';
const db = new (require('sqlite3').Database)('./payroll.db');

const MEMPOOL_API = "https://mempool.space/testnet4/api";

/**
 * GET /api/workers
 * Fetches all workers for the Workforce Registry table
 * Includes name field from IPFS enrichment and department ticker from plans table
 */
export async function getWorkers(req: Request, res: Response) {
    const query = `
        SELECT 
            w.walletAddress, 
            w.name, 
            w.role,
            w.engagementType, 
            w.status, 
            w.lastMintedPeriod,
            w.salarySats,
            p.department as department 
        FROM workers w
        LEFT JOIN plans p ON w.planId = p.appId
    `;

    db.all(query, [], (err: Error | null, rows: any[]) => {
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

/**
 * Helper function to fetch transaction hex from mempool
 */
async function fetchTransactionHex(txid: string): Promise<string> {
    const response = await axios.get(`${MEMPOOL_API}/tx/${txid}/hex`, { responseType: 'text' });
    return response.data;
}

/**
 * GET /api/workers/by-address/:address
 * PRODUCTION GRADE FIX: Uses LEFT JOIN to ensure worker data is returned
 * even if the associated Departmental Plan NFT has not been minted yet.
 * Fetches a single worker's record including historical audit trail for Payment History feature
 * Returns historicalTokens column for the "Payment History" UI card
 * 
 * MODIFIED: Joins with ipfs_mappings table to provide the CID required for
 * the frontend to load salary and role data from IPFS.
 * MODIFIED: Added planNftId and planNftHex for WASM verification context
 */
export async function getWorkerByAddress(req: Request, res: Response) {
    const { address } = req.params;

    if (!address) {
        return res.status(400).json({ error: 'Address parameter is required' });
    }

    const query = `
        SELECT 
            w.walletAddress, 
            w.name, 
            w.role,
            w.engagementType, 
            w.status, 
            w.lastMintedPeriod,
            w.currentTokenUtxo,
            w.expiresAt,
            w.salarySats,
            w.metadataHash,
            w.updatedAt,
            w.historicalTokens,
            p.metadataHash as planMetadataHash, 
            p.department,
            p.ticker,
            p.payPeriodSeconds,
            p.scrollPolicy,
            p.nftUtxoId as planNftId,
            i.cid as metadataCid
        FROM workers w 
        LEFT JOIN plans p ON w.planId = p.appId 
        LEFT JOIN ipfs_mappings i ON p.metadataHash = i.metadataHash
        WHERE w.walletAddress = ? 
        ORDER BY w.updatedAt DESC
        LIMIT 1
    `;

    db.get(query, [address], async (err: Error | null, row: any) => {
        if (err) {
            console.error('[WORKERS API] Database error in getWorkerByAddress:', err.message);
            return res.status(500).json({ 
                error: "Internal database error", 
                details: err.message 
            });
        }

        if (!row) {
            console.warn(`[WORKERS API] Worker lookup failed for address: ${address}`);
            return res.status(404).json({ error: "Worker record not found in registry" });
        }

        // If ticker is null, the worker exists but the Plan NFT hasn't been minted yet
        if (!row.ticker) {
            console.log(`[WORKERS API] Worker found, but Departmental Plan is not yet on-chain.`);
        }
        
        // Ensure historicalTokens is always a valid JSON array
        if (!row.historicalTokens) {
            row.historicalTokens = "[]";
        } else if (typeof row.historicalTokens === 'string') {
            try {
                row.historicalTokens = JSON.parse(row.historicalTokens);
            } catch (e) {
                console.error('[WORKERS API] Failed to parse historicalTokens:', e);
                row.historicalTokens = [];
            }
        }
        
        // Fetch the Plan NFT hex for WASM verification context
        let planNftHex = null;
        if (row.planNftId) {
            try {
                const [txid] = row.planNftId.split(':');
                console.log(`[WORKERS API] Fetching hex for Plan NFT txid: ${txid}`);
                const hexResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/hex`, { responseType: 'text' });
                planNftHex = hexResponse.data;
                console.log(`[WORKERS API] Fetched Plan NFT hex, length: ${planNftHex.length}`);
            } catch (fetchError: any) {
                console.error(`[WORKERS API] Failed to fetch Plan NFT hex: ${fetchError.message}`);
                // Continue without planNftHex - don't fail the request
            }
        } else {
            console.log(`[WORKERS API] No planNftId found for worker`);
        }
        
        // Add planNftHex to the response
        const responseRow = {
            ...row,
            planNftHex
        };
        
        console.log(`[WORKERS API] Returning response with planNftHex: ${!!planNftHex}`);
        res.json(responseRow);
    });
}

/**
 * POST /api/workers/update-token-utxo
 * Updates a worker's currentTokenUtxo with the actual broadcasted transaction ID
 * Called by frontend after successful broadcast
 */
export async function updateWorkerTokenUtxo(req: Request, res: Response) {
    const { walletAddress, planId, actualTxid, voutIndex } = req.body;
    
    if (!walletAddress || !planId || !actualTxid) {
        return res.status(400).json({ error: 'Missing required fields: walletAddress, planId, actualTxid' });
    }
    
    const vout = voutIndex !== undefined ? voutIndex : 0;
    const tokenUtxo = `${actualTxid}:${vout}`;
    const lastMintedPeriod = new Date().toISOString();
    
    console.log(`[WORKERS API] Updating worker ${walletAddress} token UTXO to: ${tokenUtxo}`);
    
    db.run(
        `UPDATE workers 
         SET currentTokenUtxo = ?, 
             lastMintedPeriod = ?,
             updatedAt = ?
         WHERE walletAddress = ? AND planId = ?`,
        [tokenUtxo, lastMintedPeriod, new Date().toISOString(), walletAddress, planId],
        function(err: Error | null) {
            if (err) {
                console.error('[WORKERS API] Failed to update token UTXO:', err);
                return res.status(500).json({ error: err.message });
            }
            console.log(`[WORKERS API] ✅ Updated worker ${walletAddress} with token UTXO: ${tokenUtxo}`);
            res.json({ success: true, tokenUtxo });
        }
    );
}