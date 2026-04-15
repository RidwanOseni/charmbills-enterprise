import { Request, Response } from 'express';
import { Database } from 'sqlite3';
import axios from 'axios';
import { fetchTransactionHex } from '../lib/utxo-manager';
import { generateUnsignedTransactions } from '../charms/proverClient';
import * as crypto from 'crypto';
import * as constants from '@shared/constants';
import { SpellRequest } from '@shared/types';
import * as scrolls from '../bitcoin/scrollsClient';

const db: Database = new (require('sqlite3').Database)(process.env.PAYROLL_DB_PATH || './payroll.db');

// Mempool API for on-chain queries
const MEMPOOL_API = "https://mempool.space/testnet4/api";

// --------------------------------------------------------------------------------
// Database Helper - Company Lookup
// --------------------------------------------------------------------------------

interface CompanyRecord {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  createdAt: string;
  updatedAt?: string;
}

/**
 * Get company configuration by employer address
 */
async function getCompanyByEmployer(employerAddress: string): Promise<CompanyRecord | null> {
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

/**
 * GET /api/treasury/pending
 * Fetches all pending multisig actions requiring board approval [2]
 */
export async function getPendingApprovals(req: Request, res: Response) {
    try {
        db.all(
            'SELECT * FROM multisig_transactions WHERE status = "pending" OR status = "ready" ORDER BY createdAt DESC', 
            [], 
            (err: Error | null, rows: any[]) => {
                if (err) {
                    console.error('[TERMINATION API] Failed to fetch pending approvals:', err);
                    return res.status(500).json({ error: 'Failed to fetch pending approvals' });
                }
                
                // Parse signers_json back to array for frontend
                const parsedRows = rows.map(row => ({
                    ...row,
                    signers: row.signers_json ? JSON.parse(row.signers_json) : []
                }));
                
                res.json(parsedRows);
            }
        );
    } catch (error: any) {
        console.error('[TERMINATION API] Unexpected error:', error);
        res.status(500).json({ error: error.message });
    }
}

/**
 * GET /api/treasury/audit
 * Retrieves the historical record of treasury actions for the Audit Trail.
 * Ensures the system is "Derivable" from the database state. [Source 850]
 */
export async function getAuditLogs(req: Request, res: Response) {
    try {
        db.all(
            'SELECT * FROM audit_logs ORDER BY timestamp DESC LIMIT 50', 
            [], 
            (err: Error | null, rows: any[]) => {
                if (err) {
                    console.error('[TREASURY API] Failed to fetch audit logs:', err);
                    return res.status(500).json({ error: 'Failed to fetch audit logs' });
                }
                // Return rows, ensuring they match the AuditRecord interface
                res.json(rows || []);
            }
        );
    } catch (error: any) {
        console.error('[TREASURY API] Unexpected error in getAuditLogs:', error);
        res.status(500).json({ error: error.message });
    }
}

/**
 * GET /api/treasury/stats/:employerAddress
 * Aggregates vault liquidity and allocations for the treasury dashboard
 * Uses Deterministic Nonce Model for isolated vaults per employer [Source 628, 734]
 * 
 * - totalLockedSats: ACTUAL physical BTC in the employer's isolated vault (queried from mempool)
 * - employeeAllocationSats: LIABILITY (sum of active salaries)
 * - requiredFundingSats: TARGET (allocation + buffer) - Desired State
 * - freelancerEscrowSats: Sats held in escrow for freelancers
 * - vaultAddress: Isolated Bitcoin vault address for this employer
 * 
 * MODIFIED: Now uses centralized scrollsClient for vault address derivation [Source 629]
 */
export async function getTreasuryStats(req: Request, res: Response) {
    const { employerAddress } = req.params;
    
    if (!employerAddress) {
        return res.status(400).json({ error: 'employerAddress parameter is required' });
    }
    
    console.log(`[TREASURY API] 📊 Fetching treasury stats for: ${employerAddress.substring(0, 20)}...`);
    
    try {
        // =========================================================================
        // STEP 1: Get the department's appId to use as a nonce source [Source 724]
        // The appId is unique per department, derived from the anchor UTXO
        // =========================================================================
        const plan = await new Promise<any>((resolve, reject) => {
            db.get(
                'SELECT appId FROM plans WHERE employerAddress = ? LIMIT 1',
                [employerAddress],
                (err: Error | null, row: any) => {
                    if (err) reject(err);
                    else resolve(row);
                }
            );
        });
        
        if (!plan || !plan.appId) {
            console.warn(`[TREASURY API] No plan found for employer: ${employerAddress}`);
            // Return default stats with zero balances
            return res.json({
                totalLockedSats: 0,
                employeeAllocationSats: 0,
                requiredFundingSats: 0,
                freelancerEscrowSats: 0,
                vaultAddress: null,
                message: 'No active plan found for this employer'
            });
        }
        
        // =========================================================================
        // STEP 2: Use centralized scrollsClient to get the isolated vault address [Source 629]
        // This keeps business logic clean and delegates Scroll interaction to the client
        // =========================================================================
        const vaultAddress = await scrolls.getVaultAddress(plan.appId);
        console.log(`[TREASURY API] Isolated vault address: ${vaultAddress}`);
        
        // =========================================================================
        // STEP 3: Query Mempool for the REAL balance of THIS isolated vault [Source 812]
        // This will show 0 until the employer actually sends funds to their vault
        // =========================================================================
        let actualLockedSats = 0;
        try {
            const utxoRes = await axios.get(`${MEMPOOL_API}/address/${vaultAddress}/utxo`, {
                timeout: 10000
            });
            const utxos = utxoRes.data;
            actualLockedSats = utxos.reduce((sum: number, u: any) => sum + u.value, 0);
            console.log(`[TREASURY API] Actual vault balance: ${actualLockedSats} sats (${actualLockedSats / 1e8} BTC)`);
        } catch (mempoolError: any) {
            console.error(`[TREASURY API] ⚠️ Failed to fetch vault balance from mempool:`, mempoolError.message);
            actualLockedSats = 0;
        }
        
        // =========================================================================
        // STEP 4: Calculate Liabilities (Source of Truth from DB) [Source 870]
        // Fetch all active workers for this employer's plan
        // =========================================================================
        const workers = await new Promise<any[]>((resolve, reject) => {
            db.all(
                `SELECT w.salarySats, w.currentTokenUtxo, w.status 
                 FROM workers w
                 JOIN plans p ON w.planId = p.appId 
                 WHERE w.status = 'active' AND p.employerAddress = ?`,
                [employerAddress],
                (err: Error | null, rows: any[]) => {
                    if (err) reject(err);
                    else resolve(rows || []);
                }
            );
        });
        
        console.log(`[TREASURY API] Found ${workers.length} active workers`);
        
        // Calculate total employee allocation (sum of all active worker salaries) - LIABILITY
        const employeeAllocationSats = workers.reduce((sum, w) => sum + (w.salarySats || 0), 0);
        
        // For demo, freelancer escrow is 0 (can be extended later)
        const freelancerEscrowSats = 0;
        
        // Buffer for transaction fees and operational costs (5% buffer)
        const bufferSats = Math.floor(employeeAllocationSats * 0.05);
        
        // =========================================================================
        // SEPARATE "TARGET" FROM "ACTUAL" [Source 76, 77]
        // requiredFundingSats: TARGET (Desired State) = allocation + buffer
        // totalLockedSats: ACTUAL (Physical BTC in the employer's isolated vault)
        // =========================================================================
        const requiredFundingSats = employeeAllocationSats + bufferSats + freelancerEscrowSats;
        
        console.log(`[TREASURY API] ✅ Stats calculated:`, {
            totalLockedSats: actualLockedSats,
            employeeAllocationSats: employeeAllocationSats,
            requiredFundingSats: requiredFundingSats,
            freelancerEscrowSats: freelancerEscrowSats,
            vaultAddress: vaultAddress
        });
        
        res.json({
            totalLockedSats: actualLockedSats,        // ACTUAL: Real on-chain data from isolated vault
            employeeAllocationSats: employeeAllocationSats,    // LIABILITY: Sum of active salaries
            requiredFundingSats: requiredFundingSats,          // TARGET: Allocation + Buffer (Desired State)
            freelancerEscrowSats: freelancerEscrowSats,        // Sats held in escrow for freelancers
            vaultAddress: vaultAddress                         // Isolated Bitcoin vault address for this employer
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
        
        const company = await getCompanyByEmployer(employerAddress);
        
        if (!company || !company.treasuryHexDest) {
            console.error(`[TERMINATION API] ❌ Company not found for employer: ${employerAddress}`);
            return res.status(404).json({ 
                error: 'Company not registered. Please complete company onboarding first.',
                employerAddress: employerAddress.substring(0, 20) + '...'
            });
        }
        
        console.log(`[TERMINATION API] ✅ Company found:`, {
            treasuryHexDest: company.treasuryHexDest.substring(0, 30) + '...',
            treasuryAddress: company.treasuryAddress.substring(0, 20) + '...'
        });
        
        // Begin transaction for atomicity
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err: Error | null) => err ? reject(err) : resolve(null));
        });

        // Step 2: Off-chain: Update status in WorkerCache to prevent future funding [4]
        await new Promise((resolve, reject) => {
            db.run(
                'UPDATE workers SET status = "terminated" WHERE walletAddress = ?', 
                [walletAddress], 
                function(this: any, err: Error | null) {
                    if (err) return reject(err);
                    if (this.changes === 0) {
                        reject(new Error(`Worker with address ${walletAddress} not found`));
                    }
                    resolve(null);
                }
            );
        });

        // Step 3: Get vault details - specifically target the unspent token currently held by the worker [17]
        const vaultDetails: any = await new Promise((resolve, reject) => {
            db.get(
                `SELECT p.appId, w.currentTokenUtxo, p.multiSigSigners, p.ticker
                 FROM workers w
                 JOIN plans p ON w.planId = p.appId
                 WHERE w.walletAddress = ? AND w.status = 'active'`,
                [walletAddress],
                (err: Error | null, row: any) => err ? reject(err) : resolve(row)
            );
        });

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

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO multisig_transactions 
                (id, type, category, description, worker_address, employerAddress, commitTxHex, spellTxHex, threshold, signers_json, createdAt, status) 
                VALUES (?, 'vault-freeze', 'corporate', ?, ?, ?, ?, ?, 3, '[]', ?, 'pending')`,
                [
                    multisigId,
                    description,
                    walletAddress,              // worker_address column
                    employerAddress,            // employerAddress column
                    freezeSpell.commitTxHex,
                    freezeSpell.spellTxHex,
                    new Date().toISOString()
                ],
                (err: Error | null) => err ? reject(err) : resolve(null)
            );
        });

        // Commit transaction
        await new Promise((resolve, reject) => {
            db.run('COMMIT', (err: Error | null) => err ? reject(err) : resolve(null));
        });

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
        await new Promise((resolve) => {
            db.run('ROLLBACK', () => resolve(null));
        });

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
        const planData: any = await new Promise((resolve, reject) => {
            db.get(
                `SELECT p.multiSigSigners 
                 FROM plans p 
                 JOIN workers w ON w.planId = p.appId 
                 JOIN multisig_transactions mt ON mt.worker_address = w.walletAddress 
                 WHERE mt.id = ?`,
                [multisigId],
                (err: Error | null, row: any) => err ? reject(err) : resolve(row)
            );
        });

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
        const tx: any = await new Promise((resolve, reject) => {
            db.get(
                'SELECT * FROM multisig_transactions WHERE id = ?',
                [multisigId],
                (err: Error | null, row: any) => err ? reject(err) : resolve(row)
            );
        });

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
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE multisig_transactions 
                 SET signers_json = ?, commitTxHex = ?, spellTxHex = ?, 
                     status = ? 
                 WHERE id = ?`,
                [
                    JSON.stringify(currentSigners), 
                    updatedCommitHex, 
                    updatedSpellHex, 
                    canBroadcast ? 'ready' : 'pending', 
                    multisigId
                ],
                (err: Error | null) => err ? reject(err) : resolve(null)
            );
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
                await new Promise((resolve, reject) => {
                    db.run(
                        'UPDATE multisig_transactions SET status = "broadcasted" WHERE id = ?', 
                        [multisigId],
                        (err: Error | null) => err ? reject(err) : resolve(null)
                    );
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