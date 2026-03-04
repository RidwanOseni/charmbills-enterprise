'use client'

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useWallet } from '@/lib/WalletContext';
import { scanAddressForCharms } from '@/lib/charms-utils';
import { decryptPayrollData } from '../../shared/encryption';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet, CheckCircle, FileText, Lock, Loader2 } from 'lucide-react';

export default function WorkerPortal() {
    const { address, walletConnected, connectWallet, disconnectWallet } = useWallet();
    
    // State for Sovereign Data
    const [tokens, setTokens] = useState<any[]>([]);
    const [metadata, setMetadata] = useState<any>(null);
    const [isScanning, setIsScanning] = useState(false);
    const [isDecrypting, setIsDecrypting] = useState(false);

    // 1. AUTOMATIC VERIFICATION: Scan for CHARMS-PAY tokens [2]
    useEffect(() => {
        const verifySovereignty = async () => {
            if (!walletConnected || !address) return;
            setIsScanning(true);
            try {
                // Trustless scan using v12 WASM bridge [5, 6]
                const charms = await scanAddressForCharms(address);
                setTokens(charms);
            } catch (err) {
                console.error("On-chain verification failed:", err);
            } finally {
                setIsScanning(false);
            }
        };
        verifySovereignty();
    }, [address, walletConnected]);

    // 2. PRIVACY LAYER: Fetch and Decrypt Metadata [2, 3]
    const handleUnlockData = async () => {
        if (!address) return;
        setIsDecrypting(true);
        try {
            // A. Get the encrypted CID from backend relay
            const res = await axios.get(`/api/worker-metadata/${address}`);
            const { cid } = res.data;

            // B. Get encrypted blob from IPFS
            const ipfsRes = await axios.get(`https://gateway.pinata.cloud/ipfs/${cid}`);
            const encryptedBlob = ipfsRes.data;

            // C. Non-Custodial Decryption: Request worker's signature for entropy [7]
            const signatureResponse = await (window as any).LeatherProvider.request("signMessage", {
                message: "CharmBills Worker Privacy Access v1",
                paymentType: "p2tr",
                network: "testnet"
            });

            // D. Local Decryption (Key never leaves the browser) [8]
            const decrypted = decryptPayrollData(encryptedBlob, signatureResponse.result.signature);
            setMetadata(decrypted);
        } catch (err) {
            console.error("Decryption failed:", err);
        } finally {
            setIsDecrypting(false);
        }
    };

    if (!walletConnected) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center justify-center gap-4 max-w-md mx-auto p-8">
                    <Lock className="w-12 h-12 text-muted-foreground" />
                    <h1 className="text-2xl font-bold text-primary">Worker Portal Secure</h1>
                    <p className="text-muted-foreground text-center">Connect your Taproot wallet to verify your employment and access private data.</p>
                    <Button onClick={connectWallet} className="mt-4">Connect Wallet</Button>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background">
            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-6 py-12">
                {/* Welcome Section - Dynamic Name [2] */}
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-4xl font-bold text-primary mb-2">
                            Welcome back, {metadata?.employeeName || (address ? `${address.substring(0, 8)}...` : 'Worker')}
                        </h1>
                        <p className="text-foreground text-lg">Manage your employment and track payments trustlessly.</p>
                    </div>
                    {!metadata && (
                        <Button onClick={handleUnlockData} disabled={isDecrypting} variant="outline" className="gap-2 rounded-lg">
                            {isDecrypting ? <Loader2 className="animate-spin w-4 h-4" /> : <Lock className="w-4 h-4" />}
                            {isDecrypting ? 'Decrypting...' : 'Unlock Private Data'}
                        </Button>
                    )}
                </div>

                {/* Main Dashboard Card */}
                <Card className="bg-card border border-border rounded-xl overflow-hidden mb-12">
                    <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-8 border-b border-border">
                        <div className="flex items-start justify-between mb-8">
                            <div>
                                <div className="flex items-center gap-3 mb-2">
                                    <div className={`p-2 rounded-full ${tokens.length > 0 ? 'bg-secondary/20' : 'bg-yellow-100'}`}>
                                        <CheckCircle className={`w-8 h-8 ${tokens.length > 0 ? 'text-secondary' : 'text-yellow-600'}`} />
                                    </div>
                                    <div>
                                        <p className="text-sm text-muted-foreground">Status</p>
                                        <p className="text-2xl font-bold text-secondary">
                                            {tokens.length > 0 ? 'Active' : 'Awaiting Enrollment'}
                                        </p>
                                    </div>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {tokens.length > 0 ? `Verified on Bitcoin (Testnet4)` : 'No active tokens found in wallet'}
                                </p>
                            </div>
                        </div>

                        <div className="grid md:grid-cols-3 gap-8">
                            {/* Next Payment */}
                            <div>
                                <p className="text-sm text-muted-foreground mb-2">Next automatic payment</p>
                                <p className="text-2xl font-bold text-primary">
                                    {metadata?.payPeriodSeconds ? 'Calculated by Scroll' : 'Pending Unlock'}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">Automatically triggered by Scroll</p>
                            </div>

                            {/* Salary */}
                            <div>
                                <p className="text-sm text-muted-foreground mb-2">Your salary</p>
                                <p className="text-2xl font-bold text-primary">
                                    {metadata ? `${metadata.baseSalarySats.toLocaleString()} sats` : '•••••••• sats'}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">Private, visible only to you</p>
                            </div>

                            {/* Salary Visibility */}
                            <div className="flex items-start gap-3">
                                <Lock className="w-6 h-6 text-accent flex-shrink-0 mt-1" />
                                <div>
                                    <p className="text-sm text-muted-foreground mb-1">Payment Privacy</p>
                                    <p className="font-medium text-foreground">Encrypted and private</p>
                                </div>
                            </div>
                        </div>
                    </div>

                    {/* Details Section */}
                    <div className="p-8">
                        <h2 className="text-lg font-bold text-primary mb-6">Employment Details</h2>
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="pb-6 border-b border-border md:border-b-0 md:border-r">
                                <p className="text-sm text-muted-foreground mb-2">Role</p>
                                <p className="text-lg font-semibold text-foreground">{metadata?.role || 'Locked'}</p>
                            </div>
                            <div className="pb-6 border-b border-border md:border-b-0">
                                <p className="text-sm text-muted-foreground mb-2">Department</p>
                                <p className="text-lg font-semibold text-foreground">{metadata?.department || 'Locked'}</p>
                            </div>
                            <div className="pb-6">
                                <p className="text-sm text-muted-foreground mb-2">Pay Frequency</p>
                                <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">
                                    {metadata?.uiTemplate === 'employee' ? 'Time-based' : 'Proof-based'}
                                </Badge>
                            </div>
                            <div className="pb-6">
                                <p className="text-sm text-muted-foreground mb-2">Employment Type</p>
                                <p className="text-lg font-semibold text-foreground">
                                    {metadata?.engagementType === 0 ? 'Full-time' : 
                                     metadata?.engagementType === 1 ? 'Part-time' :
                                     metadata?.engagementType === 2 ? 'Freelancer' : 'Employee'}
                                </p>
                            </div>
                        </div>
                    </div>
                </Card>

                {/* Freelancer Section (Conditional) */}
                {metadata?.uiTemplate === 'freelancer' && (
                    <Card className="bg-card border border-border rounded-xl p-8 mb-12">
                        <div className="flex items-center gap-3 mb-6">
                            <FileText className="w-6 h-6 text-secondary" />
                            <h2 className="text-2xl font-bold text-primary">Submit Work</h2>
                        </div>

                        <div className="border-2 border-dashed border-border rounded-lg p-8 text-center mb-6 hover:border-secondary/50 transition cursor-pointer">
                            <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                            <p className="text-foreground font-medium mb-2">Drag and drop your files here</p>
                            <p className="text-sm text-muted-foreground mb-4">or click to browse</p>
                            <Button variant="outline" className="rounded-lg">
                                Select Files
                            </Button>
                        </div>

                        <div className="bg-muted/30 rounded-lg p-4 border border-border mb-6">
                            <div className="flex items-center justify-between">
                                <div>
                                    <p className="font-medium text-foreground">Status</p>
                                    <Badge className="bg-yellow-100 text-yellow-700 mt-2 rounded-full px-3 py-1">
                                        Awaiting Approval
                                    </Badge>
                                </div>
                                <FileText className="w-8 h-8 text-muted-foreground" />
                            </div>
                        </div>

                        <Button className="w-full bg-secondary hover:bg-secondary/90 text-secondary-foreground font-semibold py-2 rounded-lg">
                            Submit for Review
                        </Button>
                    </Card>
                )}

                {/* Payment History - Mapped from On-chain Scanned Tokens [10] */}
                <Card className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-8 py-6 border-b border-border">
                        <h2 className="text-xl font-bold text-primary flex items-center gap-2">
                            <FileText className="w-5 h-5 text-primary" />
                            Payment History
                        </h2>
                        <p className="text-sm text-muted-foreground mt-1">Your verified on-chain payments</p>
                    </div>

                    <div className="divide-y divide-border">
                        {tokens.length === 0 ? (
                            <div className="px-8 py-12 text-center">
                                <p className="text-muted-foreground">No on-chain payment records found.</p>
                            </div>
                        ) : (
                            tokens.map((token, idx) => (
                                <div key={idx} className="px-8 py-6 hover:bg-muted/30 transition">
                                    <div className="flex items-center justify-between mb-3">
                                        <div>
                                            <p className="font-medium text-foreground">Payroll Period Token</p>
                                            {/* PRODUCTION FIX: Use token.timestamp (seconds) * 1000 for JS Date [1] */}
                                            <p className="text-sm text-muted-foreground mt-1">
                                                {token.timestamp 
                                                    ? new Date(token.timestamp * 1000).toLocaleDateString('en-US', { 
                                                        month: 'long', 
                                                        day: 'numeric', 
                                                        year: 'numeric' 
                                                      })
                                                    : 'Pending confirmation...'}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <Badge className={`rounded-full px-3 py-1 text-sm ${
                                                token.timestamp 
                                                    ? 'bg-secondary/20 text-secondary' 
                                                    : 'bg-yellow-100 text-yellow-700'
                                            }`}>
                                                {token.timestamp ? 'Confirmed' : 'Processing'}
                                            </Badge>
                                            <a 
                                                href={`https://mempool.space/testnet4/tx/${token.utxoId.split(':')[0]}`}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="block text-xs text-secondary font-medium mt-1 hover:underline"
                                            >
                                                View on Bitcoin ↗
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </Card>
            </main>
        </div>
    );
}