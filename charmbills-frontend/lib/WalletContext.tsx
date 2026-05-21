"use client"
import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';
import { ProverResult } from '../shared/types';
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Shared Constants Alignment [12]
const TESTNET = { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

// Define context type
interface WalletContextType {
  address: string | null;
  walletConnected: boolean;
  taprootPublicKey: string | null;
  connectWallet: () => Promise<void>;
  disconnectWallet: () => void;
  signAndBroadcastPackage: (proverResult: ProverResult, dualUtxoContext: any) => Promise<{
    txids: string[];
    commitTxHex: string;
    spellTxHex: string;
  } | null>;
}

export const WalletContext = createContext<WalletContextType | undefined>(undefined);

/**
 * Helper: Creates P2TR payment object and builds PSBT for Spell transaction
 * FIX: Added version: 2 for Taproot standardness and lockTime passed to constructor [Source 161, 162]
 * FIX: Polymorphic Signing based on Actual Script Length [3, 4, 9]
 * - Input 0 (Anchor): Always Taproot (34-byte script) - includes tapInternalKey
 * - Input 1 (Fee): Uses fundingScript from dualUtxoContext (actual on-chain script)
 * FIX: Input 1 now properly uses context.fee.value (>=15000 sats) and extracts script from parent transaction hex
 * FIX: Removed context.isSingle wrapper - if decoded transaction has 2 inputs, we add both unconditionally
 * FIX: Added total sats validation to prevent "insufficient fuel" errors
 */
function buildTaprootPsbt(
    rawHex: string, 
    targetTxid: string, 
    targetVout: number, 
    targetValue: number, 
    targetScript: Uint8Array,
    context: any, 
    pubKeyHex: string
): string {
    const schnorrKey = hexToBytes(pubKeyHex).slice(1);
    // Standard wallet script for fee inputs (fallback only)
    const payment = btc.p2tr(schnorrKey, undefined, TESTNET);
    
    // Decode FIRST to get the template data
    const decoded = btc.RawTx.decode(hexToBytes(rawHex));
    
    // CRITICAL FIX: Pass lockTime and version into constructor (read-only property)
    // version: 2 is mandatory for Taproot standardness [Source 161, 162]
    const psbt = new btc.Transaction({ 
        allowUnknownOutputs: true, 
        version: 2,                    // ✅ Mandatory for Taproot standardness
        lockTime: decoded.lockTime     // ✅ Correct approach - passed to constructor
    });

    console.log('[buildTaprootPsbt] ========== PSBT CONSTRUCTION START ==========');
    console.log('[buildTaprootPsbt] Decoded transaction:', {
        inputs: decoded.inputs.length,
        outputs: decoded.outputs.length,
        witnesses: decoded.witnesses?.length || 0,
        isSingle: context?.isSingle,
        version: 2,
        lockTime: decoded.lockTime
    });

    // Log outputs to see if proof is in an output
    console.log('[buildTaprootPsbt] Outputs detail:');
    decoded.outputs.forEach((out, idx) => {
        console.log(`  Output ${idx}: amount=${out.amount}, script length=${out.script.length}, script preview=${bytesToHex(out.script).substring(0, 50)}...`);
    });

    // Map outputs
    decoded.outputs.forEach(out => psbt.addOutput({ amount: out.amount, script: out.script }));

    // =========================================================================
    // PROFESSIONAL AUDIT: Track total input and output sats to validate fuel
    // =========================================================================
    let totalInputSats = BigInt(0);
    let totalOutputSats = BigInt(0);
    
    // Calculate total outputs first
    decoded.outputs.forEach(out => {
        totalOutputSats += out.amount;
    });
    console.log(`[PSBT AUDIT] Total Output Sats: ${totalOutputSats.toString()}`);

    // =========================================================================
    // CRITICAL FIX: Map inputs with explicit values for Plan NFT and Treasury UTXO
    // Input 0: The Plan NFT (Authority) - always 1000 sats
    // Input 1: The Treasury UTXO (Gas/Fees) - uses context.fee.value (>=15000 sats)
    // =========================================================================
    decoded.inputs.forEach((input, i) => {
        console.log(`[PSBT AUDIT] Processing Input ${i}...`);
        
        if (i === 0) {
            // =========================================================================
            // INPUT 0: The Plan NFT (Authority UTXO) - 1,000 sats
            // =========================================================================
            console.log('[PSBT AUDIT] Adding Input 0 (Authority):', {
                txid: targetTxid,
                vout: targetVout,
                value: targetValue,
                scriptLength: targetScript.length
            });
            totalInputSats += BigInt(targetValue);
            psbt.addInput({
                txid: targetTxid,
                index: targetVout,
                witnessUtxo: {
                    amount: BigInt(targetValue),
                    script: targetScript
                },
                tapInternalKey: payment.tapInternalKey,
                sequence: input.sequence
            });
            console.log(`[PSBT AUDIT] Input 0 Added: ${targetValue} sats`);
            
        } else if (i === 1) {
            // =========================================================================
            // INPUT 1: The Treasury UTXO (Gas Sponsor) - ≥15,000 sats
            // PROFESSIONAL FIX: REMOVED 'if (context.isSingle)' wrapper
            // If the prover gave us 2 inputs, we MUST provide 2 inputs regardless of flags
            // =========================================================================
            console.log('[PSBT AUDIT] Processing Input 1 (Treasury Fuel)...');
            
            if (!context || !context.fee) {
                console.error('[PSBT AUDIT] FATAL: Input 1 found in template but NO fee context provided!', {
                    contextExists: !!context,
                    feeExists: !!context?.fee
                });
                throw new Error('Fatal: Treasury "fuel" missing for input 1. Cannot build PSBT.');
            }
            
            console.log('[PSBT AUDIT] Context fee details:', {
                utxoId: context.fee.utxoId,
                value: context.fee.value,
                hasHex: !!context.fee.hex,
                hasScript: !!context.fee.script,
                scriptLength: context.fee.script?.length
            });
            
            // CORRECT EXTRACTION: Split into string components
            const utxoParts = context.fee.utxoId.split(':');
            const feeTxid = utxoParts[0];           // String: The Transaction ID
            const feeVout = parseInt(utxoParts[1]);   // Number: The Output Index
            
            console.log(`[PSBT AUDIT] Parsed fee UTXO: txid=${feeTxid}, vout=${feeVout}`);
            
            // CORRECT SCRIPT DECODING: Extracting the actual locking script
            let actualScriptPubKey: Uint8Array;
            
            if (context.fee.script && context.fee.script.length === 34) {
                // Use the script if already provided and correct length
                actualScriptPubKey = typeof context.fee.script === 'string' 
                    ? hexToBytes(context.fee.script) 
                    : context.fee.script;
                console.log(`[PSBT AUDIT] Using fee script from context, length: ${actualScriptPubKey.length}`);
            } else if (context.fee.hex) {
                // CRITICAL: Decode the parent transaction and extract the script from the specific output
                console.log('[PSBT AUDIT] Decoding fee parent transaction to extract scriptPubKey...');
                const parentTx = btc.RawTx.decode(hexToBytes(context.fee.hex));
                actualScriptPubKey = parentTx.outputs[feeVout].script;
                console.log(`[PSBT AUDIT] Extracted script from parent tx output ${feeVout}, length: ${actualScriptPubKey.length}`);
                console.log(`[PSBT AUDIT] Script preview: ${bytesToHex(actualScriptPubKey).substring(0, 50)}...`);
            } else {
                console.error('[PSBT AUDIT] Missing both script and hex for Treasury UTXO');
                throw new Error('Missing both script and hex for Treasury UTXO');
            }
            
            const isTaproot = actualScriptPubKey.length === 34;
            
            console.log(`[PSBT AUDIT] Adding Input 1 (Treasury Fuel):`, {
                txid: feeTxid,
                vout: feeVout,
                value: context.fee.value,
                scriptLength: actualScriptPubKey.length,
                isTaproot: isTaproot
            });
            
            totalInputSats += BigInt(context.fee.value);
            
            const inputConfig: any = {
                txid: feeTxid,
                index: feeVout,
                witnessUtxo: {
                    amount: BigInt(context.fee.value),
                    script: actualScriptPubKey
                },
                sequence: input.sequence
            };
            
            // Only add tapInternalKey for Taproot UTXOs (34-byte scripts)
            if (isTaproot) {
                inputConfig.tapInternalKey = payment.tapInternalKey;
                console.log('[PSBT AUDIT] Input 1 is Taproot - adding tapInternalKey');
            } else {
                console.log('[PSBT AUDIT] Input 1 is non-Taproot - NO tapInternalKey');
            }
            
            psbt.addInput(inputConfig);
            console.log(`[PSBT AUDIT] Input 1 Added: ${context.fee.value} sats`);
            
        } else {
            console.warn('[PSBT AUDIT] Unexpected input index:', i);
            totalInputSats += BigInt(1000);
            psbt.addInput({
                txid: bytesToHex(input.txid),
                index: input.index,
                witnessUtxo: {
                    amount: BigInt(1000),
                    script: payment.script
                },
                tapInternalKey: payment.tapInternalKey,
                sequence: input.sequence
            });
        }
    });

    // =========================================================================
    // PROFESSIONAL AUDIT: Final math check before returning
    // This prevents the "Outputs spends more than inputs amount" error
    // =========================================================================
    console.log(`[PSBT AUDIT] ========== FINAL MATH CHECK ==========`);
    console.log(`[PSBT AUDIT] Total Input Sats: ${totalInputSats.toString()}`);
    console.log(`[PSBT AUDIT] Total Output Sats: ${totalOutputSats.toString()}`);
    console.log(`[PSBT AUDIT] Input - Output: ${(totalInputSats - totalOutputSats).toString()} sats`);
    
    if (totalInputSats < totalOutputSats) {
        const deficit = totalOutputSats - totalInputSats;
        console.error(`[PSBT AUDIT] ❌ INSUFFICIENT FUEL: Inputs(${totalInputSats}) vs Outputs(${totalOutputSats})`);
        console.error(`[PSBT AUDIT] Deficit: ${deficit} sats`);
        throw new Error(`Insufficient Fuel: ${totalInputSats} sats in vs ${totalOutputSats} sats out (deficit: ${deficit} sats)`);
    }
    
    console.log(`[PSBT AUDIT] ✅ Fuel check passed: ${totalInputSats} sats in >= ${totalOutputSats} sats out`);
    console.log('[PSBT AUDIT] PSBT built successfully, total inputs:', psbt.inputsLength);
    console.log('[buildTaprootPsbt] ========== PSBT CONSTRUCTION END ==========');
    
    return bytesToHex(psbt.toPSBT());
}

/**
 * Build PSBT for Commit transaction (has 2 inputs: anchor + fee)
 * FIX: Added version: 2 for Taproot standardness and lockTime passed to constructor [Source 173]
 */
function buildCommitPsbt(rawHex: string, anchorUtxo: any, feeUtxo: any, pubKeyHex: string): string {
    const schnorrKey = hexToBytes(pubKeyHex).slice(1);
    const payment = btc.p2tr(schnorrKey, undefined, TESTNET);
    
    // Decode FIRST to get the template data
    const decoded = btc.RawTx.decode(hexToBytes(rawHex));
    
    // CRITICAL FIX: Pass lockTime and version into constructor (read-only property)
    // version: 2 is mandatory for Taproot standardness [Source 173]
    const psbt = new btc.Transaction({ 
        allowUnknownOutputs: true, 
        version: 2,                    // ✅ Ensure version consistency
        lockTime: decoded.lockTime     // ✅ Correct approach - passed to constructor
    });

    console.log('[buildCommitPsbt] Building commit PSBT');
    console.log('[buildCommitPsbt] Anchor UTXO (Plan NFT):', {
        utxoId: anchorUtxo.utxoId,
        value: anchorUtxo.value
    });
    console.log('[buildCommitPsbt] Fee UTXO (Treasury):', {
        utxoId: feeUtxo.utxoId,
        value: feeUtxo.value
    });
    console.log('[buildCommitPsbt] version: 2, lockTime:', decoded.lockTime);

    decoded.outputs.forEach((out, idx) => {
        console.log(`[buildCommitPsbt] Output ${idx}: amount=${out.amount}, script length=${out.script.length}`);
        psbt.addOutput({ amount: out.amount, script: out.script });
    });

    const [anchorTxid, anchorVoutStr] = anchorUtxo.utxoId.split(':');
    const anchorVout = parseInt(anchorVoutStr);
    
    const [feeTxid, feeVoutStr] = feeUtxo.utxoId.split(':');
    const feeVout = parseInt(feeVoutStr);
    
    console.log('[buildCommitPsbt] Adding anchor UTXO as input 0 (Plan NFT):', { txid: anchorTxid, vout: anchorVout, value: anchorUtxo.value });
    psbt.addInput({
        txid: anchorTxid,
        index: anchorVout,
        witnessUtxo: {
            amount: BigInt(anchorUtxo.value),
            script: payment.script
        },
        tapInternalKey: payment.tapInternalKey,
        sequence: 0xffffffff
    });
    
    console.log('[buildCommitPsbt] Adding fee UTXO as input 1 (Treasury):', { txid: feeTxid, vout: feeVout, value: feeUtxo.value });
    psbt.addInput({
        txid: feeTxid,
        index: feeVout,
        witnessUtxo: {
            amount: BigInt(feeUtxo.value),
            script: payment.script
        },
        tapInternalKey: payment.tapInternalKey,
        sequence: 0xffffffff
    });

    console.log('[buildCommitPsbt] PSBT built, input count:', psbt.inputsLength);
    return bytesToHex(psbt.toPSBT());
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
    const [address, setAddress] = useState<string | null>(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [taprootPublicKey, setTaprootPublicKey] = useState<string | null>(null);
    const [isInitialized, setIsInitialized] = useState(false);

    useEffect(() => {
        try {
            const savedAddress = localStorage.getItem("charm_wallet_address");
            const savedPubKey = localStorage.getItem("charm_taproot_pubkey");
            
            console.log("[WalletContext] Hydrating from localStorage:", {
                hasSavedAddress: !!savedAddress,
                hasSavedPubKey: !!savedPubKey
            });
            
            if (savedAddress) {
                setAddress(savedAddress);
                setWalletConnected(true);
                setIsInitialized(true);
            }
            if (savedPubKey) {
                setTaprootPublicKey(savedPubKey);
            }
        } catch (error) {
            console.error("[WalletContext] Failed to hydrate from localStorage:", error);
        }
    }, []);

    const connectWallet = async () => {
        console.log("[WalletContext] Connecting wallet...");
        
        try {
            if (typeof window !== 'undefined' && (window as any).LeatherProvider) {
                const response = await (window as any).LeatherProvider.request("getAddresses");
                
                if (!response?.result?.addresses) {
                    throw new Error("No addresses returned from wallet");
                }
                
                const p2tr = response.result.addresses.find((a: any) => a.type === 'p2tr');
                
                if (!p2tr) {
                    throw new Error("Taproot address (p2tr) not found in wallet");
                }
                
                console.log("[WalletContext] Found Taproot address:", p2tr.address);
                
                setAddress(p2tr.address);
                setWalletConnected(true);
                setTaprootPublicKey(p2tr.publicKey);
                
                localStorage.setItem("charm_wallet_address", p2tr.address);
                localStorage.setItem("charm_taproot_pubkey", p2tr.publicKey);
                
                console.log("[WalletContext] ✅ Wallet connected and persisted");
            } else {
                throw new Error("Leather wallet not detected. Please install Leather extension.");
            }
        } catch (error: any) {
            console.error("[WalletContext] ❌ Connection failed:", error.message);
            throw error;
        }
    };

    const disconnectWallet = () => {
        console.log("[WalletContext] Disconnecting wallet...");
        
        setAddress(null); 
        setWalletConnected(false); 
        setTaprootPublicKey(null);
        
        localStorage.removeItem("charm_wallet_address");
        localStorage.removeItem("charm_taproot_pubkey");
        
        console.log("[WalletContext] ✅ Wallet disconnected");
    };

    const signAndBroadcastPackage = async (proverResult: ProverResult, dualUtxoContext: any) => {
        if (!(window as any).LeatherProvider) {
            console.error('[WalletContext] Leather wallet not detected');
            throw new Error('Leather wallet not detected');
        }
        
        if (!taprootPublicKey) {
            console.error('[WalletContext] Taproot public key not available');
            throw new Error('Taproot public key not available. Please reconnect wallet.');
        }

        try {
            console.group('[Wallet Context] Sequential Signing with Dual UTXO Context');
            console.log('Dual UTXO Context:', {
                anchor: dualUtxoContext.anchor ? {
                    utxoId: dualUtxoContext.anchor.utxoId,
                    value: dualUtxoContext.anchor.value,
                    hasHex: !!dualUtxoContext.anchor.hex,
                    hasScript: !!dualUtxoContext.anchor.script,
                    scriptLength: dualUtxoContext.anchor.script?.length
                } : null,
                fee: dualUtxoContext.fee ? {
                    utxoId: dualUtxoContext.fee.utxoId,
                    value: dualUtxoContext.fee.value,
                    hasHex: !!dualUtxoContext.fee.hex,
                    hasScript: !!dualUtxoContext.fee.script,
                    scriptLength: dualUtxoContext.fee.script?.length
                } : null,
                isSingle: proverResult.isSingle
            });

            console.log('[WalletContext] Fee UTXO (Treasury) details:', {
                utxoId: dualUtxoContext.fee?.utxoId,
                value: dualUtxoContext.fee?.value,
                scriptHex: dualUtxoContext.fee?.script,
                scriptLength: dualUtxoContext.fee?.script?.length
            });

            if (!dualUtxoContext.fee || !dualUtxoContext.anchor) {
                throw new Error('Invalid dual UTXO context: missing fee or anchor');
            }

            const commitRaw = typeof proverResult.commitTxHex === 'object' 
                ? (proverResult.commitTxHex as any).bitcoin 
                : proverResult.commitTxHex;
            const spellRaw = typeof proverResult.spellTxHex === 'object' 
                ? (proverResult.spellTxHex as any).bitcoin 
                : proverResult.spellTxHex;

            if (!commitRaw || typeof commitRaw !== 'string') {
                throw new Error('Invalid commit transaction hex');
            }
            if (!spellRaw || typeof spellRaw !== 'string') {
                throw new Error('Invalid spell transaction hex');
            }

            console.log('[WalletContext] Raw hexes:', {
                commitLength: commitRaw.length,
                spellLength: spellRaw.length,
                isSingle: proverResult.isSingle
            });

            // ============================================================
            // v0.12 Single-Transaction Flow - Proof is in OP_RETURN output
            // CLEAN V12 SIGNING: No manual witness restoration needed
            // The ZK-proof is already embedded in the OP_RETURN output,
            // not in the input witness. Leather signs both inputs fully.
            // ============================================================
            if (proverResult.isSingle) {
                console.log("🚀 v0.12 Single-Transaction Flow: Signing and broadcasting combined transaction...");
                
                // DEBUG: Log original spell hex outputs to verify proof exists
                const originalTx = btc.RawTx.decode(hexToBytes(spellRaw));
                console.log('[WalletContext] [DEBUG] Original spell transaction analysis:');
                console.log(`  - Inputs: ${originalTx.inputs.length}`);
                console.log(`  - Outputs: ${originalTx.outputs.length}`);
                console.log(`  - Witnesses: ${originalTx.witnesses?.length || 0}`);
                console.log(`  - lockTime: ${originalTx.lockTime}`);
                
                // Check each output for potential OP_RETURN proof
                originalTx.outputs.forEach((out, idx) => {
                    const scriptHex = bytesToHex(out.script);
                    // OP_RETURN is 0x6a
                    if (scriptHex.startsWith('6a')) {
                        console.log(`  - Output ${idx}: OP_RETURN found! script length: ${out.script.length}, preview: ${scriptHex.substring(0, 100)}...`);
                        console.log(`  - ✅ Proof likely in output ${idx} (OP_RETURN with data)`);
                    } else {
                        console.log(`  - Output ${idx}: amount=${out.amount}, script length=${out.script.length}, script preview=${scriptHex.substring(0, 50)}...`);
                    }
                });
                
                const [anchorTxid, anchorVoutStr] = dualUtxoContext.anchor.utxoId.split(':');
                const anchorVout = parseInt(anchorVoutStr);
                const anchorTx = btc.RawTx.decode(hexToBytes(dualUtxoContext.anchor.hex));
                const actualAnchorScript = anchorTx.outputs[anchorVout].script;
                
                // =========================================================================
                // CRITICAL: Use the fee script from context (passed via fundingScript)
                // Do NOT re-decode the fee transaction - use the script provided by the backend
                // =========================================================================
                let actualFeeScript: Uint8Array;
                if (dualUtxoContext.fee.script && dualUtxoContext.fee.script.length === 34) {
                    actualFeeScript = typeof dualUtxoContext.fee.script === 'string' 
                        ? hexToBytes(dualUtxoContext.fee.script) 
                        : dualUtxoContext.fee.script;
                    console.log('[WalletContext] Using fee script from context (fundingScript)');
                } else {
                    // Fallback: decode from hex to extract scriptPubKey
                    console.warn('[WalletContext] No fee script in context - extracting from hex');
                    const feeTx = btc.RawTx.decode(hexToBytes(dualUtxoContext.fee.hex));
                    const [feeTxid, feeVoutStr] = dualUtxoContext.fee.utxoId.split(':');
                    const feeVout = parseInt(feeVoutStr);
                    actualFeeScript = feeTx.outputs[feeVout].script;
                    console.log(`[WalletContext] Extracted fee script from hex, length: ${actualFeeScript.length}`);
                }
                
                // Add the fee script to context for buildTaprootPsbt
                dualUtxoContext.fee.script = actualFeeScript;
                
                // =========================================================================
                // CRITICAL: Combine dualUtxoContext with isSingle flag from proverResult
                // The buildTaprootPsbt function now ignores isSingle and always adds Input 1
                // =========================================================================
                const singleTxContext = {
                    ...dualUtxoContext,
                    isSingle: proverResult.isSingle
                };
                
                console.log('[WalletContext] singleTxContext.isSingle:', singleTxContext.isSingle);
                console.log('[WalletContext] singleTxContext.fee exists:', !!singleTxContext.fee);
                
                const combinedPsbt = buildTaprootPsbt(
                    spellRaw,
                    anchorTxid,
                    anchorVout,
                    dualUtxoContext.anchor.value,
                    actualAnchorScript,
                    singleTxContext,
                    taprootPublicKey
                );
                
                // =========================================================================
                // CRITICAL FIX FOR V12 COLLAPSED MODEL:
                // 1. Request signature for ALL inputs - Leather signs both inputs fully
                // 2. No signAtIndex - wallet signs all inputs it owns
                // 3. DO NOT manually re-attach witnesses - proof is in OP_RETURN output
                // 4. DO NOT updateInput(1, ...) - this would wipe the Fee signature!
                // =========================================================================
                console.log('[WalletContext] Requesting signature for both inputs (Plan NFT + Treasury UTXO)');
                console.log('[WalletContext] Combined PSBT length:', combinedPsbt.length);
                
                const signedRes = await (window as any).LeatherProvider.request("signPsbt", {
                    hex: combinedPsbt,
                    network: "testnet",
                    broadcast: false
                });
                
                console.log('✅ Spell PSBT signed by wallet for all inputs');
                
                // Load signed PSBT into transaction object
                const spellTransaction = btc.Transaction.fromPSBT(
                    hexToBytes(signedRes.result.hex),
                    { allowUnknownOutputs: true }
                );
                
                // =========================================================================
                // MANDATORY FINALIZATION
                // This moves signatures from PSBT fields to the final witness stack.
                // This is required before extraction.
                // DO NOT manually updateInput(1, ...) here - it will wipe the wallet's signatures!
                // =========================================================================
                spellTransaction.finalize();
                console.log('✅ Transaction finalized (Input 0 and Input 1 signatures moved to witness stack)');
                
                // =========================================================================
                // Extract final broadcastable hex
                // DO NOT updateInput(1, ...) here. It will wipe your Fee signature!
                // In v12 Single-Tx mode, the proof is in the OP_RETURN output,
                // not in the input witness, so no restoration is needed.
                // =========================================================================
                const finalizedHex = bytesToHex(spellTransaction.extract());
                
                console.log('📦 Ready for broadcast. Hex length:', finalizedHex.length);
                console.log('✅ Combined transaction finalized successfully');
                
                let txidStrings: string[] = [];
                try {
                    console.log('📤 Broadcasting single transaction...');
                    const broadcastResponse = await axios.post('http://localhost:3002/api/broadcast-package', {
                        transactions: [finalizedHex]
                    });
                    
                    const data = broadcastResponse.data.txids;
                    if (data && data['tx-results']) {
                        txidStrings = Object.values(data['tx-results']).map((res: any) => res.txid);
                        console.log('🎉 Broadcast successful! TXIDs:', txidStrings);
                    } else if (Array.isArray(data)) {
                        txidStrings = data;
                        console.log('🎉 Broadcast successful! TXIDs:', txidStrings);
                    } else {
                        console.warn('⚠️ Broadcast returned unexpected response format');
                    }
                } catch (broadcastErr: any) {
                    console.warn('⚠️ Broadcast deferred (Transaction may require more signatures):', broadcastErr.message);
                }
                
                console.groupEnd();
                return {
                    txids: txidStrings,
                    commitTxHex: finalizedHex,
                    spellTxHex: finalizedHex
                };
            }

            // ============================================================
            // TWO-TRANSACTION FLOW (v11 dual-transaction flow)
            // ============================================================
            
            console.log('🔐 Signing Commit Transaction...');
            console.log('Anchor UTXO (Plan NFT) value:', dualUtxoContext.anchor.value, 'sats');
            console.log('Anchor UTXO ID:', dualUtxoContext.anchor.utxoId);
            console.log('Fee UTXO (Treasury) value:', dualUtxoContext.fee.value, 'sats');
            console.log('Fee UTXO ID:', dualUtxoContext.fee.utxoId);
            
            const commitPsbt = buildCommitPsbt(commitRaw, dualUtxoContext.anchor, dualUtxoContext.fee, taprootPublicKey);
            console.log('[WalletContext] Commit PSBT built, length:', commitPsbt.length);
            
            const commitRes = await (window as any).LeatherProvider.request("signPsbt", {
                hex: commitPsbt,
                network: "testnet",
                broadcast: false 
            });
            console.log('[WalletContext] Commit signed, response received');

            const finalizedCommit = btc.Transaction.fromPSBT(
                hexToBytes(commitRes.result.hex),
                { allowUnknownOutputs: true }
            );
            finalizedCommit.finalize();
            
            const signedCommitHex = bytesToHex(finalizedCommit.extract());
            
            const commitTxId = finalizedCommit.id;
            const commitOutput = finalizedCommit.getOutput(0);
            
            if (!commitOutput || !commitOutput.amount || !commitOutput.script) {
                console.error('❌ Commit transaction output is invalid:', commitOutput);
                throw new Error('Commit transaction has invalid or missing output');
            }

            console.log('📊 Commit Transaction Info:');
            console.log('- Commit TXID:', commitTxId);
            console.log('- Commit output amount:', commitOutput.amount.toString());
            console.log('- Commit output script length:', commitOutput.script.length);

            dualUtxoContext.commit = {
                txid: commitTxId,
                vout: 0,
                value: Number(commitOutput.amount),
                script: commitOutput.script
            };
            console.log('[WalletContext] Commit output added to context');

            console.log('🔐 Signing Spell Transaction...');
            console.log('Anchor UTXO (Plan NFT) value:', dualUtxoContext.anchor.value, 'sats');
            console.log('Anchor UTXO ID:', dualUtxoContext.anchor.utxoId);
            console.log('Commit output value:', dualUtxoContext.commit.value, 'sats');
            console.log('Commit output TXID:', dualUtxoContext.commit.txid);

            const [anchorTxid, anchorVoutStr] = dualUtxoContext.anchor.utxoId.split(':');
            const anchorVout = parseInt(anchorVoutStr);
            
            const anchorTx = btc.RawTx.decode(hexToBytes(dualUtxoContext.anchor.hex));
            const actualAnchorScript = anchorTx.outputs[anchorVout].script;
            
            console.log('[WalletContext] Anchor Script decoded, length:', actualAnchorScript.length);
            
            const spellContext = {
                ...dualUtxoContext,
                isSingle: false
            };
            
            const spellPsbt = buildTaprootPsbt(
                spellRaw,
                anchorTxid,
                anchorVout,
                dualUtxoContext.anchor.value,
                actualAnchorScript,
                spellContext,
                taprootPublicKey
            );
            
            console.log('[WalletContext] Spell PSBT built, length:', spellPsbt.length);
            
            const spellRes = await (window as any).LeatherProvider.request("signPsbt", {
                hex: spellPsbt,
                network: "testnet",
                broadcast: false
            });
            console.log('[WalletContext] Spell signed, response received');

            console.log('[WalletContext] Dual-transaction mode: Stitching proof from original spell...');
            
            const spellTx = btc.Transaction.fromPSBT(
                hexToBytes(spellRes.result.hex),
                { allowUnknownOutputs: true }
            );
            const originalSpellTx = btc.RawTx.decode(hexToBytes(spellRaw));
            
            if (originalSpellTx.witnesses && originalSpellTx.witnesses.length > 0) {
                const proofWitness = originalSpellTx.witnesses[0];
                if (proofWitness && proofWitness.length > 0) {
                    spellTx.updateInput(1, { 
                        finalScriptWitness: proofWitness 
                    });
                    console.log(`✅ Restored ZK-Proof witness (length: ${proofWitness.length}) to Input 1`);
                } else {
                    console.warn('[WalletContext] Proof witness found but appears empty');
                }
            } else {
                console.warn('[WalletContext] No witnesses found in original spell');
            }

            const signedSpellHex = bytesToHex(spellTx.extract());
            console.log('✅ Spell transaction finalized, hex length:', signedSpellHex.length);

            let txidStrings: string[] = [];
            try {
                console.log('📤 Attempting broadcast...');
                const broadcastResponse = await axios.post('http://localhost:3002/api/broadcast-package', {
                    transactions: [signedCommitHex, signedSpellHex]
                });

                const data = broadcastResponse.data.txids;
                
                if (data && data['tx-results']) {
                    txidStrings = Object.values(data['tx-results']).map((res: any) => res.txid);
                    console.log('🎉 Broadcast successful! TXIDs:', txidStrings);
                } else if (Array.isArray(data)) {
                    txidStrings = data;
                    console.log('🎉 Broadcast successful! TXIDs:', txidStrings);
                } else {
                    console.warn('⚠️ Broadcast returned unexpected response format');
                }
                
                if (txidStrings.length > 0) {
                    const actualTxid = txidStrings[0];
                    console.log(`[WalletContext] Updating backend with actual txid: ${actualTxid}`);
                    
                    try {
                        const workerRecord = await axios.get(`http://localhost:3002/api/workers/${address}`);
                        const planId = workerRecord.data.planId;
                        
                        await axios.post('http://localhost:3002/api/workers/update-token-utxo', {
                            walletAddress: address,
                            planId: planId,
                            actualTxid: actualTxid,
                            voutIndex: 0
                        });
                        console.log('[WalletContext] ✅ Backend updated with actual txid');
                    } catch (updateError: any) {
                        console.error('[WalletContext] Failed to update backend:', updateError.message);
                    }
                }
            } catch (broadcastErr: any) {
                console.warn('⚠️ Broadcast deferred (Transaction likely requires more signatures):', broadcastErr.message);
            }

            console.groupEnd();
            
            return {
                txids: txidStrings,
                commitTxHex: signedCommitHex,
                spellTxHex: signedSpellHex
            };

        } catch (error: any) {
            const errorMessage = error.response?.data?.error || error.message;
            console.error('❌ Signing/Broadcasting failed:', errorMessage);
            console.groupEnd();
            throw new Error(errorMessage);
        }
    };

    return (
        <WalletContext.Provider value={{ 
            address, 
            walletConnected, 
            taprootPublicKey,
            connectWallet, 
            disconnectWallet, 
            signAndBroadcastPackage 
        }}>
            {children}
        </WalletContext.Provider>
    );
}

export const useWallet = () => {
    const context = useContext(WalletContext);
    if (!context) throw new Error("useWallet must be used within a WalletProvider");
    return context;
};