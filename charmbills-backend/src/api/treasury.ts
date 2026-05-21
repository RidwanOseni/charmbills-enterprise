import { Request, Response } from 'express';
import axios from 'axios';
import { fetchTransactionHex } from '../lib/utxo-manager';
import { generateUnsignedTransactions } from '../charms/proverClient';
import * as crypto from 'crypto';
import * as constants from '@shared/constants';
import { SpellRequest } from '@shared/types';
import * as scrolls from '../bitcoin/scrollsClient';

// Mempool API for on-chain queries
const MEMPOOL_API = "https://mempool.space/testnet4/api";

// --------------------------------------------------------------------------------
// Database Helper - Company Lookup (Turso version)
// --------------------------------------------------------------------------------

interface CompanyRecord {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  vaultAddress: string;        // ADDED: Unified company Scroll vault
  createdAt: string;
  updatedAt?: string;
}

/**
 * Get company configuration by employer address (Turso version)
 * UPDATED: Now includes vaultAddress
 */
async function getCompanyByEmployer(db: any, employerAddress: string): Promise<CompanyRecord | null> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, vaultAddress, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
  return result.rows[0] || null;
}

/**
 * Helper to fetch balance from mempool for a single address
 */
async function fetchBalanceFromMempool(address: string): Promise<number> {
  if (!address) return 0;
  
  try {
    const utxoRes = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 10000
    });
    const utxos = utxoRes.data;
    const balance = utxos.reduce((sum: number, u: any) => sum + u.value, 0);
    console.log(`[TREASURY API] Fetched balance for ${address.substring(0, 16)}...: ${balance} sats`);
    return balance;
  } catch (mempoolError: any) {
    console.error(`[TREASURY API] ⚠️ Failed to fetch balance from mempool:`, mempoolError.message);
    return 0;
  }
}

/**
 * Helper to get departmental allocations (liabilities) grouped by department
 */
async function getDepartmentalAllocations(db: any, employerAddress: string): Promise<any[]> {
  const result = await db.execute({
    sql: `SELECT 
            p.department, 
            p.appId,
            COALESCE(SUM(w.salarySats), 0) as totalAllocation,
            COUNT(w.walletAddress) as workerCount
          FROM plans p
          LEFT JOIN workers w ON w.planId = p.appId AND w.status = 'active'
          WHERE p.employerAddress = ?
          GROUP BY p.appId, p.department`,
    args: [employerAddress]
  });
  
  return result.rows || [];
}

/**
 * GET /api/treasury/pending
 * Fetches all pending multisig actions requiring board approval [2]
 */
export async function getPendingApprovals(req: Request, res: Response) {
    const db = req.app.locals.db;
    
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM multisig_transactions WHERE status IN (?, ?) ORDER BY createdAt DESC',
            args: ['pending', 'ready']
        });
        
        const rows = result.rows || [];
        
        // Parse signers_json back to array for frontend
        const parsedRows = rows.map((row: any) => ({
            ...row,
            signers: row.signers_json ? JSON.parse(row.signers_json) : []
        }));
        
        res.json(parsedRows);
    } catch (error: any) {
        console.error('[TERMINATION API] Failed to fetch pending approvals:', error);
        res.status(500).json({ error: 'Failed to fetch pending approvals' });
    }
}

/**
 * GET /api/treasury/audit
 * Retrieves the historical record of treasury actions for the Audit Trail.
 * Ensures the system is "Derivable" from the database state. [Source 850]
 */
export async function getAuditLogs(req: Request, res: Response) {
    const db = req.app.locals.db;
    
    try {
        const result = await db.execute({
            sql: 'SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50',
            args: []
        });
        
        const rows = result.rows || [];
        res.json(rows);
    } catch (error: any) {
        console.error('[TREASURY API] Failed to fetch audit logs:', error);
        res.status(500).json({ error: 'Failed to fetch audit logs' });
    }
}

/**
 * GET /api/treasury/stats/:employerAddress
 * Aggregates vault liquidity and allocations for the treasury dashboard
 * 
 * SIMPLIFIED: Now queries a single vault per company from the companies table.
 * No longer loops through departments to derive vault addresses.
 * 
 * - totalLockedSats: ACTUAL physical BTC in the company's unified vault (queried from mempool)
 * - employeeAllocationSats: LIABILITY (sum of active salaries across all departments)
 * - requiredFundingSats: TARGET (allocation + buffer) - Desired State
 * - freelancerEscrowSats: Sats held in escrow for freelancers
 * - vaultAddress: Unified Bitcoin vault address for this company
 * - allocations: Departmental breakdown of allocations (for UI display)
 * 
 * MODIFIED: Uses vaultAddress from companies table instead of deriving from appId
 */
