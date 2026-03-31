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

    console.log('[buildTaprootPsbt] Decoded transaction:', {
        inputs: decoded.inputs.length,
        outputs: decoded.outputs.length,
        witnesses: decoded.witnesses?.length || 0,
        isSingle: context.isSingle,
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

    // Map inputs
    decoded.inputs.forEach((input, i) => {
        if (i === 0) {
            console.log('[buildTaprootPsbt] Adding Input 0 (Anchor):', {
                txid: targetTxid,
                vout: targetVout,
                value: targetValue
            });
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
        } else if (i === 1) {
            if (context.isSingle) {
                // v0.12 MODE: Mapping Input 1 to the Fee UTXO for signing
                if (!context.fee) {
                    throw new Error('Missing fee UTXO context for PSBT input 1 in v0.12 mode');
                }
                const [feeTxid, feeVoutStr] = context.fee.utxoId.split(':');
                const vout = parseInt(feeVoutStr);
                
                console.log('[buildTaprootPsbt] v0.12: Adding Input 1 (Fee UTXO):', {
                    txid: feeTxid,
                    vout: vout,
                    value: context.fee.value
                });
                
                psbt.addInput({
                    txid: feeTxid,
                    index: vout,
                    witnessUtxo: {
                        amount: BigInt(context.fee.value),
                        script: payment.script
                    },
                    tapInternalKey: payment.tapInternalKey,
                    sequence: input.sequence
                });
            } else {
                // v11 MODE: Input 1 spends the finalized Commit TX (no tapInternalKey needed)
                if (!context.commit) {
                    throw new Error('Missing commit UTXO context for PSBT input 1 in v11 mode');
                }
                console.log('[buildTaprootPsbt] v11: Adding Input 1 (Commit Output):', {
                    txid: context.commit.txid,
                    vout: context.commit.vout,
                    value: context.commit.value
                });
                
                psbt.addInput({
                    txid: context.commit.txid,
                    index: context.commit.vout,
                    witnessUtxo: {
                        amount: BigInt(context.commit.value),
                        script: context.commit.script
                    },
                    // NO tapInternalKey for v11 mode - this input is pre-signed by ZK-prover
                    sequence: input.sequence
                });
            }
        } else {
            console.warn('[buildTaprootPsbt] Unexpected input index:', i);
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
    console.log('[buildCommitPsbt] Anchor UTXO:', {
        utxoId: anchorUtxo.utxoId,
        value: anchorUtxo.value
    });
    console.log('[buildCommitPsbt] Fee UTXO:', {
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
    
    console.log('[buildCommitPsbt] Adding anchor UTXO as input 0:', { txid: anchorTxid, vout: anchorVout, value: anchorUtxo.value });
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
    
    console.log('[buildCommitPsbt] Adding fee UTXO as input 1:', { txid: feeTxid, vout: feeVout, value: feeUtxo.value });
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
                    hasHex: !!dualUtxoContext.anchor.hex
                } : null,
                fee: dualUtxoContext.fee ? {
                    utxoId: dualUtxoContext.fee.utxoId,
                    value: dualUtxoContext.fee.value,
                    hasHex: !!dualUtxoContext.fee.hex
                } : null,
                isSingle: proverResult.isSingle
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
                
                const singleTxContext = {
                    ...dualUtxoContext,
                    isSingle: true
                };
                
                const combinedPsbt = buildTaprootPsbt(
                    spellRaw,
                    anchorTxid,
                    anchorVout,
                    dualUtxoContext.anchor.value,
                    actualAnchorScript,
                    singleTxContext,
                    taprootPublicKey
                );
                
                // CRITICAL FIX: Allow wallet to sign BOTH inputs (Anchor + Fee)
                // DO NOT pass signAtIndex - both inputs belong to the wallet
                const signedRes = await (window as any).LeatherProvider.request("signPsbt", {
                    hex: combinedPsbt,
                    network: "testnet",
                    broadcast: false
                    // REMOVED: signAtIndex - wallet signs all inputs it owns
                });
                
                console.log('[WalletContext] Single-transaction mode: Proof is in OP_RETURN output. Finalizing...');
                
                // Create transaction object from the PSBT returned by the wallet
                const spellTransaction = btc.Transaction.fromPSBT(
                    hexToBytes(signedRes.result.hex),
                    { allowUnknownOutputs: true }
                );
                
                // Now finalize will succeed because both inputs have signatures
                spellTransaction.finalize();
                const finalizedHex = bytesToHex(spellTransaction.extract());
                
                console.log('✅ Combined transaction finalized successfully, hex length:', finalizedHex.length);
                
                let txidStrings: string[] = [];
                try {
                    console.log('📤 Broadcasting single transaction...');
                    // CRITICAL FIX: Use port 3002 to match backend server
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
            console.log('Anchor UTXO value:', dualUtxoContext.anchor.value, 'sats');
            console.log('Anchor UTXO ID:', dualUtxoContext.anchor.utxoId);
            console.log('Fee UTXO value:', dualUtxoContext.fee.value, 'sats');
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
            console.log('Anchor UTXO value:', dualUtxoContext.anchor.value, 'sats');
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
                broadcast: false,
                signAtIndex: 0
            });
            console.log('[WalletContext] Spell signed, response received');

            // For dual-transaction mode, we still need to stitch the proof
            console.log('[WalletContext] Dual-transaction mode: Stitching proof from original spell...');
            
            const spellTx = btc.Transaction.fromPSBT(
                hexToBytes(spellRes.result.hex),
                { allowUnknownOutputs: true }
            );
            const originalSpellTx = btc.RawTx.decode(hexToBytes(spellRaw));
            
            // Find proof by looking for large witness (dual-transaction mode)
            const availableWitnesses = originalSpellTx.witnesses || [];
            console.log('[WalletContext] Available witnesses count:', availableWitnesses.length);
            
            const proofWitness = availableWitnesses.find(w => w && w.length > 0);
            
            if (proofWitness) {
                const targetInputIndex = availableWitnesses.length === 1 ? 0 : 1;
                spellTx.updateInput(targetInputIndex, { finalScriptWitness: proofWitness });
                console.log(`✅ Charms proof (length: ${proofWitness.length}) re-attached to input ${targetInputIndex}.`);
            } else {
                console.error('[WalletContext] No proof witness found in original spell');
                throw new Error('Missing Charms proof witness');
            }

            const signedSpellHex = bytesToHex(spellTx.extract());
            console.log('✅ Spell transaction finalized, hex length:', signedSpellHex.length);

            let txidStrings: string[] = [];
            try {
                console.log('📤 Attempting broadcast...');
                // CRITICAL FIX: Use port 3002 for dual-transaction broadcast as well
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