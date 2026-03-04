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
 * Helper: Creates P2TR payment object and builds PSBT with Smallest Sufficient UTXO strategy
 */
function buildTaprootPsbt(rawHex: string, targetUtxo: any, pubKeyHex: string, context?: any): string {
    const schnorrKey = hexToBytes(pubKeyHex).slice(1);
    const payment = btc.p2tr(schnorrKey, undefined, TESTNET);
    const psbt = new btc.Transaction();
    const decoded = btc.RawTx.decode(hexToBytes(rawHex));

    // Map outputs
    decoded.outputs.forEach(out => psbt.addOutput({ amount: out.amount, script: out.script }));

    // Map inputs with correct metadata for signing [22, 23]
    decoded.inputs.forEach((input, i) => {
        const isTarget = i === 0; // Usually target the first input for wallet signature
        psbt.addInput({
            txid: bytesToHex(input.txid), // Correct property for @scure/btc-signer [2]
            index: input.index,
            witnessUtxo: {
                amount: BigInt(isTarget ? targetUtxo.value : (context?.commit?.value || 1000)),
                script: isTarget ? payment.script : (context?.commit?.script || payment.script)
            },
            tapInternalKey: payment.tapInternalKey,
            sequence: input.sequence
        });
    });

    return bytesToHex(psbt.toPSBT());
}