export async function getTreasuryStats(req: Request, res: Response) {
    const db = req.app.locals.db;
    const { employerAddress } = req.params;
    
    if (!employerAddress) {
        return res.status(400).json({ error: 'employerAddress parameter is required' });
    }
    
    console.log(`[TREASURY API] 📊 Fetching treasury stats for: ${employerAddress.substring(0, 20)}...`);
    
    try {
        // =========================================================================
        // STEP 1: Get the single vault address from the company record
        // This is the unified company vault, not department-specific
        // =========================================================================
        const company = await getCompanyByEmployer(db, employerAddress);
        
        if (!company) {
            console.warn(`[TREASURY API] No company found for employer: ${employerAddress}`);
            return res.json({
                totalLockedSats: 0,
                employeeAllocationSats: 0,
                requiredFundingSats: 0,
                freelancerEscrowSats: 0,
                vaultAddress: null,
                allocations: [],
                message: 'Company not found. Please complete onboarding first.'
            });
        }
        
        const vaultAddress = company.vaultAddress;
        const treasuryAddress = company.treasuryAddress;
        
        console.log(`[TREASURY API] Company vault address: ${vaultAddress ? vaultAddress.substring(0, 20) + '...' : 'not set'}`);
        console.log(`[TREASURY API] Treasury address: ${treasuryAddress.substring(0, 20)}...`);
        
        // =========================================================================
        // STEP 2: Fetch balance for just this ONE vault address
        // =========================================================================
        let actualLockedSats = 0;
        if (vaultAddress) {
            actualLockedSats = await fetchBalanceFromMempool(vaultAddress);
            console.log(`[TREASURY API] Actual vault balance: ${actualLockedSats} sats (${actualLockedSats / 1e8} BTC)`);
        } else {
            console.warn(`[TREASURY API] No vault address found for company`);
        }
        
        // =========================================================================
        // STEP 3: Calculate Liabilities (Source of Truth from DB) [Source 870]
        // Fetch all active workers across ALL departments for this employer
        // =========================================================================
        const workersResult = await db.execute({
            sql: `SELECT w.salarySats, w.currentTokenUtxo, w.status, p.department
                  FROM workers w
                  JOIN plans p ON w.planId = p.appId 
                  WHERE w.status = 'active' AND p.employerAddress = ?`,
            args: [employerAddress]
        });
        
        const workers = workersResult.rows || [];
        
        console.log(`[TREASURY API] Found ${workers.length} active workers across all departments`);
        
        // Calculate total employee allocation (sum of all active worker salaries) - LIABILITY
        const employeeAllocationSats = workers.reduce((sum: number, w: any) => sum + (w.salarySats || 0), 0);
        
        // For demo, freelancer escrow is 0 (can be extended later)
        const freelancerEscrowSats = 0;
        
        // Buffer for transaction fees and operational costs (5% buffer)
        const bufferSats = Math.floor(employeeAllocationSats * 0.05);
        
        // =========================================================================
        // SEPARATE "TARGET" FROM "ACTUAL"
        // requiredFundingSats: TARGET (Desired State) = allocation + buffer
        // totalLockedSats: ACTUAL (Physical BTC in the company's unified vault)
        // =========================================================================
        const requiredFundingSats = employeeAllocationSats + bufferSats + freelancerEscrowSats;
        
        // =========================================================================
        // STEP 4: Get departmental allocations for UI display
        // =========================================================================
        const allocations = await getDepartmentalAllocations(db, employerAddress);
        
        console.log(`[TREASURY API] ✅ Stats calculated:`, {
            totalLockedSats: actualLockedSats,
            employeeAllocationSats: employeeAllocationSats,
            requiredFundingSats: requiredFundingSats,
            freelancerEscrowSats: freelancerEscrowSats,
            vaultAddress: vaultAddress ? vaultAddress.substring(0, 20) + '...' : null,
            departmentsCount: allocations.length
        });
        
        res.json({
            totalLockedSats: actualLockedSats,                    // ACTUAL: Real on-chain data from company vault
            employeeAllocationSats: employeeAllocationSats,       // LIABILITY: Sum of active salaries
            requiredFundingSats: requiredFundingSats,             // TARGET: Allocation + Buffer (Desired State)
            freelancerEscrowSats: freelancerEscrowSats,           // Sats held in escrow for freelancers
            vaultAddress: vaultAddress,                           // Unified Bitcoin vault address for this company
            treasuryAddress: treasuryAddress,                     // Treasury address for gas sponsorship
            allocations: allocations                               // Departmental breakdown for UI
        });
        
    } catch (error: any) {
        console.error('[TREASURY API] ❌ Failed to fetch treasury stats:', error);
        res.status(500).json({ error: `Failed to fetch treasury stats: ${error.message}` });
    }
}

