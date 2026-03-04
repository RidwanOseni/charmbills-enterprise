import { Request, Response } from 'express';
import { Database } from 'sqlite3';
import axios from 'axios';
// 1. IMPORT the hex fetcher from your utxo-manager
import { fetchTransactionHex } from '../lib/utxo-manager';
import { generateUnsignedTransactions } from '../charms/proverClient';
import { v4 as uuidv4 } from 'uuid';
import * as constants from '@shared/constants';
const db: Database = new (require('sqlite3').Database)(process.env.PAYROLL_DB_PATH || './payroll.db');

/**
 * GET /api/termination/pending
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
 * POST /api/termination/terminate
 * Terminates a worker and creates board-level emergency pause transaction [3]
 * 
 * Body: { walletAddress: string, reason?: string }
 */
export async function terminateWorker(req: Request, res: Response) {
    const { walletAddress, reason } = req.body;
    
    if (!walletAddress) {
        return res.status(400).json({ error: 'walletAddress is required' });
    }
    
    try {
        // Begin transaction for atomicity
        await new Promise((resolve, reject) => {
            db.run('BEGIN TRANSACTION', (err: Error | null) => err ? reject(err) : resolve(null));
        });

        // 1. Off-chain: Update status in WorkerCache to prevent future funding [4]
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

        // 2. Get vault details - specifically target the unspent token currently held by the worker [17]
        const vaultDetails: any = await new Promise((resolve, reject) => {
            db.get(
                `SELECT p.appId, w.currentTokenUtxo, p.multiSigSigners
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

        // 3. PRODUCTION FIX: Fetch raw hexes for provenance verification [5, 6]
        const [tokenTxid] = vaultDetails.currentTokenUtxo.split(':');
        const tokenTxHex = await fetchTransactionHex(tokenTxid);
        
        // Also fetch treasury funding hex for sponsorship
        const treasuryUtxo = process.env.PAYROLL_TREASURY_UTXO;
        if (!treasuryUtxo) {
            throw new Error('PAYROLL_TREASURY_UTXO not configured');
        }
        const [treasuryTxid] = treasuryUtxo.split(':');
        const treasuryTxHex = await fetchTransactionHex(treasuryTxid);

        // 4. Generate the emergency freeze spell (requires board signatures) [3, 5]
        // PASS currentTokenUtxo as the authorityUtxo to freeze [15]
        const freezeSpell = await generateUnsignedTransactions(
            {
                type: 'scroll-freeze', // You'll need to implement this in proverClient
                authorityUtxo: vaultDetails.currentTokenUtxo, // TARGET: The specific worker token [15]
                fundingUtxo: process.env.PAYROLL_TREASURY_UTXO!,
                fundingUtxoValue: parseInt(process.env.PAYROLL_TREASURY_VALUE!),
                changeAddress: process.env.PAYROLL_CHANGE_ADDRESS!,
                feeRate: constants.DEFAULT_FEE_RATE,
                outputs: [] // Freeze operations typically have no outputs
            },
            [tokenTxHex, treasuryTxHex], // Corrected: Full raw hexes [5, 8]
            vaultDetails.appId
        );

        // 5. Create multisig transaction record for board approval with worker_address column
        const multisigId = `freeze-${uuidv4()}`;
        const description = reason 
            ? `Emergency Freeze: Worker ${walletAddress} - ${reason}`
            : `Emergency Freeze: Worker ${walletAddress}`;

        await new Promise((resolve, reject) => {
            db.run(
                `INSERT INTO multisig_transactions 
                (id, type, category, description, worker_address, commitTxHex, spellTxHex, threshold, signers_json, createdAt, status) 
                VALUES (?, 'vault-freeze', 'corporate', ?, ?, ?, ?, 3, '[]', ?, 'pending')`,
                [
                    multisigId,
                    description,
                    walletAddress, // POPULATE NEW COLUMN
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
 * POST /api/termination/approve
 * Allows board members to sign pending multisig transactions with RBAC verification
 * and PSBT state persistence until threshold is met, then broadcasts to network.
 * 
 * Body: { multisigId: string, signerKey: string, signedCommitHex: string, signedSpellHex: string }
 */
export async function approveTermination(req: Request, res: Response) {
    // 1. ADDITION: Receive the partially signed hexes from the frontend [1]
    const { multisigId, signerKey, signedCommitHex, signedSpellHex } = req.body;

    if (!multisigId || !signerKey || !signedCommitHex || !signedSpellHex) {
        return res.status(400).json({ error: 'multisigId, signerKey, and signed hexes are required' });
    }

    try {
        // PRODUCTION FIX: Reliable RBAC using the direct worker_address column
        const authData: any = await new Promise((resolve, reject) => {
            db.get(
                `SELECT p.multiSigSigners FROM multisig_transactions mt
                 JOIN workers w ON mt.worker_address = w.walletAddress -- RELIABLE JOIN
                 JOIN plans p ON w.planId = p.appId
                 WHERE mt.id = ?`,
                [multisigId],
                (err: Error | null, row: any) => err ? reject(err) : resolve(row)
            );
        });

        const authorizedKeys = JSON.parse(authData?.multiSigSigners || '[]');
        if (!authorizedKeys.includes(signerKey)) {
            return res.status(403).json({ error: 'Unauthorized signer: Key not found in Plan NFT authority' });
        }

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
        if (!currentSigners.includes(signerKey)) {
            currentSigners.push(signerKey);
        }

        // Check if we've reached threshold (3-of-5)
        const threshold = tx.threshold;
        const canBroadcast = currentSigners.length >= threshold;

        // 2. OVERSIGHT FIX (PSBT State Persistence): Save the updated hexes to the DB [1, 2]
        // This allows the next signer to build upon the previous signatures.
        await new Promise((resolve, reject) => {
            db.run(
                `UPDATE multisig_transactions 
                 SET signers_json = ?, commitTxHex = ?, spellTxHex = ?, 
                     status = ? 
                 WHERE id = ?`,
                [
                    JSON.stringify(currentSigners), 
                    signedCommitHex, 
                    signedSpellHex, 
                    canBroadcast ? 'ready' : 'pending', 
                    multisigId
                ],
                (err: Error | null) => err ? reject(err) : resolve(null)
            );
        });

        // 3. OVERSIGHT FIX (Broadcast Coordination): Trigger on-chain broadcast [3-5]
        if (canBroadcast) {
            console.log(`[TERMINATION API] ✅ Threshold met for ${multisigId}. Broadcasting package...`);
            
            // Prepare RPC request for submitpackage
            const rpcRequest = {
                jsonrpc: "1.0",
                id: "charmbills-multisig-broadcast-" + Date.now(),
                method: "submitpackage",
                params: [[signedCommitHex, signedSpellHex]] // Both txs must be accepted simultaneously [4, 6]
            };

            // Get RPC credentials from environment
            const rpcUser = process.env.RPC_USER;
            const rpcPassword = process.env.RPC_PASSWORD;
            const rpcPort = process.env.RPC_PORT || 48332;
            const rpcHost = process.env.RPC_HOST || '127.0.0.1';

            if (!rpcUser || !rpcPassword) {
                throw new Error('RPC credentials not configured');
            }

            // Submit package to Bitcoin node
            const rpcRes = await axios.post(`http://${rpcHost}:${rpcPort}`, rpcRequest, {
                auth: { username: rpcUser, password: rpcPassword },
                headers: { 'Content-Type': 'application/json' }
            });

            if (rpcRes.data.error) {
                throw new Error(`RPC error: ${rpcRes.data.error.message}`);
            }

            if (rpcRes.data.result) {
                // Update transaction status to broadcasted
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