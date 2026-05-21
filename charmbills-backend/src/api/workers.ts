import { Request, Response } from 'express';
import axios from 'axios';
import { syncIndexer } from '../lib/indexer';
import { turso } from '../db/client';

const MEMPOOL_API = "https://mempool.space/testnet4/api";

// Helper to convert Turso result row to object with correct types
function rowToObject(row: Record<string, any>): any {
    const obj: any = {};
    for (const [key, value] of Object.entries(row)) {
        obj[key] = value;
    }
    return obj;
}

/**
 * GET /api/workers
 * Fetches all workers for the Workforce Registry table
 * Includes name field from IPFS enrichment and department ticker from plans table
 * 
 * FIX: Non-blocking sync - fire and forget, don't await
 */
export async function getWorkers(req: Request, res: Response) {
    // FIRE AND FORGET: Start sync in background, don't await
    syncIndexer(turso, 5).catch((syncError) => {
        console.error('[WORKERS API] Background sync failed (non-critical):', syncError);
    });
    console.log('[WORKERS API] Background sync triggered (non-blocking)');
    
    const query = `
        SELECT 
            w.walletAddress, 
            w.name, 
            w.role,
            w.engagementType, 
            w.status, 
            w.lastMintedPeriod,
            w.salarySats,
            w.planId,
            p.department as department 
        FROM workers w
        LEFT JOIN plans p ON w.planId = p.appId
    `;

    try {
        const result = await turso.execute({ sql: query, args: [] });
        const rows = result.rows.map(row => rowToObject(row));

        console.log('[WORKERS API] First worker raw data:', rows[0]);

        res.json(rows);
    } catch (err: any) {
        console.error('[WORKERS API] Database error:', err);
        res.status(500).json({ error: err.message });
    }
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
    try {
        const result = await turso.execute({
            sql: `INSERT INTO workers (name, walletAddress, planId, role, engagementType, status, salarySats, updatedAt) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [
                name, 
                walletAddress, 
                planId, 
                workerRole, 
                workerEngagementType, 
                workerStatus, 
                workerSalary,
                new Date().toISOString()
            ]
        });
        
        console.log(`[WORKERS API] ✅ Worker added successfully with ID: ${result.lastInsertRowid}`);
        res.status(201).json({ 
            success: true, 
            id: result.lastInsertRowid,
            message: 'Worker added to registry successfully'
        });
    } catch (err: any) {
        console.error('[WORKERS API] Database error:', err);
        res.status(500).json({ error: err.message });
    }
}

/**
 * GET /api/dashboard/stats
 * Calculates "Next Payroll Run" based on the earliest expiration in the cache [3]
 */
export async function getDashboardStats(req: Request, res: Response) {
    try {
        const result = await turso.execute({
            sql: 'SELECT MIN(lastMintedPeriod) as nextRun FROM workers WHERE status = ?',
            args: ['active']
        });
        const row = result.rows[0];
        // Returns null for "Waiting for first hire" state
        res.json({
            nextRun: row?.nextRun || null
        });
    } catch (err: any) {
        console.error('[DASHBOARD API] Database error:', err);
        res.status(500).json({ error: err.message });
    }
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

    try {
        const result = await turso.execute({ sql: query, args: [address] });
        const row = result.rows[0];
        
        if (!row) {
            return res.status(404).json({ error: "Worker record not found" });
        }
        
        res.json(rowToObject(row));
    } catch (err: any) {
        console.error('[WORKERS API] Database error:', err);
        res.status(500).json({ error: err.message });
    }
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
 * 
 * FIX: Non-blocking sync - fire and forget, don't await
 */
export async function getWorkerByAddress(req: Request, res: Response) {
    const { address } = req.params;

    if (!address) {
        return res.status(400).json({ error: 'Address parameter is required' });
    }

    // FIRE AND FORGET: Start sync in background, don't await
    syncIndexer(turso, 5).catch((syncError) => {
        console.error('[WORKERS API] Background sync failed (non-critical):', syncError);
    });
    console.log('[WORKERS API] Background sync triggered (non-blocking)');

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

    try {
        const result = await turso.execute({ sql: query, args: [address] });
        let row = result.rows[0];
        
        if (!row) {
            console.warn(`[WORKERS API] Worker lookup failed for address: ${address}`);
            return res.status(404).json({ error: "Worker record not found in registry" });
        }
        
        // Convert row to object
        let workerRecord = rowToObject(row);
        
        // If ticker is null, the worker exists but the Plan NFT hasn't been minted yet
        if (!workerRecord.ticker) {
            console.log(`[WORKERS API] Worker found, but Departmental Plan is not yet on-chain.`);
        }
        
        // Ensure historicalTokens is always a valid JSON array
        if (!workerRecord.historicalTokens) {
            workerRecord.historicalTokens = [];
        } else if (typeof workerRecord.historicalTokens === 'string') {
            try {
                workerRecord.historicalTokens = JSON.parse(workerRecord.historicalTokens);
            } catch (e) {
                console.error('[WORKERS API] Failed to parse historicalTokens:', e);
                workerRecord.historicalTokens = [];
            }
        }
        
        // Fetch the Plan NFT hex for WASM verification context
        let planNftHex = null;
        if (workerRecord.planNftId) {
            try {
                const [txid] = workerRecord.planNftId.split(':');
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
            ...workerRecord,
            planNftHex
        };
        
        console.log(`[WORKERS API] Returning response with planNftHex: ${!!planNftHex}`);
        res.json(responseRow);
    } catch (err: any) {
        console.error('[WORKERS API] Database error in getWorkerByAddress:', err.message);
        res.status(500).json({ 
            error: "Internal database error", 
            details: err.message 
        });
    }
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
    
    try {
        await turso.execute({
            sql: `UPDATE workers 
                  SET currentTokenUtxo = ?, 
                      lastMintedPeriod = ?,
                      updatedAt = ?
                  WHERE walletAddress = ? AND planId = ?`,
            args: [tokenUtxo, lastMintedPeriod, new Date().toISOString(), walletAddress, planId]
        });
        
        console.log(`[WORKERS API] ✅ Updated worker ${walletAddress} with token UTXO: ${tokenUtxo}`);
        res.json({ success: true, tokenUtxo });
    } catch (err: any) {
        console.error('[WORKERS API] Failed to update token UTXO:', err);
        res.status(500).json({ error: err.message });
    }
}