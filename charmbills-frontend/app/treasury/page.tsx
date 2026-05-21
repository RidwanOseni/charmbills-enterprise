'use client'

import { useState, useEffect } from 'react';
import axios from 'axios';
import { useWallet } from '@/lib/WalletContext';
import { getWalletStatus } from '@/lib/charms-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { 
  ShieldAlert, 
  ShieldCheck, 
  Clock, 
  Loader2, 
  Wallet, 
  CheckCircle, 
  ExternalLink, 
  Activity, 
  Eye,
  PlusCircle,
  Lock,
  Users,
  User
} from 'lucide-react';
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// ============================================================
// PRODUCTION FIX: Create API client with correct backend port [Source 112, 163, 890]
// The backend runs on port 3002, not 3000
// ============================================================
const api = axios.create({
    baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002',
    timeout: 30000
});

// Testnet network configuration for @scure/btc-signer
const TESTNET = { bech32: 'tb', pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

// Mempool API endpoint
const MEMPOOL_API = "https://mempool.space/testnet4/api";

// Fallback Scroll Vault Address (used only if API fails)
const FALLBACK_VAULT_ADDRESS = "tb1qrk6da5g0592sx6lmgpchaf5qy2lgn8am7cuf3a";

export default function TreasuryPage() {
    const { address, walletConnected, taprootPublicKey, signAndBroadcastPackage } = useWallet();
    
    // 1. PRODUCTION STATES
    const [pending, setPending] = useState<any[]>([]);
    const [audit, setAudit] = useState<any[]>([]);
    const [vaultBalance, setVaultBalance] = useState(0);
    const [walletBalance, setWalletBalance] = useState(0); // User's personal wallet balance
    const [vaultStats, setVaultStats] = useState<any>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isSigning, setIsSigning] = useState(false);
    const [isLockingLiquidity, setIsLockingLiquidity] = useState(false);
    const [isBoardMember, setIsBoardMember] = useState(false);
    const [lockAmount, setLockAmount] = useState('50000'); // Default 50,000 sats

    // 2. DATA FETCHING: Real-time Treasury Data
    // CRITICAL FIX: Fetch vault stats FIRST, then use the isolated vault address to fetch balance [Source 181, 798]
    useEffect(() => {
        const fetchWalletAndTreasury = async () => {
            // Guard Clause: Only proceed if address is a string (wallet connected)
            if (!address) {
                console.log("[TREASURY] Wallet not connected, skipping data fetch");
                setIsLoading(false);
                return;
            }
            
            try {
                setIsLoading(true);
                
                console.log(`[TREASURY] Fetching data for address: ${address.substring(0, 20)}...`);
                
                // Step 1: Fetch user's personal wallet balance [Source 195]
                const walletStatus = await getWalletStatus(address);
                setWalletBalance(walletStatus.totalBalance);
                console.log(`[TREASURY] Manager wallet balance: ${walletStatus.totalBalance} sats`);
                
                // Step 2: Fetch pending approvals (2-of-3 and 3-of-5)
                const pendingRes = await api.get('/api/treasury/pending');
                setPending(pendingRes.data);
                
                // Step 3: Check if current wallet is a board member
                const isBoard = pendingRes.data.some((tx: any) => {
                    const signers = tx.signers || [];
                    return signers.includes(address);
                });
                setIsBoardMember(isBoard);

                // Step 4: Fetch confirmed audit trail from indexer record
                const auditRes = await api.get('/api/treasury/audit');
                setAudit(auditRes.data);
                
                // Step 5: Fetch vault statistics (allocations) FIRST - this gives us the isolated vault address
                const statsRes = await api.get(`/api/treasury/stats/${address}`);
                setVaultStats(statsRes.data);
                
                // Step 6: CRITICAL FIX - Use the isolated vault address from stats to fetch REAL balance
                const isolatedVaultAddress = statsRes.data.vaultAddress;
                if (isolatedVaultAddress) {
                    console.log(`[TREASURY] Fetching balance for isolated vault: ${isolatedVaultAddress}`);
                    const vaultStatus = await getWalletStatus(isolatedVaultAddress);
                    setVaultBalance(vaultStatus.totalBalance);
                    console.log(`[TREASURY] Isolated vault balance: ${vaultStatus.totalBalance} sats`);
                } else {
                    console.warn("[TREASURY] No vault address in stats, using fallback");
                    const fallbackAddr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || FALLBACK_VAULT_ADDRESS;
                    const vaultStatus = await getWalletStatus(fallbackAddr);
                    setVaultBalance(vaultStatus.totalBalance);
                }
                
            } catch (err) {
                console.error("Treasury fetch failed:", err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchWalletAndTreasury();
    }, [address]); // Re-run when address changes (e.g., on connect)

    // 3. LOCK LIQUIDITY: API-Relay Model - Signature only, broadcast via backend [Source 7, 871, 222-238]
    const handleLockLiquidity = async () => {
        console.log("[TREASURY] handleLockLiquidity started");
        
        if (!walletConnected) {
            alert("Please connect your wallet first");
            return;
        }
        
        if (!address) {
            alert("Wallet address not available");
            return;
        }
        
        if (!taprootPublicKey) {
            alert("Taproot public key not available. Please reconnect wallet.");
            return;
        }
        
        const amountSats = parseInt(lockAmount);
        if (isNaN(amountSats) || amountSats <= 0) {
            alert("Please enter a valid amount in satoshis");
            return;
        }
        
        const targetVaultAddress = vaultStats?.vaultAddress || FALLBACK_VAULT_ADDRESS;
        
        setIsLockingLiquidity(true);
        
        try {
            console.log(`[TREASURY] Locking ${amountSats} sats to Scroll Vault: ${targetVaultAddress}`);
            
            // Step 1: Fetch confirmed UTXOs from mempool
            console.log("[TREASURY] Fetching confirmed UTXOs from mempool...");
            const utxoResponse = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
            const allUtxos = utxoResponse.data;
            
            // Filter for confirmed UTXOs with enough value
            const confirmedUtxos = allUtxos.filter((u: any) => u.status?.confirmed === true && u.value > 5000);
            console.log(`[TREASURY] Found ${confirmedUtxos.length} confirmed UTXOs with value > 5000 sats`);
            
            if (confirmedUtxos.length === 0) {
                alert("No confirmed UTXOs found with sufficient funds. Please wait for confirmations or add funds.");
                return;
            }
            
            // Select the first suitable UTXO (simplest selection)
            const selectedUtxo = confirmedUtxos[0];
            console.log("[TREASURY] Selected UTXO:", {
                txid: selectedUtxo.txid,
                vout: selectedUtxo.vout,
                value: selectedUtxo.value,
                confirmed: selectedUtxo.status?.confirmed
            });
            
            // Step 2: Build the transaction context (Match Sequential Signing Architecture)
            console.log("[TREASURY] Building transaction...");
            const schnorrKey = hexToBytes(taprootPublicKey).slice(1);
            const payment = btc.p2tr(schnorrKey, undefined, TESTNET);
            
            const tx = new btc.Transaction();
            
            // Add input
            tx.addInput({
                txid: selectedUtxo.txid,
                index: selectedUtxo.vout,
                witnessUtxo: {
                    amount: BigInt(selectedUtxo.value),
                    script: payment.script
                },
                tapInternalKey: schnorrKey
            });
            console.log("[TREASURY] Input added");
            
            // Add output to vault address
            tx.addOutputAddress(targetVaultAddress, BigInt(amountSats), TESTNET);
            console.log(`[TREASURY] Output added: ${amountSats} sats to ${targetVaultAddress.substring(0, 20)}...`);
            
            // Calculate fee and change
            const estimatedFee = 1500n; // Conservative fee estimate for P2TR
            const changeAmount = BigInt(selectedUtxo.value) - BigInt(amountSats) - estimatedFee;
            
            if (changeAmount > 1000n) {
                tx.addOutputAddress(address, changeAmount, TESTNET);
                console.log(`[TREASURY] Change output added: ${changeAmount.toString()} sats back to ${address.substring(0, 20)}...`);
            } else {
                console.log(`[TREASURY] No change output (change amount ${changeAmount.toString()} < 1000 sats)`);
            }
            
            // Step 3: Request Signature ONLY (broadcast: false) [Source 222]
            const psbtHex = bytesToHex(tx.toPSBT());
            console.log("[TREASURY] PSBT created, length:", psbtHex.length);
            console.log("[TREASURY] Requesting wallet signature (broadcast: false)...");
            
            const signRes = await (window as any).LeatherProvider.request("signPsbt", {
                hex: psbtHex,
                network: "testnet",
                broadcast: false // ✅ CRITICAL: Do not let wallet broadcast
            });
            
            if (!signRes?.result?.hex) {
                throw new Error("No signed PSBT returned from wallet");
            }
            
            console.log("[TREASURY] Wallet signed successfully");
            console.log("[TREASURY] Signed PSBT length:", signRes.result.hex.length);
            
            // Step 4: MANUAL FINALIZATION (The "Google-Grade" Step) [Source 223, 224]
            console.log("[TREASURY] Finalizing transaction...");
            const signedTx = btc.Transaction.fromPSBT(hexToBytes(signRes.result.hex));
            signedTx.finalize();
            const finalRawHex = bytesToHex(signedTx.extract());
            console.log("[TREASURY] Final transaction hex length:", finalRawHex.length);
            
            // Step 5: BACKEND BROADCAST [Source 109, 238]
            // Use your existing broadcast-package endpoint which talks to your Testnet 4 node
            console.log("[TREASURY] Broadcasting via backend...");
            const broadcastRes = await api.post('/api/broadcast-package', {
                transactions: [finalRawHex]
            });
            
            const txids = broadcastRes.data?.txids;
            const txid = Array.isArray(txids) ? txids[0] : txids;
            
            if (txid) {
                console.log(`[TREASURY] ✅ Manual Broadcast Success! TXID: ${txid}`);
                alert(`✅ Liquidity Locked in Scroll Vault!\nTXID: ${txid.substring(0, 16)}...`);
                
                // Refresh balances
                console.log("[TREASURY] Refreshing balances...");
                const isolatedVaultAddress = vaultStats?.vaultAddress || FALLBACK_VAULT_ADDRESS;
                const vaultStatus = await getWalletStatus(isolatedVaultAddress);
                setVaultBalance(vaultStatus.totalBalance);
                
                const walletStatus = await getWalletStatus(address);
                setWalletBalance(walletStatus.totalBalance);
            } else {
                console.error("[TREASURY] No txid in broadcast response:", broadcastRes.data);
                alert("Transaction signed but broadcast failed. Check console for details.");
            }
            
        } catch (err: any) {
            console.error("[TREASURY] Lock liquidity failed:", err);
            alert(`Failed to lock liquidity: ${err.message || 'Unknown error'}`);
        } finally {
            setIsLockingLiquidity(false);
            console.log("[TREASURY] handleLockLiquidity finished");
        }
    };

    // 4. SEQUENTIAL SIGNING FLOW [2, 3]
    const handleMultisigApprove = async (txRequest: any) => {
        if (!walletConnected) {
            alert("Connect wallet first");
            return;
        }
        
        setIsSigning(true);
        try {
            // Wallet signs Commit + Spell dual package
            const signedResult = await signAndBroadcastPackage(
                { commitTxHex: txRequest.commitTxHex, spellTxHex: txRequest.spellTxHex },
                txRequest.dualUtxoContext
            );

            if (signedResult) {
                // Return cumulative signatures to backend persistence relay [4]
                await api.post('/api/treasury/approve', {
                    multisigId: txRequest.id,
                    signerAddress: address,
                    signedCommitHex: signedResult.commitTxHex,
                    signedSpellHex: signedResult.spellTxHex
                });

                alert("Signature applied! Threshold update synced with treasury.");
                // Refresh local data
                const res = await api.get('/api/treasury/pending');
                setPending(res.data);
            }
        } catch (err) {
            console.error("Multi-sig approval failed:", err);
            alert(`Approval failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
        } finally {
            setIsSigning(false);
        }
    };

    const operational = pending.filter(tx => tx.category === 'operational');
    const corporate = pending.filter(tx => tx.category === 'corporate');

    // =========================================================================
    // MODIFICATION: Separate ACTUAL from DESIRED state [Source 195, 938, 947]
    // - totalLockedSats: ACTUAL physical BTC in the isolated vault address
    // - requiredFundingSats: DESIRED target (allocation + buffer)
    // =========================================================================
    const actualBalance = vaultBalance;                                    // ACTUAL: Physical BTC in isolated vault
    const requiredFunding = vaultStats?.requiredFundingSats || 0;          // DESIRED: Target funding requirement
    const employeeAllocation = vaultStats?.employeeAllocationSats || 0;    // LIABILITY: Sum of active salaries
    const freelancerEscrow = vaultStats?.freelancerEscrowSats || 0;        // Escrow for freelancers
    const vaultAddress = vaultStats?.vaultAddress || FALLBACK_VAULT_ADDRESS; // Isolated vault address from backend

    if (isLoading) {
        return (
            <div className="container py-8 flex items-center justify-center min-h-[60vh]">
                <Loader2 className="w-8 h-8 animate-spin text-primary" />
            </div>
        );
    }

    return (
        <div className="container py-8 space-y-8">
            <div className="flex justify-between items-center">
                <h1 className="text-3xl font-bold text-primary">Institutional Treasury</h1>
                <Badge variant="outline" className="text-primary border-primary">
                    v0.12 Protocol Active
                </Badge>
            </div>

            {/* THREE-COLUMN GRID: Manager Wallet | Scroll Vault | Lock Liquidity [Source 195, 935] */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* COLUMN 1: MANAGER WALLET (The source of funding) [Source 195] */}
                <Card className="bg-slate-50 border-border">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <User className="w-5 h-5 text-primary" /> 
                            Manager Wallet
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-center py-4">
                            <p className="text-4xl font-bold text-primary">{(walletBalance / 1e8).toFixed(8)} BTC</p>
                            <p className="text-sm text-muted-foreground mt-1">Personal balance for funding payroll</p>
                            <p className="text-xs text-muted-foreground mt-2 break-all">
                                {address ? `${address.substring(0, 16)}...${address.substring(address.length - 8)}` : 'Not connected'}
                            </p>
                        </div>
                        <Button 
                            variant="outline" 
                            className="w-full text-xs mt-2"
                            onClick={() => {
                                navigator.clipboard.writeText(address || '');
                                alert('Address copied to clipboard');
                            }}
                        >
                            Copy Address
                        </Button>
                    </CardContent>
                </Card>

                {/* COLUMN 2: SCROLL VAULT (The actual liquidity) [Source 195, 935] */}
                <Card className="border-blue-200">
                    <CardHeader className="pb-3">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Wallet className="w-5 h-5 text-blue-600" /> 
                            Scroll Vault (ACTUAL)
                        </CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="text-center py-4">
                            <p className="text-4xl font-bold text-blue-700">{(actualBalance / 1e8).toFixed(8)} BTC</p>
                            <p className="text-sm text-blue-600 mt-1">Locked in Scroll Contract</p>
                            <p className="text-xs text-muted-foreground mt-2">
                                Vault: <span className="font-mono">{vaultAddress.substring(0, 12)}...</span>
                            </p>
                        </div>
                        <Button variant="outline" className="w-full text-xs mt-2" asChild>
                            <a 
                                href={`https://mempool.space/testnet4/address/${vaultAddress}`} 
                                target="_blank" 
                                rel="noopener noreferrer"
                            >
                                <ExternalLink className="w-3 h-3 mr-2" /> View on Bitcoin Explorer
                            </a>
                        </Button>
                    </CardContent>
                </Card>

                {/* COLUMN 3: LOCK LIQUIDITY (The desired state / funding UI) [Source 195, 935] */}
                <Card>
                    <CardHeader className="pb-3">
                        <CardTitle className="text-lg flex items-center gap-2">
                            <Lock className="w-5 h-5 text-secondary" /> 
                            Lock Liquidity
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Target Funding Requirement Display */}
                        <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
                            <p className="text-xs font-bold text-amber-700 uppercase mb-2">Funding Requirement:</p>
                            <div className="space-y-1">
                                <p className="text-sm font-bold text-amber-800">
                                    {requiredFunding.toLocaleString()} sats
                                </p>
                                <p className="text-[10px] text-amber-600">
                                    Current confirmed: {actualBalance.toLocaleString()} sats
                                </p>
                                <div className="flex justify-between text-[10px] text-amber-600 pt-1 border-t border-amber-200 mt-1">
                                    <span>Employee Liabilities:</span>
                                    <span className="font-mono">{employeeAllocation.toLocaleString()} sats</span>
                                </div>
                                <div className="flex justify-between text-[10px] text-amber-600">
                                    <span>Freelancer Escrow:</span>
                                    <span className="font-mono">{freelancerEscrow.toLocaleString()} sats</span>
                                </div>
                            </div>
                        </div>

                        {/* Lock Liquidity Input */}
                        <div>
                            <p className="text-sm font-medium text-foreground mb-2 flex items-center gap-2">
                                <PlusCircle className="w-4 h-4 text-secondary" />
                                Add Liquidity to Scroll Vault
                            </p>
                            <div className="flex gap-2">
                                <input
                                    type="number"
                                    value={lockAmount}
                                    onChange={(e) => setLockAmount(e.target.value)}
                                    placeholder="Amount in sats"
                                    className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background text-foreground focus:outline-none focus:ring-2 focus:ring-primary"
                                    disabled={isLockingLiquidity}
                                />
                                <Button 
                                    onClick={handleLockLiquidity} 
                                    disabled={isLockingLiquidity || !walletConnected}
                                    className="bg-secondary hover:bg-secondary/90 text-secondary-foreground"
                                >
                                    {isLockingLiquidity ? (
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                    ) : (
                                        <PlusCircle className="w-4 h-4" />
                                    )}
                                    <span className="ml-2">Send</span>
                                </Button>
                            </div>
                            <p className="text-xs text-muted-foreground mt-2">
                                Vault Address: <span className="font-mono">{vaultAddress.substring(0, 16)}...</span>
                            </p>
                        </div>

                        {/* Gap Analysis (if any) */}
                        {requiredFunding > 0 && actualBalance < requiredFunding && (
                            <div className="p-2 bg-yellow-50 rounded-lg border border-yellow-200">
                                <p className="text-xs text-yellow-700">
                                    ⚠️ Funding gap: {(requiredFunding - actualBalance).toLocaleString()} sats needed to reach target.
                                </p>
                            </div>
                        )}
                        {requiredFunding > 0 && actualBalance >= requiredFunding && (
                            <div className="p-2 bg-green-50 rounded-lg border border-green-200">
                                <p className="text-xs text-green-700">
                                    ✅ Fully funded! Vault meets all payroll obligations.
                                </p>
                            </div>
                        )}
                    </CardContent>
                </Card>
            </div>

            {/* REMAINING TWO-COLUMN GRID: PENDING APPROVALS & AUDIT TRAIL */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* COLUMN: PENDING APPROVALS (OPERATIONAL & CORPORATE) [5] */}
                <div className="space-y-6">
                    <Card>
                        <CardHeader className="bg-muted/30">
                            <CardTitle className="text-lg flex items-center gap-2">
                                <ShieldCheck className="w-5 h-5 text-primary" /> 
                                Operational (2-of-3)
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-4">
                            {operational.length === 0 ? 
                                <p className="text-xs text-muted-foreground text-center py-4">No pending hires or plans.</p> :
                                operational.map(tx => (
                                    <ApprovalItem 
                                        key={tx.id} 
                                        tx={tx} 
                                        onSign={() => handleMultisigApprove(tx)} 
                                        isSigning={isSigning}
                                        currentAddress={address}
                                    />
                                ))
                            }
                        </CardContent>
                    </Card>

                    {/* BOARD OVERRIDES SECTION - Corporate (3-of-5) with Board Member Status [Source 871, 878] */}
                    <Card className="border-destructive/20">
                        <CardHeader className="bg-destructive/5">
                            <CardTitle className="text-lg flex items-center gap-2 text-destructive">
                                <ShieldAlert className="w-5 h-5" /> 
                                Board Overrides (3-of-5)
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="pt-4 space-y-4">
                            {corporate.length === 0 ? 
                                <p className="text-xs text-muted-foreground text-center py-4">No emergency freezes pending.</p> :
                                corporate.map(tx => (
                                    <ApprovalItem 
                                        key={tx.id} 
                                        tx={tx} 
                                        onSign={() => handleMultisigApprove(tx)} 
                                        isSigning={isSigning}
                                        currentAddress={address}
                                        isBoardOverride={true}
                                    />
                                ))
                            }
                            {!isBoardMember && corporate.length > 0 && (
                                <div className="mt-3 p-3 bg-muted/20 rounded-lg border border-border">
                                    <p className="text-xs text-muted-foreground text-center flex items-center justify-center gap-2">
                                        <Users className="w-3 h-3" />
                                        Board member wallet required to sign overrides
                                    </p>
                                </div>
                            )}
                        </CardContent>
                    </Card>
                </div>

                {/* COLUMN: AUDIT TRAIL (RECONCILED) [6, 879] */}
                <Card className="h-full">
                    <CardHeader>
                        <CardTitle className="flex items-center gap-2">
                            <Activity className="w-5 h-5 text-primary" /> 
                            Audit Trail (Reconciled)
                        </CardTitle>
                    </CardHeader>
                    <CardContent className="pt-4">
                        <div className="space-y-4">
                            {audit.length === 0 ? (
                                <p className="text-xs text-muted-foreground text-center py-4">No audit records found.</p>
                            ) : (
                                audit.map((log) => (
                                    <div 
                                        key={log.id} 
                                        className="flex justify-between items-center text-xs p-3 hover:bg-muted/50 rounded-lg transition border border-transparent hover:border-border"
                                    >
                                        <div>
                                            <p className="font-bold uppercase">{log.type?.replace('-', ' ') || log.type || 'Transaction'}</p>
                                            <p className="text-muted-foreground text-[10px]">
                                                {log.createdAt ? new Date(log.createdAt).toLocaleString() : log.timestamp ? new Date(log.timestamp).toLocaleString() : 'Unknown date'}
                                            </p>
                                            {log.txid && (
                                                <a 
                                                    href={`https://mempool.space/testnet4/tx/${log.txid}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="text-primary truncate max-w-[150px] font-mono text-[10px] hover:underline flex items-center gap-1 mt-1"
                                                >
                                                    TX: {log.txid.substring(0, 12)}...
                                                    <ExternalLink className="w-3 h-3" />
                                                </a>
                                            )}
                                        </div>
                                        <Badge variant={log.status === 'confirmed' ? 'default' : 'outline'} className="text-[10px]">
                                            {log.status || 'pending'}
                                        </Badge>
                                    </div>
                                ))
                            )}
                        </div>
                    </CardContent>
                </Card>
            </div>
        </div>
    );
}

// 4. HELPER COMPONENT: Reusable Approval Card with Board Override Support [7, 8, 878]
interface ApprovalItemProps {
    tx: any;
    onSign: () => void;
    isSigning: boolean;
    currentAddress?: string | null;
    isBoardOverride?: boolean;
}

function ApprovalItem({ tx, onSign, isSigning, currentAddress, isBoardOverride }: ApprovalItemProps) {
    const signersCount = tx.signers?.length || 0;
    const threshold = tx.threshold || (isBoardOverride ? 3 : 2);
    const isReady = signersCount >= threshold;
    
    // Check if current user has already signed
    const hasSigned = currentAddress && tx.signers?.includes(currentAddress);
    const canSign = !isReady && !hasSigned && !isSigning;
    
    // Determine button text based on state
    let buttonText = "Approve & Sign";
    let buttonDisabled = true;
    
    if (hasSigned) {
        buttonText = "Already Signed";
        buttonDisabled = true;
    } else if (isReady) {
        buttonText = "Ready to Broadcast";
        buttonDisabled = true;
    } else if (canSign) {
        buttonText = isBoardOverride ? "Sign Board Override" : "Approve & Sign";
        buttonDisabled = false;
    }

    return (
        <div className="p-4 border rounded-lg space-y-3 bg-card">
            <div className="flex justify-between items-start">
                <p className="font-semibold text-sm">{tx.description || tx.type || 'Unnamed Transaction'}</p>
                <Badge variant="secondary" className="text-[10px] uppercase">
                    {tx.type || 'pending'}
                </Badge>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase font-bold">
                <Clock className="w-3 h-3" />
                Status: {signersCount}/{threshold} Signatures 
                {isReady && <span className="text-secondary ml-2">✓ Ready</span>}
                {hasSigned && <span className="text-primary ml-2">✓ You signed</span>}
            </div>
            <Button 
                onClick={onSign} 
                disabled={buttonDisabled}
                className={`w-full h-8 text-xs ${!buttonDisabled ? 'bg-primary hover:bg-primary/90' : 'opacity-50'}`}
            >
                {isSigning ? (
                    <Loader2 className="animate-spin w-3 h-3 mr-2" />
                ) : (
                    <Eye className="w-3 h-3 mr-2" />
                )}
                {buttonText}
            </Button>
        </div>
    );
}