/**
 * POST /api/workers/terminate
 * Terminates a worker and creates board-level emergency pause transaction [3]
 * 
 * Body: { 
 *   walletAddress: string, 
 *   employerAddress: string, 
 *   authorityUtxo: string,
 *   fundingUtxo: string,
 *   fundingValue: number,
 *   changeAddress: string,
 *   reason?: string 
 * }
 */
export async function terminateWorker(req: Request, res: Response) {
    const db = req.app.locals.db;
    const { 
        walletAddress, 
        employerAddress, 
        authorityUtxo,      // The worker token UTXO to freeze
        fundingUtxo,        // Treasury UTXO for fees
        fundingValue,       // Value of funding UTXO
        changeAddress,      // Change address for BTC
        reason 
    } = req.body;
    
    if (!walletAddress) {
        return res.status(400).json({ error: 'walletAddress is required' });
    }
    
    if (!employerAddress) {
        return res.status(400).json({ error: 'employerAddress is required' });
    }
    
    if (!authorityUtxo) {
        return res.status(400).json({ error: 'authorityUtxo (worker token) is required' });
    }
    
    if (!fundingUtxo || !fundingValue) {
        return res.status(400).json({ error: 'fundingUtxo and fundingValue are required' });
    }
    
    if (!changeAddress) {
        return res.status(400).json({ error: 'changeAddress is required' });
    }
    
    try {
        // ----------------------------------------------------------------------------
        // Step 1: Look up company configuration for treasuryHexDest [4]
        // ----------------------------------------------------------------------------
        console.log(`[TERMINATION API] 🔍 Looking up company for employer: ${employerAddress.substring(0, 20)}...`);
        
        const company = await getCompanyByEmployer(db, employerAddress);
        
        if (!company || !company.treasuryHexDest) {
            console.error(`[TERMINATION API] ❌ Company not found for employer: ${employerAddress}`);
            return res.status(404).json({ 
                error: 'Company not registered. Please complete company onboarding first.',
                employerAddress: employerAddress.substring(0, 20) + '...'
            });
        }
        
        console.log(`[TERMINATION API] ✅ Company found:`, {
            treasuryHexDest: company.treasuryHexDest.substring(0, 30) + '...',
            treasuryAddress: company.treasuryAddress.substring(0, 20) + '...',
            vaultAddress: company.vaultAddress ? company.vaultAddress.substring(0, 20) + '...' : 'not set'
        });
        
        // Begin transaction for atomicity
        await db.execute({ sql: 'BEGIN TRANSACTION', args: [] });

        // Step 2: Off-chain: Update status in WorkerCache to prevent future funding [4]
        const updateResult = await db.execute({
            sql: 'UPDATE workers SET status = "terminated" WHERE walletAddress = ?',
            args: [walletAddress]
        });
        
        if (updateResult.rowsAffected === 0) {
            throw new Error(`Worker with address ${walletAddress} not found`);
        }

        // Step 3: Get vault details - specifically target the unspent token currently held by the worker [17]
        const vaultResult = await db.execute({
            sql: `SELECT p.appId, w.currentTokenUtxo, p.multiSigSigners, p.ticker
                  FROM workers w
                  JOIN plans p ON w.planId = p.appId
                  WHERE w.walletAddress = ? AND w.status = 'active'`,
            args: [walletAddress]
        });
        
        const vaultDetails = vaultResult.rows[0];

        if (!vaultDetails || !vaultDetails.currentTokenUtxo) {
            throw new Error('No active payroll vault found for this worker');
        }

        // Step 4: PRODUCTION FIX: Fetch raw hexes for provenance verification [5, 6]
        const [tokenTxid] = vaultDetails.currentTokenUtxo.split(':');
        const tokenTxHex = await fetchTransactionHex(tokenTxid);
        
        // Also fetch funding UTXO hex
        const [fundingTxid] = fundingUtxo.split(':');
        const fundingTxHex = await fetchTransactionHex(fundingTxid);

        // Step 5: FIX FOR TS2345: Explicitly type the request object [1]
        // This prevents the "Type 'string' is not assignable to type..." error
        const request: SpellRequest = {
            type: 'send', // Freeze operation using send spell (no outputs = freeze)
            authorityUtxo: authorityUtxo, // The worker token to freeze
            fundingUtxo: fundingUtxo,
            fundingUtxoValue: fundingValue,
            changeAddress: changeAddress,
            feeRate: constants.DEFAULT_FEE_RATE,
            outputs: [] // Empty outputs = freeze/burn operation
        };
        
        console.log(`[TERMINATION API] ⏳ Generating freeze spell with treasury hex: ${company.treasuryHexDest.substring(0, 30)}...`);
        
        // Step 6: FIX FOR TS2554: Pass treasuryHexDest as the 3rd argument [3, 6, 7]
        const freezeSpell = await generateUnsignedTransactions(
            request, 
            [tokenTxHex, fundingTxHex], // prevTxHexes: worker token + funding UTXO
            company.treasuryHexDest,    // FIX: Pass treasuryHexDest from company lookup [7]
            vaultDetails.appId          // appId for the plan
        );

        // Step 7: Create multisig transaction record for board approval
        const multisigId = crypto.randomUUID();
        const description = reason 
            ? `Emergency Freeze: Worker ${walletAddress} - ${reason}`
            : `Emergency Freeze: Worker ${walletAddress}`;

        await db.execute({
            sql: `INSERT INTO multisig_transactions 
                  (id, type, category, description, worker_address, employerAddress, commitTxHex, spellTxHex, threshold, signers_json, createdAt, status) 
                  VALUES (?, 'vault-freeze', 'corporate', ?, ?, ?, ?, ?, 3, '[]', ?, 'pending')`,
            args: [
                multisigId,
                description,
                walletAddress,
                employerAddress,
                freezeSpell.commitTxHex,
                freezeSpell.spellTxHex,
                new Date().toISOString()
            ]
        });

        // Commit transaction
        await db.execute({ sql: 'COMMIT', args: [] });

        console.log(`[TERMINATION API] ✅ Worker ${walletAddress} terminated. Board approval ID: ${multisigId}`);

        res.json({ 
            success: true,
            message: "Worker terminated off-chain. Board approval required for on-chain freeze.",
            multisigId,
            requiresBoardApproval: true,
            unsignedTxs: {
                commitHex: freezeSpell.commitTxHex,
                spellHex: freezeSpell.spellTxHex
            }
        });

    } catch (error: any) {
        // Rollback on error
        await db.execute({ sql: 'ROLLBACK', args: [] }).catch(() => {});

        console.error('[TERMINATION API] ❌ Termination failed:', error);
        
        // Handle specific error cases
        if (error.message.includes('not found')) {
            return res.status(404).json({ error: error.message });
        }
        
        res.status(500).json({ error: `Termination failed: ${error.message}` });
    }
}

