'use client'

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { useWallet } from '@/lib/WalletContext';
import { scanAddressForCharms } from '@/lib/charms-utils';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Wallet, CheckCircle, FileText, Lock, Loader2 } from 'lucide-react';
import * as constants from '../../shared/constants';

// Create API client
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002',
  timeout: 30000
});

// Helper function for truncating addresses
const truncateAddress = (addr: string) => 
    addr ? `${addr.slice(0, 8)}...${addr.slice(-4)}` : "";

// Mempool API for UTXO verification
const MEMPOOL_API = "https://mempool.space/testnet4/api";

export default function WorkerPortal() {
    const { address, walletConnected, connectWallet, disconnectWallet } = useWallet();
    
    // State for database records
    const [workerData, setWorkerData] = useState<any>(null);
    
    // State for Sovereign Data
    const [tokenData, setTokenData] = useState<any>(null);
    const [hrDetails, setHrDetails] = useState<any>(null);
    const [history, setHistory] = useState<any[]>([]);
    const [isScanning, setIsScanning] = useState(false);
    const [isDecrypting, setIsDecrypting] = useState(false);
    const [loading, setLoading] = useState(true);
    
    // Registry-First Verification State
    const [isTokenPresent, setIsTokenPresent] = useState(false);

    // 1. LOAD WORKER DATA: Registry-First Verification
    // The backend is the source of truth. The frontend only verifies the specific UTXO exists.
    const loadWorkerData = async () => {
        if (!walletConnected || !address) return;
        
        setLoading(true);
        setIsScanning(true);
        
        try {
            console.log("[WORKER PORTAL] Loading worker data for:", address);
            
            // A. Fetch authoritative worker record from backend
            const response = await api.get(`/api/workers/${address}`);
            const data = response.data;
            
            console.log("[WORKER PORTAL] Worker record fetched:", {
                name: data.name,
                status: data.status,
                hasCurrentTokenUtxo: !!data.currentTokenUtxo,
                currentTokenUtxo: data.currentTokenUtxo,
                hasMetadataCid: !!data.metadataCid,
                role: data.role,
                salarySats: data.salarySats,
                department: data.department,
                engagementType: data.engagementType,
                payPeriodSeconds: data.payPeriodSeconds,
                scrollPolicy: data.scrollPolicy
            });
            
            // B. Parse historical tokens for payment history
            let parsedHistory: any[] = [];
            if (data.historicalTokens) {
                try {
                    parsedHistory = typeof data.historicalTokens === 'string' 
                        ? JSON.parse(data.historicalTokens) 
                        : data.historicalTokens;
                    console.log("[WORKER PORTAL] Historical tokens loaded:", parsedHistory.length);
                } catch (e) {
                    console.error("[WORKER PORTAL] Failed to parse historicalTokens:", e);
                    parsedHistory = [];
                }
            }
            
            // C. Set worker data with parsed history
            const workerRecord = { ...data, historicalTokens: parsedHistory };
            setWorkerData(workerRecord);
            setHistory(parsedHistory);
            
            // D. REGISTRY-FIRST VERIFICATION: Check if the specific token UTXO exists in wallet
            let tokenPresent = false;
            let tokenUtxoInfo = null;
            
            if (workerRecord.currentTokenUtxo) {
                console.log("[WORKER PORTAL] Verifying token UTXO exists in wallet:", workerRecord.currentTokenUtxo);
                
                try {
                    const utxoResponse = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
                    const walletUtxos = utxoResponse.data;
                    console.log(`[WORKER PORTAL] Found ${walletUtxos.length} UTXOs in wallet`);
                    
                    // Check if the specific token UTXO from backend exists in wallet
                    const foundToken = walletUtxos.find(
                        (u: any) => `${u.txid}:${u.vout}` === workerRecord.currentTokenUtxo
                    );
                    
                    tokenPresent = !!foundToken;
                    if (tokenPresent) {
                        console.log("[WORKER PORTAL] ✅ Token UTXO confirmed present in wallet");
                        tokenUtxoInfo = {
                            utxoId: workerRecord.currentTokenUtxo,
                            timestamp: foundToken.status?.block_time,
                            value: foundToken.value
                        };
                    } else {
                        console.log("[WORKER PORTAL] ❌ Token UTXO not found in wallet");
                    }
                } catch (utxoError: any) {
                    console.error("[WORKER PORTAL] Failed to fetch wallet UTXOs:", utxoError.message);
                    tokenPresent = false;
                }
            } else {
                console.log("[WORKER PORTAL] No currentTokenUtxo in worker record");
            }
            
            setIsTokenPresent(tokenPresent);
            
            // E. Set token data based on registry verification
            if (tokenPresent && tokenUtxoInfo) {
                setTokenData({
                    utxoId: tokenUtxoInfo.utxoId,
                    timestamp: tokenUtxoInfo.timestamp,
                    validTo: workerRecord.expiresAt,
                    isPayrollToken: true
                });
            } else {
                setTokenData(null);
            }
            
            // F. DEMO MODE: Use database fields directly for employment details
            // (Decryption removed for demo - will be re-added with shared secret later)
            console.log("[WORKER PORTAL] Using database fields for employment details (demo mode)");
            setHrDetails({
                role: workerRecord.role || "Team Member",
                department: workerRecord.department || "General",
                baseSalarySats: workerRecord.salarySats || 0,
                engagementType: workerRecord.engagementType,
                payPeriodSeconds: workerRecord.payPeriodSeconds,
                uiTemplate: workerRecord.scrollPolicy === 0 ? 'employee' : 'freelancer'
            });
            
        } catch (error: any) {
            console.error("[WORKER PORTAL] Data load failed:", error);
            console.error("[WORKER PORTAL] Error details:", JSON.stringify(error, Object.getOwnPropertyNames(error)));
        } finally {
            setIsScanning(false);
            setLoading(false);
        }
    };
    
    // 2. AUTOMATIC VERIFICATION: Load data when wallet connects
    useEffect(() => {
        if (walletConnected && address) {
            loadWorkerData();
        }
    }, [address, walletConnected]);
    
    // 3. PRIVACY LAYER: Manual decrypt if auto-decrypt fails (disabled in demo)
    const handleUnlockData = async () => {
        if (!address) return;
        setIsDecrypting(true);
        // In demo mode, just reload worker data
        await loadWorkerData();
        setIsDecrypting(false);
    };
    
    // 4. STATUS DETERMINATION using Registry-First Verification
    const isActive = isTokenPresent && (hrDetails !== null || workerData !== null);
    const statusLabel = isActive 
    ? `Active — Paid through ${workerData?.expiresAt ? new Date(workerData.expiresAt).toLocaleDateString() : 'current period'}`
    : workerData?.currentTokenUtxo ? "Token issued - Pending confirmation" : "Awaiting Enrollment";
    
    // 5. EMPLOYMENT DETAILS MAPPING
    const workerName = workerData?.name || (address ? truncateAddress(address) : "Worker");
    const role = hrDetails?.role || workerData?.role || "Locked";
    const department = hrDetails?.department || workerData?.department || "Locked";
    const salary = hrDetails?.baseSalarySats 
        ? `${hrDetails.baseSalarySats.toLocaleString()} sats` 
        : workerData?.salarySats 
            ? `${workerData.salarySats.toLocaleString()} sats`
            : "•••••••• sats";
    
    // Map engagementType from number to readable string
    const getEngagementType = (type: number | string | undefined) => {
        if (type === 0 || type === 'full-time') return 'Full-time';
        if (type === 1 || type === 'part-time') return 'Part-time';
        if (type === 2 || type === 'freelancer') return 'Freelancer';
        return 'Employee';
    };
    
    const engagementType = getEngagementType(hrDetails?.engagementType || workerData?.engagementType);
    
    // Map pay frequency display
    const getPayFrequencyDisplay = () => {
        const payPeriodSeconds = hrDetails?.payPeriodSeconds || workerData?.payPeriodSeconds;
        if (!payPeriodSeconds) return 'Locked';
        if (payPeriodSeconds === constants.DEMO_SECONDS_PER_PERIOD) return 'Demo (1 min)';
        if (payPeriodSeconds === constants.SECONDS_PER_WEEK) return 'Weekly';
        if (payPeriodSeconds === constants.SECONDS_PER_BIWEEK) return 'Bi-weekly';
        if (payPeriodSeconds === constants.SECONDS_PER_MONTH) return 'Monthly';
        return hrDetails?.uiTemplate === 'employee' ? 'Time-based' : 'Proof-based';
    };
    
    const payFrequencyDisplay = getPayFrequencyDisplay();

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

    if (loading) {
        return (
            <div className="min-h-screen bg-background flex items-center justify-center">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="w-12 h-12 text-primary animate-spin" />
                    <p className="text-muted-foreground">Verifying your employment records...</p>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-background">
            {/* Main Content */}
            <main className="max-w-7xl mx-auto px-6 py-12">
                {/* Welcome Section - Dynamic Name */}
                <div className="flex justify-between items-center mb-8">
                    <div>
                        <h1 className="text-4xl font-bold text-primary mb-2">
                            Welcome back, {workerName}
                        </h1>
                        <p className="text-foreground text-lg">Manage your employment and track payments trustlessly.</p>
                    </div>
                    {/* Unlock button disabled in demo mode - decryption removed */}
                    {!hrDetails && workerData?.metadataCid && (
                        <Button onClick={handleUnlockData} disabled={isDecrypting} variant="outline" className="gap-2 rounded-lg">
                            {isDecrypting ? <Loader2 className="animate-spin w-4 h-4" /> : <Lock className="w-4 h-4" />}
                            {isDecrypting ? 'Loading...' : 'Refresh Data'}
                        </Button>
                    )}
                </div>

                {/* Main Dashboard Card - Enrollment Status */}
                <Card className="bg-card border border-border rounded-xl overflow-hidden mb-12">
                    <div className="bg-gradient-to-r from-primary/10 to-secondary/10 p-8 border-b border-border">
                        <div className="flex items-start justify-between mb-8">
                            <div>
                                <div className="flex items-center gap-3 mb-2">
                                    <div className={`p-2 rounded-full ${isActive ? 'bg-secondary/20' : workerData?.currentTokenUtxo ? 'bg-yellow-100' : 'bg-yellow-100'}`}>
                                        {isActive ? (
                                            <CheckCircle className="w-8 h-8 text-secondary" />
                                        ) : (
                                            <Lock className="w-8 h-8 text-yellow-600" />
                                        )}
                                    </div>
                                    <div>
                                        <p className="text-sm text-muted-foreground">Status</p>
                                        <p className="text-2xl font-bold text-secondary">
                                            {statusLabel}
                                        </p>
                                    </div>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {isActive ? 'Verified on Bitcoin (Testnet4)' : workerData?.currentTokenUtxo ? 'Token issued, awaiting confirmation' : 'No active tokens found'}
                                </p>
                            </div>
                        </div>

                        <div className="grid md:grid-cols-3 gap-8">
                            {/* Next Payment */}
                            <div>
                                <p className="text-sm text-muted-foreground mb-2">Next automatic payment</p>
                                <p className="text-2xl font-bold text-primary">
                                    {workerData?.expiresAt ? new Date(workerData.expiresAt).toLocaleDateString() : 'Calculated by Scroll'}
                                </p>
                                <p className="text-xs text-muted-foreground mt-1">Automatically triggered by Scroll</p>
                            </div>

                            {/* Salary */}
                            <div>
                                <p className="text-sm text-muted-foreground mb-2">Your salary</p>
                                <p className="text-2xl font-bold text-primary">
                                    {salary}
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

                    {/* Employment Details Section */}
                    <div className="p-8">
                        <h2 className="text-lg font-bold text-primary mb-6">Employment Details</h2>
                        <div className="grid md:grid-cols-2 gap-8">
                            <div className="pb-6 border-b border-border md:border-b-0 md:border-r">
                                <p className="text-sm text-muted-foreground mb-2">Role</p>
                                <p className="text-lg font-semibold text-foreground">{role}</p>
                            </div>
                            <div className="pb-6 border-b border-border md:border-b-0">
                                <p className="text-sm text-muted-foreground mb-2">Department</p>
                                <p className="text-lg font-semibold text-foreground">{department}</p>
                            </div>
                            <div className="pb-6">
                                <p className="text-sm text-muted-foreground mb-2">Pay Frequency</p>
                                <Badge variant="outline" className="rounded-full px-3 py-1 text-sm">
                                    {payFrequencyDisplay}
                                </Badge>
                            </div>
                            <div className="pb-6">
                                <p className="text-sm text-muted-foreground mb-2">Employment Type</p>
                                <p className="text-lg font-semibold text-foreground">{engagementType}</p>
                            </div>
                        </div>
                    </div>
                </Card>

                {/* Freelancer Section (Conditional) */}
                {hrDetails?.uiTemplate === 'freelancer' && (
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

                {/* Payment History - Mapped from Historical Tokens */}
                <Card className="bg-card border border-border rounded-xl overflow-hidden">
                    <div className="px-8 py-6 border-b border-border">
                        <h2 className="text-xl font-bold text-primary flex items-center gap-2">
                            <FileText className="w-5 h-5 text-primary" />
                            Payment History
                        </h2>
                        <p className="text-sm text-muted-foreground mt-1">Your verified on-chain payments</p>
                    </div>

                    <div className="divide-y divide-border">
                        {history.length === 0 && (!workerData?.currentTokenUtxo) ? (
                            <div className="px-8 py-12 text-center">
                                <p className="text-muted-foreground">No on-chain payment records found.</p>
                            </div>
                        ) : (
                            <>
                                {/* Current active token from registry */}
                                {workerData?.currentTokenUtxo && (
                                    <div className="px-8 py-6 hover:bg-muted/30 transition">
                                        <div className="flex items-center justify-between mb-3">
                                            <div>
                                                <p className="font-medium text-foreground">Current Payroll Period</p>
                                                <p className="text-sm text-muted-foreground mt-1">
                                                    {workerData.lastMintedPeriod 
                                                        ? new Date(workerData.lastMintedPeriod).toLocaleDateString('en-US', { 
                                                            month: 'long', 
                                                            day: 'numeric', 
                                                            year: 'numeric' 
                                                          })
                                                        : 'Pending confirmation...'}
                                                </p>
                                            </div>
                                            <div className="text-right">
                                                <Badge className={`rounded-full px-3 py-1 text-sm ${
                                                    isTokenPresent
                                                        ? 'bg-secondary/20 text-secondary' 
                                                        : 'bg-yellow-100 text-yellow-700'
                                                }`}>
                                                    {isTokenPresent ? 'Active' : 'Processing'}
                                                </Badge>
                                                <a 
                                                    href={`https://mempool.space/testnet4/tx/${workerData.currentTokenUtxo.split(':')[0]}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="block text-xs text-secondary font-medium mt-1 hover:underline"
                                                >
                                                    View on Bitcoin ↗
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                )}
                                
                                {/* Historical payments */}
                                {history.map((tx: any, idx: number) => (
                                    <div key={idx} className="px-8 py-6 hover:bg-muted/30 transition">
                                        <div className="flex items-center justify-between mb-3">
                                            <div>
                                                <p className="font-medium text-foreground">Salary Disbursement</p>
                                                <p className="text-sm text-muted-foreground mt-1">
                                                    {tx.timestamp 
                                                        ? new Date(tx.timestamp * 1000).toLocaleDateString('en-US', { 
                                                            month: 'long', 
                                                            day: 'numeric', 
                                                            year: 'numeric' 
                                                          })
                                                        : 'Date not available'}
                                                </p>
                                            </div>
                                            <div className="text-right">
                                                <Badge className="rounded-full px-3 py-1 text-sm bg-secondary/20 text-secondary">
                                                    Completed
                                                </Badge>
                                                <a 
                                                    href={`https://mempool.space/testnet4/tx/${tx.utxoId?.split(':')[0] || tx.txid}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                    className="block text-xs text-secondary font-medium mt-1 hover:underline"
                                                >
                                                    View on Bitcoin ↗
                                                </a>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </>
                        )}
                    </div>
                </Card>
            </main>
        </div>
    );
}