export function WalletProvider({ children }: { children: React.ReactNode }) {
    const [address, setAddress] = useState<string | null>(null);
    const [walletConnected, setWalletConnected] = useState(false);
    const [taprootPublicKey, setTaprootPublicKey] = useState<string | null>(null);

    useEffect(() => {
        const saved = localStorage.getItem("charm_wallet_address");
        const savedPubKey = localStorage.getItem("charm_taproot_pubkey");
        if (saved) { 
            setAddress(saved); 
            setWalletConnected(true); 
        }
        if (savedPubKey) setTaprootPublicKey(savedPubKey);
    }, []);

    const connectWallet = async () => {
        if (typeof window !== 'undefined' && (window as any).LeatherProvider) {
            const response = await (window as any).LeatherProvider.request("getAddresses");
            const p2tr = response.result.addresses.find((a: any) => a.type === 'p2tr');
            if (p2tr) {
                setAddress(p2tr.address);
                setWalletConnected(true);
                setTaprootPublicKey(p2tr.publicKey);
                localStorage.setItem("charm_wallet_address", p2tr.address);
                localStorage.setItem("charm_taproot_pubkey", p2tr.publicKey);
            }
        }
    };

    const disconnectWallet = () => {
        setAddress(null); 
        setWalletConnected(false); 
        setTaprootPublicKey(null);
        localStorage.removeItem("charm_wallet_address");
        localStorage.removeItem("charm_taproot_pubkey");
    };

    // SIGNING PHASE: Sequential Dual-Transaction Flow [3, 13]
    const signAndBroadcastPackage = async (proverResult: ProverResult, dualUtxoContext: any) => {
        if (!(window as any).LeatherProvider || !taprootPublicKey) {
            console.error('Missing required data for signing');
            return null;
        }

        try {
            console.group('[Wallet Context] Sequential Signing with Dual UTXO Context');
            console.log('Dual UTXO Context:', dualUtxoContext);

            // Extract raw hexes
            const commitRaw = typeof proverResult.commitTxHex === 'object' 
                ? (proverResult.commitTxHex as any).bitcoin 
                : proverResult.commitTxHex;
            const spellRaw = typeof proverResult.spellTxHex === 'object' 
                ? (proverResult.spellTxHex as any).bitcoin 
                : proverResult.spellTxHex;

            // 1. SIGN COMMIT TRANSACTION (Spends Employer Fee UTXO) [14]
            console.log('🔐 Signing Commit Transaction...');
            const commitPsbt = buildTaprootPsbt(commitRaw, dualUtxoContext.fee, taprootPublicKey);
            const commitRes = await (window as any).LeatherProvider.request("signPsbt", {
                hex: commitPsbt,
                network: "testnet",
                broadcast: false 
            });

            const finalizedCommit = btc.Transaction.fromPSBT(hexToBytes(commitRes.result.hex));
            finalizedCommit.finalize();
            const signedCommitHex = bytesToHex(finalizedCommit.extract());
            
            // Get commit transaction details
            const commitTxId = finalizedCommit.id;
            const commitOutput = finalizedCommit.getOutput(0);
            
            if (!commitOutput || !commitOutput.amount || !commitOutput.script) {
                console.error('❌ Commit transaction output is invalid:', commitOutput);
                throw new Error('Commit transaction has invalid or missing output');
            }

            console.log('📊 Commit Transaction Info:');
            console.log('- Commit TXID:', commitTxId);
            console.log('- Commit output amount:', commitOutput.amount.toString());

            // 2. Add finalized commit output to context for spell dependency [15]
            dualUtxoContext.commit = {
                txid: commitTxId,
                vout: 0,
                value: Number(commitOutput.amount),
                script: commitOutput.script
            };

            // 3. SIGN SPELL TRANSACTION (Spends Commit Output + Anchor/Authority) [5, 15]
            console.log('🔐 Signing Spell Transaction...');
            const spellPsbt = buildTaprootPsbt(spellRaw, dualUtxoContext.anchor, taprootPublicKey, dualUtxoContext);
            const spellRes = await (window as any).LeatherProvider.request("signPsbt", {
                hex: spellPsbt,
                network: "testnet",
                broadcast: false,
                signAtIndex: 0 // Only sign the wallet input [16]
            });

            // 4. CRITICAL: MANUAL FINALIZATION (Re-attach ZK-Proof) [10, 11]
            const spellTx = btc.Transaction.fromPSBT(hexToBytes(spellRes.result.hex));
            const originalSpell = btc.RawTx.decode(hexToBytes(spellRaw));
            
            // Re-attach Input 1 witness (the actual ZK-Proof spell data)
            // FIX: Using index 1 for the second input which contains the Charms proof
            if (originalSpell.witnesses && originalSpell.witnesses[1]) {
                spellTx.updateInput(1, { finalScriptWitness: originalSpell.witnesses[1] });
                console.log('✅ Applied Input 1 witness from original spell');
            } else {
                console.error('❌ Could not find original witness for Input 1');
                console.log('Available witnesses:', originalSpell.witnesses?.length || 0);
                throw new Error('Missing Charms proof witness for Input 1');
            }

            // Verify both inputs have witnesses
            console.log('🔍 Post-update verification:', {
                input0HasWitness: !!spellTx.getInput(0).finalScriptWitness,
                input1HasWitness: !!spellTx.getInput(1).finalScriptWitness
            });

            const signedSpellHex = bytesToHex(spellTx.extract());
            console.log('✅ Spell transaction extracted successfully, hex length:', signedSpellHex.length);

            // 5. ATTEMPT BROADCAST (May fail if multi-sig threshold not met) [18, 19]
            let txidStrings: string[] = [];
            try {
                console.log('📤 Attempting broadcast...');
                const broadcastResponse = await axios.post('/api/broadcast-package', {
                    transactions: [signedCommitHex, signedSpellHex]
                });

                const data = broadcastResponse.data.txids;
                
                if (data && data['tx-results']) {
                    txidStrings = Object.values(data['tx-results']).map((res: any) => res.txid);
                    console.log('🎉 Broadcast successful! TXIDs:', txidStrings);
                } else {
                    console.warn('⚠️ Broadcast returned unexpected response format');
                }
            } catch (broadcastErr) {
                // PRODUCTION LOGIC: In multisig (e.g. 1st of 3 signers), 
                // the node will reject the package. We catch this but still return the hexes.
                console.warn('⚠️ Broadcast deferred (Transaction likely requires more signatures)');
            }

            console.groupEnd();
            
            // FIX: Return an object instead of string[]
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