/**
 * POST /api/treasury/approve
 * Allows board members to sign pending multisig transactions with RBAC verification
 * and PSBT state persistence until threshold is met, then broadcasts to network.
 * 
 * MODIFIED: Added Board Override simulation with proper RBAC verification [Source 870]
 * 
 * Body: { multisigId: string, signerAddress: string, signedCommitHex?: string, signedSpellHex?: string }
 */
export async function approveTermination(req: Request, res: Response) {
    const db = req.app.locals.db;
    const { multisigId, signerAddress, signedCommitHex, signedSpellHex } = req.body;

    if (!multisigId || !signerAddress) {
        return res.status(400).json({ error: 'multisigId and signerAddress are required' });
    }

    try {
        // =========================================================================
        // BOARD OVERRIDE SIMULATION: Verify signer is in the Board Registry [Source 870]
        // =========================================================================
        console.log(`[TERMINATION API] 🔐 Verifying board signer: ${signerAddress.substring(0, 20)}...`);
        
        // Get the plan's multiSigSigners for this transaction
        const planResult = await db.execute({
            sql: `SELECT p.multiSigSigners 
                  FROM plans p 
                  JOIN workers w ON w.planId = p.appId 
                  JOIN multisig_transactions mt ON mt.worker_address = w.walletAddress 
                  WHERE mt.id = ?`,
            args: [multisigId]
        });
        
        const planData = planResult.rows[0];

        if (!planData) {
            return res.status(404).json({ error: 'Plan not found for this transaction' });
        }

        const authorizedSigners = JSON.parse(planData.multiSigSigners || '[]');
        
        // Check if signer is in the board registry
        if (!authorizedSigners.includes(signerAddress)) {
            console.error(`[TERMINATION API] ❌ Unauthorized signer: ${signerAddress.substring(0, 20)}...`);
            return res.status(403).json({ 
                error: "Unauthorized: Wallet not in Board Registry",
                authorizedSigners: authorizedSigners.map((s: string) => s.substring(0, 20) + '...')
            });
        }
        
        console.log(`[TERMINATION API] ✅ Signer authorized`);

        // Get current transaction
        const txResult = await db.execute({
            sql: 'SELECT * FROM multisig_transactions WHERE id = ?',
            args: [multisigId]
        });
        
        const tx = txResult.rows[0];

        if (!tx) {
            return res.status(404).json({ error: 'Multisig transaction not found' });
        }

        if (tx.status === 'broadcasted') {
            return res.status(400).json({ error: 'Transaction already broadcasted' });
        }

        // Parse current signers and add new one if not already present
        const currentSigners = JSON.parse(tx.signers_json || '[]');
        if (!currentSigners.includes(signerAddress)) {
            currentSigners.push(signerAddress);
        }

        // Check if we've reached threshold (3-of-5)
        const threshold = tx.threshold || 3;
        const canBroadcast = currentSigners.length >= threshold;

        // Update the signed hexes if provided
        let updatedCommitHex = tx.commitTxHex;
        let updatedSpellHex = tx.spellTxHex;
        
        if (signedCommitHex) {
            updatedCommitHex = signedCommitHex;
        }
        if (signedSpellHex) {
            updatedSpellHex = signedSpellHex;
        }

        // Save the updated hexes to the DB with state persistence [1, 2]
        await db.execute({
            sql: `UPDATE multisig_transactions 
                  SET signers_json = ?, commitTxHex = ?, spellTxHex = ?, 
                      status = ? 
                  WHERE id = ?`,
            args: [
                JSON.stringify(currentSigners), 
                updatedCommitHex, 
                updatedSpellHex, 
                canBroadcast ? 'ready' : 'pending', 
                multisigId
            ]
        });

        // Trigger on-chain broadcast if threshold met [3-5]
        if (canBroadcast) {
            console.log(`[TERMINATION API] ✅ Threshold met for ${multisigId}. Broadcasting package...`);
            
            const rpcRequest = {
                jsonrpc: "1.0",
                id: `charmbills-multisig-broadcast-${Date.now()}`,
                method: "submitpackage",
                params: [[updatedCommitHex, updatedSpellHex]]
            };

            const rpcUser = process.env.RPC_USER;
            const rpcPassword = process.env.RPC_PASSWORD;
            const rpcPort = process.env.RPC_PORT || 48332;
            const rpcHost = process.env.RPC_HOST || '127.0.0.1';

            if (!rpcUser || !rpcPassword) {
                throw new Error('RPC credentials not configured');
            }

            const rpcRes = await axios.post(`http://${rpcHost}:${rpcPort}`, rpcRequest, {
                auth: { username: rpcUser, password: rpcPassword },
                headers: { 'Content-Type': 'application/json' },
                timeout: 30000
            });

            if (rpcRes.data.error) {
                throw new Error(`RPC error: ${rpcRes.data.error.message}`);
            }

            if (rpcRes.data.result) {
                await db.execute({
                    sql: 'UPDATE multisig_transactions SET status = "broadcasted" WHERE id = ?',
                    args: [multisigId]
                });
                
                console.log(`[TERMINATION API] ✅ Successfully broadcasted ${multisigId}`);
            }
        }

        console.log(`[TERMINATION API] ✅ Approval recorded. Total signers: ${currentSigners.length}/${threshold}`);
        
        res.json({ 
            success: true, 
            canBroadcast, 
            currentSigners: currentSigners.length,
            threshold,
            status: canBroadcast ? 'ready' : 'pending'
        });

    } catch (error: any) {
        console.error('[TERMINATION API] ❌ Approval failed:', error);
        res.status(500).json({ error: `Approval failed: ${error.message}` });
    }
}