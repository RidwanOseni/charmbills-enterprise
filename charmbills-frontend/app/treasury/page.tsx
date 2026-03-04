'use client'

import { useState, useEffect } from 'react';
import axios from 'axios';
import { useWallet } from '@/lib/WalletContext';
import { getWalletStatus } from '@/lib/charms-utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { 
  ShieldAlert, 
  ShieldCheck, 
  Clock, 
  Loader2, 
  Wallet, 
  CheckCircle, 
  ExternalLink, 
  Activity, 
  Eye 
} from 'lucide-react';

export default function TreasuryPage() {
    const { address, walletConnected, signAndBroadcastPackage } = useWallet();
    
    // 1. PRODUCTION STATES
    const [pending, setPending] = useState<any[]>([]);
    const [audit, setAudit] = useState<any[]>([]);
    const [vaultBalance, setVaultBalance] = useState(0);
    const [isLoading, setIsLoading] = useState(true);
    const [isSigning, setIsSigning] = useState(false);

    // 2. DATA FETCHING: Real-time Treasury Data
    useEffect(() => {
        const fetchTreasuryData = async () => {
            if (!walletConnected) return;
            
            try {
                setIsLoading(true);
                // Fetch pending approvals (2-of-3 and 3-of-5)
                const pendingRes = await axios.get('/api/treasury/pending');
                setPending(pendingRes.data);

                // Fetch confirmed audit trail from indexer record
                const auditRes = await axios.get('/api/treasury/audit');
                setAudit(auditRes.data);

                // Fetch real on-chain balance from Treasury Address [1, 2]
                const treasuryAddr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS!;
                const status = await getWalletStatus(treasuryAddr);
                setVaultBalance(status.totalBalance);
            } catch (err) {
                console.error("Treasury fetch failed:", err);
            } finally {
                setIsLoading(false);
            }
        };

        fetchTreasuryData();
    }, [walletConnected]);

    // 3. SEQUENTIAL SIGNING FLOW [2, 3]
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
                await axios.post('/api/treasury/approve', {
                    multisigId: txRequest.id,
                    signerKey: address,
                    signedCommitHex: signedResult.commitTxHex,
                    signedSpellHex: signedResult.spellTxHex
                });

                alert("Signature applied! Threshold update synced with treasury.");
                // Refresh local data
                const res = await axios.get('/api/treasury/pending');
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

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
                {/* COLUMN 1: PENDING APPROVALS (OPERATIONAL & CORPORATE) [5] */}
                <div className="lg:col-span-1 space-y-6">
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
                                    />
                                ))
                            }
                        </CardContent>
                    </Card>

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
                                    />
                                ))
                            }
                        </CardContent>
                    </Card>
                </div>

                {/* COLUMN 2: VAULT BALANCE [5] */}
                <div className="lg:col-span-1">
                    <Card className="h-full">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Wallet className="w-5 h-5 text-secondary" /> 
                                Scroll Vaults
                            </CardTitle>
                        </CardHeader>
                        <CardContent className="space-y-6 pt-4">
                            <div className="text-center py-8 bg-muted/20 rounded-xl border border-dashed">
                                <p className="text-4xl font-bold text-primary">{(vaultBalance / 1e8).toFixed(4)} BTC</p>
                                <p className="text-sm text-muted-foreground mt-1">Total Locked Liquidity</p>
                            </div>
                            <div className="space-y-3">
                                <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Employee Allocation</span>
                                    <span className="font-mono font-medium">{(vaultBalance * 0.7 / 1e8).toFixed(4)} BTC</span>
                                </div>
                                <div className="flex justify-between text-sm">
                                    <span className="text-muted-foreground">Freelancer Escrow</span>
                                    <span className="font-mono font-medium">{(vaultBalance * 0.3 / 1e8).toFixed(4)} BTC</span>
                                </div>
                            </div>
                            <Button variant="outline" className="w-full text-xs" asChild>
                                <a 
                                    href={`https://mempool.space/testnet4/address/${process.env.NEXT_PUBLIC_TREASURY_ADDRESS}`} 
                                    target="_blank" 
                                    rel="noopener noreferrer"
                                >
                                    <ExternalLink className="w-3 h-3 mr-2" /> View on Bitcoin Explorer
                                </a>
                            </Button>
                        </CardContent>
                    </Card>
                </div>

                {/* COLUMN 3: AUDIT TRAIL [6] */}
                <div className="lg:col-span-1">
                    <Card className="h-full">
                        <CardHeader>
                            <CardTitle className="flex items-center gap-2">
                                <Activity className="w-5 h-5 text-primary" /> 
                                Audit Trail
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
                                            className="flex gap-3 text-xs p-3 hover:bg-muted/50 rounded-lg transition border border-transparent hover:border-border"
                                        >
                                            <div className="mt-1">
                                                <CheckCircle className="w-4 h-4 text-secondary" />
                                            </div>
                                            <div className="space-y-1 flex-1">
                                                <p className="font-bold uppercase">{log.type?.replace('-', ' ') || 'Transaction'}</p>
                                                <p className="text-muted-foreground">
                                                    {log.createdAt ? new Date(log.createdAt).toLocaleString() : 'Unknown date'}
                                                </p>
                                                {log.spellTxId && (
                                                    <a 
                                                        href={`https://mempool.space/testnet4/tx/${log.spellTxId}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-primary truncate max-w-[180px] font-mono text-xs hover:underline flex items-center gap-1"
                                                    >
                                                        TX: {log.spellTxId.substring(0, 16)}...
                                                        <ExternalLink className="w-3 h-3" />
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            </div>
        </div>
    );
}

// 4. HELPER COMPONENT: Reusable Approval Card [7, 8]
function ApprovalItem({ tx, onSign, isSigning }: { tx: any, onSign: () => void, isSigning: boolean }) {
    const signersCount = tx.signers?.length || 0;
    const threshold = tx.threshold || 3;
    const isReady = signersCount >= threshold;

    return (
        <div className="p-4 border rounded-lg space-y-3 bg-card">
            <div className="flex justify-between items-start">
                <p className="font-semibold text-sm">{tx.description || 'Unnamed Transaction'}</p>
                <Badge variant="secondary" className="text-[10px] uppercase">
                    {tx.type || 'pending'}
                </Badge>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground uppercase font-bold">
                Status: {signersCount}/{threshold} Signatures 
                {isReady && <span className="text-secondary ml-2">Ready to Broadcast ✓</span>}
            </div>
            <Button 
                onClick={onSign} 
                disabled={isSigning || isReady}
                className="w-full h-8 text-xs bg-primary hover:bg-primary/90 disabled:opacity-50"
            >
                {isSigning ? (
                    <Loader2 className="animate-spin w-3 h-3 mr-2" />
                ) : (
                    <Eye className="w-3 h-3 mr-2" />
                )}
                {isReady ? "Ready to Broadcast" : "Approve & Sign"}
            </Button>
        </div>
    );
}