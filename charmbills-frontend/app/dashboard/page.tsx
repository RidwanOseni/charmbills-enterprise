'use client'

import { useState, useEffect } from 'react';
import axios from 'axios';
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Wallet, Users, CheckCircle, Building2, PlusCircle, CreditCard } from 'lucide-react'
import { useWallet } from '@/lib/WalletContext';
import { getWalletStatus } from '@/lib/charms-utils';
import { WorkerStatus, ProverResult } from '../../shared/types';
import * as constants from '../../shared/constants';

// Import for company onboarding hex derivation
import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

// Create API client with absolute URL and increased timeout for ZK-proof generation
const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002',
  timeout: 180000 // 3 minutes timeout for ZK-proof generation (matches backend PROVER_TIMEOUT_MS)
});

// Map frontend selection to deterministic seconds
const frequencyToSeconds = (freq: string) => {
  const map: Record<string, number> = {
    'weekly': constants.SECONDS_PER_WEEK,
    'biweekly': constants.SECONDS_PER_BIWEEK,
    'monthly': constants.SECONDS_PER_MONTH,
    'demo': constants.DEMO_SECONDS_PER_PERIOD
  };
  return map[freq] || constants.SECONDS_PER_BIWEEK;
};

export default function EmployerDashboard() {
  const { 
    address, 
    walletConnected, 
    connectWallet, 
    disconnectWallet, 
    signAndBroadcastPackage 
  } = useWallet();

  // ============================================================
  // Infrastructure State (Departments - One NFT per Department)
  // ============================================================
  const [registeredDepts, setRegisteredDepts] = useState<any[]>([]);
  const [setupDeptName, setSetupDeptName] = useState('');
  const [setupBudget, setSetupBudget] = useState('100');
  const [setupFrequency, setSetupFrequency] = useState('biweekly');
  const [setupType, setSetupType] = useState('employee');
  const [isSettingUpDept, setIsSettingUpDept] = useState(false);
  
  // ============================================================
  // Hiring State (Workers assigned to Departments)
  // ============================================================
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [salary, setSalary] = useState('');
  const [bitcoinAddress, setBitcoinAddress] = useState('');
  
  // ============================================================
  // Operational State
  // ============================================================
  const [workers, setWorkers] = useState<any[]>([]);
  const [vaultBalance, setVaultBalance] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [nextRunDate, setNextRunDate] = useState<string>('Calculating...');
  const [hasActiveWorkers, setHasActiveWorkers] = useState<boolean>(false);
  const [isOnboarding, setIsOnboarding] = useState<boolean>(false);
  const [companyRegistered, setCompanyRegistered] = useState<boolean>(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingAttempted, setOnboardingAttempted] = useState<boolean>(false);
  
  // ============================================================
  // Batch Minting State
  // ============================================================
  const [selectedWorkers, setSelectedWorkers] = useState<Set<string>>(new Set());
  const [selectedDept, setSelectedDept] = useState('');
  const [selectedPeriods, setSelectedPeriods] = useState('1');
  const [statusFilter, setStatusFilter] = useState('all');
  const [toast, setToast] = useState('');
  
  const [currentPlanNftUtxo, setCurrentPlanNftUtxo] = useState('');
  const [currentPlanMetadata, setCurrentPlanMetadata] = useState<any>(null);

  // ============================================================
  // Helper: Scan wallet for UTXO context
  // ============================================================
  const getBtcContext = async () => {
    if (!address) throw new Error("Wallet not connected");
    
    console.log("[DEPARTMENT SETUP] Scanning wallet for UTXOs...");
    
    const response = await axios.get(`https://mempool.space/testnet4/api/address/${address}/utxo`);
    const utxos = response.data;
    
    console.log(`[DEPARTMENT SETUP] Found ${utxos.length} UTXOs`);
    
    const anchorUtxo = utxos.find((u: any) => u.value >= 10000 && u.status.confirmed);
    
    const feeUtxo = utxos.find((u: any) => 
      u.value >= 5000 && 
      u.status.confirmed && 
      (u.txid !== anchorUtxo?.txid || u.vout !== anchorUtxo?.vout)
    );
    
    if (!anchorUtxo) {
      throw new Error("Insufficient funds: Need a UTXO >= 10,000 sats for Anchor (NFT identity).");
    }
    
    if (!feeUtxo) {
      throw new Error("Insufficient funds: Need a separate UTXO >= 5,000 sats for transaction fees.");
    }
    
    console.log("[DEPARTMENT SETUP] Selected anchor UTXO:", anchorUtxo.txid, `value: ${anchorUtxo.value}`);
    console.log("[DEPARTMENT SETUP] Selected fee UTXO:", feeUtxo.txid, `value: ${feeUtxo.value}`);
    
    const [anchorHex, feeHex] = await Promise.all([
      axios.get(`https://mempool.space/testnet4/api/tx/${anchorUtxo.txid}/hex`),
      axios.get(`https://mempool.space/testnet4/api/tx/${feeUtxo.txid}/hex`)
    ]);
    
    return {
      anchor: {
        utxoId: `${anchorUtxo.txid}:${anchorUtxo.vout}`,
        value: anchorUtxo.value,
        hex: anchorHex.data
      },
      fee: {
        utxoId: `${feeUtxo.txid}:${feeUtxo.vout}`,
        value: feeUtxo.value,
        hex: feeHex.data
      }
    };
  };

  // ============================================================
  // COMPANY ONBOARDING: Auto-register when wallet connects
  // ============================================================
  useEffect(() => {
    const checkAndRegisterCompany = async () => {
      if (!walletConnected || !address || companyRegistered || isOnboarding || onboardingError || onboardingAttempted) {
        return;
      }
      
      setIsOnboarding(true);
      setOnboardingAttempted(true);
      
      try {
        console.log("[ONBOARDING] Checking if company exists for:", address);
        
        const checkResponse = await api.get(`/api/companies/${address}`).catch((err) => {
          if (err.response?.status === 404) return { data: null };
          throw err;
        });
        
        if (checkResponse?.data?.success) {
          console.log("[ONBOARDING] Company already registered");
          setCompanyRegistered(true);
          setIsOnboarding(false);
          return;
        }
        
        console.log("[ONBOARDING] Registering new company...");
        
        if (!(window as any).LeatherProvider) {
          throw new Error("Leather wallet not detected. Please install Leather extension.");
        }
        
        const response = await (window as any).LeatherProvider.request("getAddresses");
        
        if (!response?.result?.addresses) {
          throw new Error("Failed to get addresses from wallet");
        }
        
        const p2tr = response.result.addresses.find((a: any) => a.type === 'p2tr');
        
        if (!p2tr) {
          throw new Error("Taproot address (p2tr) not found in wallet.");
        }
        
        console.log("[ONBOARDING] Found Taproot address:", p2tr.address);
        
        if (!p2tr.publicKey) {
          throw new Error("Public key not found for Taproot address");
        }
        
        const fullKey = hexToBytes(p2tr.publicKey);
        const schnorrKey = fullKey.length === 33 ? fullKey.slice(1) : fullKey;
        
        const network = { 
          bech32: 'tb', 
          pubKeyHash: 0x6f, 
          scriptHash: 0xc4, 
          wif: 0xef 
        };
        
        const payment = btc.p2tr(schnorrKey, undefined, network);
        const derivedHex = bytesToHex(payment.script);
        
        const registerResponse = await api.post('/api/companies/register', {
          employerAddress: p2tr.address,
          treasuryAddress: p2tr.address,
          treasuryHexDest: derivedHex
        });
        
        if (registerResponse.data?.success) {
          console.log("[ONBOARDING] ✅ Company registered successfully");
          setCompanyRegistered(true);
          setToast("✅ Company infrastructure registered! You can now create departments.");
          setTimeout(() => setToast(''), 4000);
        } else {
          throw new Error(registerResponse.data?.error || "Registration failed");
        }
        
      } catch (error: any) {
        console.error("[ONBOARDING] Registration failed:", error.message);
        setOnboardingError(error.message);
        setToast(`❌ Company registration failed: ${error.message}`);
        setTimeout(() => setToast(''), 5000);
      } finally {
        setIsOnboarding(false);
      }
    };
    
    checkAndRegisterCompany();
  }, [walletConnected, address, companyRegistered, isOnboarding, onboardingError, onboardingAttempted]);

  // ============================================================
  // STAGE 1: Setup Department (Mint Plan NFT - One per Department)
  // ============================================================
  const handleSetupDepartment = async () => {
    if (!setupDeptName) {
      setToast("❌ Please enter a department name.");
      return;
    }
    
    const budgetValue = parseInt(setupBudget);
    if (isNaN(budgetValue) || budgetValue <= 0) {
      setToast("❌ Please enter a valid budget (positive number of pay periods).");
      return;
    }
    
    if (!companyRegistered) {
      setToast("⚠️ Please wait for company registration to complete first.");
      return;
    }
    
    setIsSettingUpDept(true);
    
    try {
      console.log("[DEPARTMENT SETUP] Creating department:", setupDeptName);
      console.log("[DEPARTMENT SETUP] Budget:", budgetValue, "pay periods");
      
      const btcContext = await getBtcContext();
      
      console.log("[DEPARTMENT SETUP] BTC Context obtained:", {
        anchor: btcContext.anchor.utxoId,
        fee: btcContext.fee.utxoId
      });
      
      if (!(window as any).LeatherProvider) {
        throw new Error("Leather wallet not detected");
      }
      
      const sigRes = await (window as any).LeatherProvider.request("signMessage", {
        message: `CharmBills Department Authority: ${setupDeptName}`,
        paymentType: "p2tr",
        network: "testnet"
      });
      
      const payload = {
        anchorUtxo: btcContext.anchor.utxoId,
        anchorTxHex: btcContext.anchor.hex,
        anchorValue: btcContext.anchor.value,
        fundingUtxo: btcContext.fee.utxoId,
        fundingValue: btcContext.fee.value,
        employerAddress: address,
        department: setupDeptName.toLowerCase(),
        ticker: `${setupDeptName.substring(0, 3).toUpperCase()}-PAY`,
        role: "Department Authority",
        compensationSats: 1000,
        payPeriodSeconds: frequencyToSeconds(setupFrequency),
        scrollPolicy: setupType === 'employee' ? 0 : 1,
        remaining: budgetValue,
        encryptionEntropy: sigRes.result.signature,
        multiSigRequired: false
      };
      
      const response = await axios.post('/api/plans/mint', payload, {
        timeout: 180000,
        baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'
      });
      
      const proverResult: ProverResult = response.data;
      
      const signingResult = await signAndBroadcastPackage(proverResult, btcContext);
      const txids = signingResult?.txids;
      
      if (txids && txids.length > 0) {
        setToast(`✅ ${setupDeptName} Department created with ${budgetValue} pay periods budget!`);
        await fetchPlans();
        
        setSetupDeptName('');
        setSetupBudget('100');
        setSetupFrequency('biweekly');
        setSetupType('employee');
      } else {
        setToast('⚠️ Department setup was cancelled or failed');
      }
      
    } catch (err: any) {
      console.error("[DEPARTMENT SETUP] Failed:", err.message);
      setToast(`❌ Department setup failed: ${err.message}`);
    } finally {
      setIsSettingUpDept(false);
      setTimeout(() => setToast(''), 4000);
    }
  };
  
  // ============================================================
  // STAGE 2: Add Worker to Registry (Administrative Action)
  // CRITICAL FIX: This is now an administrative "Add" action that saves worker to database
  // ============================================================
  const handleHire = async () => {
    if (!fullName || !selectedDeptId || !bitcoinAddress) {
      setToast("❌ Please fill in all worker details.");
      return;
    }
    
    setIsProcessing(true);

    try {
      const dept = registeredDepts.find(d => d.appId === selectedDeptId);
      if (!dept) {
        throw new Error("Selected department not found");
      }
      
      console.log("[HIRE ADMIN] Adding worker:", fullName, "to department:", dept.department);
      
      // Use a non-minting endpoint to just save the worker record
      const payload = {
        name: fullName,
        role: role || "Team Member",
        salary: parseInt(salary) || 5000000,
        walletAddress: bitcoinAddress,
        departmentId: selectedDeptId,
        department: dept.department,
        status: 'pending' // This triggers the "Needs Tokens" yellow badge
      };
      
      console.log("[HIRE ADMIN] Payload:", payload);
      
      // Use a non-minting endpoint to just save the worker record
      await api.post('/api/workers/add', payload);
      
      setToast(`✅ Worker added to registry. They'll receive tokens in the next run.`);
      await refreshWorkers();
      
      // Clear inputs
      setFullName('');
      setRole('');
      setSalary('');
      setBitcoinAddress('');
      setSelectedDeptId('');
      
    } catch (err: any) {
      console.error("[HIRE ADMIN] Failed:", err.message);
      setToast(`❌ Failed to add worker to registry: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setToast(''), 4000);
    }
  };
  
  // ============================================================
  // Batch Token Issuance (Pay Your Team - All at Once)
  // ============================================================
  const handleIssueTokens = async () => {
    if (selectedWorkers.size === 0) {
      setToast("❌ Please select workers to issue tokens.");
      return;
    }
    
    if (!currentPlanNftUtxo) {
      setToast("❌ No active Plan NFT found for this department.");
      return;
    }

    if (!currentPlanMetadata) {
      setToast("❌ Plan metadata not found. Please refresh the page.");
      return;
    }  
    
    setIsProcessing(true);

    try {
      const workerList = workers.filter(w => selectedWorkers.has(w.walletAddress));
      const periods = parseInt(selectedPeriods);
      
      const btcContext = await getBtcContext();

      const payload = {
        authorityUtxo: currentPlanNftUtxo,
        authorityTxHex: btcContext.anchor.hex,
        fundingUtxo: btcContext.fee.utxoId,
        fundingValue: btcContext.fee.value,
        employerAddress: address,
        workers: workerList.map(w => ({ 
          address: w.walletAddress, 
          periods,
          salarySats: w.salary || 5000000,
          role: w.role || "Team Member"
        })),
        planMetadata: currentPlanMetadata,
        encryptionEntropy: "placeholder" // Will be handled by backend
      };

      console.log("[BATCH MINT] Workers count:", payload.workers.length);

      const response = await axios.post('/api/payrollhiring/mint', payload, {
        timeout: 180000,
        baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'
      });
      
      const signingResult = await signAndBroadcastPackage(response.data, btcContext);
      const txids = signingResult?.txids;
      
      if (txids && txids.length > 0) {
        setToast(`✅ Batch tokens issued! ${workerList.length} workers covered.`);
        await refreshWorkers();
        setSelectedWorkers(new Set());
      } else {
        setToast('⚠️ Signing was cancelled or failed');
      }
    } catch (err: any) {
      console.error("Batch minting failed:", err.message);
      setToast(`❌ Batch minting failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setToast(''), 4000);
    }
  };
  
  // ============================================================
  // Data Fetching Helpers
  // ============================================================
  const fetchPlans = async () => {
    if (!address) return;
    try {
      const res = await api.get(`/api/plans?employerAddress=${address}`);
      setRegisteredDepts(res.data);
      if (res.data.length > 0 && !selectedDeptId) {
        setSelectedDeptId(res.data[0].appId);
      }
    } catch (error) {
      console.error('Failed to fetch plans:', error);
    }
  };
  
  const refreshWorkers = async () => {
    try {
      const response = await api.get('/api/workers');
      setWorkers(response.data);
      await fetchPlans();
    } catch (error) {
      console.error('Failed to refresh workers:', error);
    }
  };
  
  // Fetch dashboard stats
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const statsRes = await api.get('/api/dashboard/stats');
        if (statsRes.data.nextRun) {
          const date = new Date(statsRes.data.nextRun);
          setNextRunDate(date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
          setHasActiveWorkers(true);
        } else {
          setNextRunDate("Waiting for first hire");
          setHasActiveWorkers(false);
        }
      } catch (err) {
        setNextRunDate("No active payroll");
        setHasActiveWorkers(false);
      }
    };
    fetchStats();
  }, [workers]);

  // ============================================================
  // FIX A: Update Company Vault Balance - Use connected wallet address
  // ============================================================
  useEffect(() => {
    const fetchVaultBalance = async () => {
      // If no hardcoded treasury, use the currently connected wallet address
      const treasuryAddr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || address;
      
      if (!walletConnected || !treasuryAddr) return;

      try {
        // Use the getWalletStatus helper to fetch real-time Taproot balance
        const status = await getWalletStatus(treasuryAddr);
        setVaultBalance(status.totalBalance);
      } catch (error) {
        console.error('Failed to fetch vault balance:', error);
        setVaultBalance(0);
      }
    };
    fetchVaultBalance();
  }, [walletConnected, address]); // ✅ Depend on address to update when wallet changes
  
  // Fetch initial data when wallet connects
  useEffect(() => {
    if (walletConnected && address) {
      fetchPlans();
      refreshWorkers();
    }
  }, [walletConnected, address]);
  
  // Fetch plan metadata when department selection changes
  useEffect(() => {
    const fetchPlanForDepartment = async () => {
      if (!selectedDept || !address) return;
      try {
        const response = await api.get(`/api/plans?department=${selectedDept}&employerAddress=${address}`);
        if (response.data && response.data.length > 0) {
          const plan = response.data[0];
          setCurrentPlanNftUtxo(plan.nftUtxoId);
          setCurrentPlanMetadata({
            appId: plan.appId,
            ticker: plan.ticker,
            remaining: plan.remaining,
            metadataHash: plan.metadataHash,
            scrollPolicy: plan.scrollPolicy,
            payPeriodSeconds: plan.payPeriodSeconds,
            compensationSats: plan.compensationSats
          });
        }
      } catch (error) {
        console.error('Failed to fetch plan metadata:', error);
      }
    };
    fetchPlanForDepartment();
  }, [selectedDept, address]);

  // Worker filtering and selection helpers
  const totalWorkers = workers.length;
  const deptWorkers = selectedDept === 'all' 
    ? workers 
    : workers.filter((w: any) => w.department === selectedDept);

  // ============================================================
  // FIX B: Isolate Workers from Departments in the Registry
  // Ensure we only show records with valid names (Department NFTs don't have names in worker table)
  // ============================================================
  const filteredByStatus = workers.filter((worker) => {
    // 1. Ensure we only show records with a valid name (Department NFTs usually don't have this field)
    if (!worker.name) return false;

    // 2. Apply the UI filters
    if (statusFilter === 'all') return true;
    if (statusFilter === 'Active') return worker.status === 'active';
    if (statusFilter === 'Needs Tokens') return worker.status === 'pending' || worker.status === 'Needs Tokens';
    return true;
  });

  const toggleWorkerSelection = (wallet: string) => {
    const newSelected = new Set(selectedWorkers);
    if (newSelected.has(wallet)) {
      newSelected.delete(wallet);
    } else {
      newSelected.add(wallet);
    }
    setSelectedWorkers(newSelected);
  };

  const selectAllDeptWorkers = () => {
    if (selectedWorkers.size === deptWorkers.length && deptWorkers.length > 0) {
      setSelectedWorkers(new Set());
    } else {
      setSelectedWorkers(new Set(deptWorkers.map((w: any) => w.walletAddress)));
    }
  };

  const handleTerminate = async (workerWallet: string) => {
    if (!confirm("Are you sure? This triggers a 3-of-5 Board override to freeze vault funds.")) return;
    
    try {
      await api.post('/api/workers/terminate', { walletAddress: workerWallet });
      setToast("✅ Termination initiated. Check Treasury for Board approval.");
      await refreshWorkers();
    } catch (err) {
      console.error("Termination failed:", err);
      setToast("❌ Failed to initiate termination.");
      setTimeout(() => setToast(''), 4000);
    }
  };

  // UI States
  if (!walletConnected) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-primary/10 rounded-full">
              <Wallet className="w-12 h-12 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-primary mb-2">Connect Your Wallet</h1>
          <p className="text-foreground mb-6">Connect your Leather wallet to manage your team and payroll</p>
          <Button onClick={connectWallet} className="w-full">
            Connect Wallet
          </Button>
        </Card>
      </div>
    );
  }

  if (isOnboarding) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-primary/10 rounded-full animate-pulse">
              <Building2 className="w-12 h-12 text-primary" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-primary mb-2">Setting Up Your Company</h1>
          <p className="text-foreground mb-6">We're automatically configuring your treasury infrastructure...</p>
          <div className="w-full bg-muted rounded-full h-2 overflow-hidden">
            <div className="bg-primary h-full w-2/3 animate-pulse rounded-full"></div>
          </div>
        </Card>
      </div>
    );
  }

  if (onboardingError && !companyRegistered) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-destructive/10 rounded-full">
              <Building2 className="w-12 h-12 text-destructive" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-destructive mb-2">Setup Failed</h1>
          <p className="text-foreground mb-6">{onboardingError}</p>
          <Button 
            onClick={() => {
              setOnboardingError(null);
              setOnboardingAttempted(false);
            }} 
            className="w-full"
          >
            Retry Setup
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Company Status Banner */}
      {companyRegistered && (
        <div className="bg-secondary/10 border-b border-secondary/20 px-6 py-2">
          <div className="max-w-7xl mx-auto flex items-center justify-between">
            <p className="text-sm text-secondary flex items-center gap-2">
              <CheckCircle className="w-4 h-4" />
              Company infrastructure registered ✓
            </p>
            <p className="text-xs text-muted-foreground">
              Treasury: {address?.substring(0, 16)}...
            </p>
          </div>
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-12">
        {/* Toast Notification */}
        {toast && (
          <div className="mb-6 p-4 bg-secondary/20 text-secondary rounded-lg border border-secondary/30 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium">{toast}</p>
          </div>
        )}

        {/* Overview Cards */}
        <div className="grid md:grid-cols-3 gap-6 mb-12">
          <Card className="p-6 bg-card border border-border rounded-xl">
            <p className="text-sm text-muted-foreground mb-2">Total Team</p>
            <p className="text-4xl font-bold text-primary">{totalWorkers} workers</p>
            <p className="text-xs text-muted-foreground mt-2">Across {registeredDepts.length} department(s)</p>
          </Card>
          <Card className="p-6 bg-card border border-border rounded-xl">
            <p className="text-sm text-muted-foreground mb-2">Next Payroll Run</p>
            <p className="text-3xl font-bold text-primary">{nextRunDate}</p>
            <p className="text-xs text-muted-foreground mt-2">
              {hasActiveWorkers ? 'Automatically triggered by Scroll' : 'Add workers to begin payroll'}
            </p>
          </Card>
          <Card className="p-6 bg-card border border-border rounded-xl">
            <p className="text-sm text-muted-foreground mb-2">Company Vault</p>
            <p className="text-3xl font-bold text-primary">{(vaultBalance / 1e8).toFixed(4)} BTC</p>
            <Link href="/treasury" className="text-sm text-secondary hover:text-secondary/80 transition font-medium mt-2 inline-block">
              View →
            </Link>
          </Card>
        </div>

        {/* Welcome Section */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-primary mb-2">Employer Orchestration</h1>
          <p className="text-foreground">Create departments, hire workers, and manage payroll with one-click batch payments</p>
        </div>

        {/* Two-Column Layout: Setup Department + Add Worker */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
          {/* Card 1: DEPARTMENT SETUP (STAGE 1) */}
          <Card className="p-8 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-primary/10 rounded-lg">
                <PlusCircle className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-2xl font-bold text-primary">1. Setup Department</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">Create a department NFT. One NFT per department handles all workers with different salaries.</p>

            <div className="space-y-5">
              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Department Name</Label>
                <Input
                  placeholder="e.g., Engineering"
                  value={setupDeptName}
                  onChange={(e) => setSetupDeptName(e.target.value)}
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isSettingUpDept}
                />
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Authorized Pay Periods (Budget)</Label>
                <Input 
                  type="number" 
                  value={setupBudget} 
                  onChange={(e) => setSetupBudget(e.target.value)} 
                  placeholder="e.g. 100"
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isSettingUpDept}
                />
                <p className="text-xs text-muted-foreground italic mt-1">
                  Total pay periods this department is authorized to issue (Budget). Each worker uses 1 pay period per payment cycle.
                </p>
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Pay Frequency</Label>
                <Select value={setupFrequency} onValueChange={setSetupFrequency} disabled={isSettingUpDept}>
                  <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                    <SelectValue placeholder="Select frequency" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Bi-weekly (Standard)</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="demo">Investor Demo (1 Minute)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground mt-1">Sets the on-chain pay period for all workers in this department.</p>
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Worker Type</Label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setSetupType('employee')}
                    disabled={isSettingUpDept}
                    className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                      setupType === 'employee'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Employee (Time-based)
                  </button>
                  <button
                    onClick={() => setSetupType('freelancer')}
                    disabled={isSettingUpDept}
                    className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                      setupType === 'freelancer'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Freelancer (Proof-based)
                  </button>
                </div>
              </div>

              <Button 
                onClick={handleSetupDepartment} 
                disabled={isSettingUpDept || !companyRegistered || !setupDeptName}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-2 rounded-lg disabled:opacity-50"
              >
                {isSettingUpDept ? 'Creating Department (60-105 sec)...' : 'Create Department NFT'}
              </Button>

              {registeredDepts.length > 0 && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                  ✅ {registeredDepts.length} active department(s)
                </p>
              )}
            </div>
          </Card>

          {/* Card 2: ADD WORKER TO REGISTRY (STAGE 2) - Administrative Action */}
          <Card className="p-8 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-2xl font-bold text-primary">2. Add Worker to Registry</h2>
            </div>
            <p className="text-sm text-muted-foreground mb-4">Add a worker to the department registry. They'll receive tokens in the next payroll run.</p>

            <div className="space-y-5">
              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Select Department</Label>
                <Select value={selectedDeptId} onValueChange={setSelectedDeptId} disabled={isProcessing || registeredDepts.length === 0}>
                  <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                    <SelectValue placeholder={registeredDepts.length === 0 ? "Create a department first" : "Select department"} />
                  </SelectTrigger>
                  <SelectContent>
                    {registeredDepts.map((dept) => (
                      <SelectItem key={dept.appId} value={dept.appId}>
                        {dept.department.charAt(0).toUpperCase() + dept.department.slice(1)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {registeredDepts.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">⚠️ Please create a department first</p>
                )}
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Worker Name</Label>
                <Input
                  placeholder="e.g., Alex Chen"
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isProcessing}
                />
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Role (Optional)</Label>
                <Input
                  placeholder="e.g., Senior Engineer"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isProcessing}
                />
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Salary (sats/period)</Label>
                <Input
                  type="number"
                  placeholder="5000000"
                  value={salary}
                  onChange={(e) => setSalary(e.target.value)}
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isProcessing}
                />
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Worker Bitcoin Address</Label>
                <Input
                  placeholder="tb1p..."
                  value={bitcoinAddress}
                  onChange={(e) => setBitcoinAddress(e.target.value)}
                  className="rounded-lg border-border bg-background text-foreground placeholder:text-muted-foreground"
                  disabled={isProcessing}
                />
              </div>

              <Button 
                onClick={handleHire} 
                disabled={isProcessing || !selectedDeptId || !fullName || !bitcoinAddress}
                className="w-full bg-secondary hover:bg-secondary/90 text-secondary-foreground font-semibold py-2 rounded-lg disabled:opacity-50"
              >
                {isProcessing ? 'Adding...' : 'Add Worker to Registry'}
              </Button>
            </div>
          </Card>
        </div>

        {/* Card 3: Batch Minting */}
        <div className="flex justify-center mb-12">
          <Card className="w-full max-w-4xl p-8 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-secondary/10 rounded-lg">
                <CreditCard className="w-6 h-6 text-secondary" />
              </div>
              <h2 className="text-2xl font-bold text-primary">Pay Your Team — All at Once</h2>
            </div>
            <p className="text-foreground mb-6">Issue tokens in one transaction. Save 90% on fees.</p>

            {/* Department Selector */}
            <div className="mb-6">
              <Label className="text-sm font-medium text-foreground block mb-2">Select Department</Label>
              <Select value={selectedDept} onValueChange={setSelectedDept} disabled={isProcessing || registeredDepts.length === 0}>
                <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                  <SelectValue placeholder={registeredDepts.length === 0 ? "Create a department first" : "Select department"} />
                </SelectTrigger>
                <SelectContent>
                  {registeredDepts.map((dept) => (
                    <SelectItem key={dept.appId} value={dept.department}>
                      {dept.department.charAt(0).toUpperCase() + dept.department.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Worker Selection Table */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-foreground">
                  Workers in {selectedDept ? selectedDept.charAt(0).toUpperCase() + selectedDept.slice(1) : 'selected department'}
                </p>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedWorkers.size === deptWorkers.length && deptWorkers.length > 0}
                    onChange={selectAllDeptWorkers}
                    className="w-4 h-4 rounded border-border"
                    disabled={isProcessing}
                  />
                  <span className="text-xs text-muted-foreground">Select All</span>
                </label>
              </div>
              <div className="border border-border rounded-lg p-4 max-h-48 overflow-y-auto bg-muted/30">
                {deptWorkers.length > 0 ? (
                  <Table>
                    <TableBody>
                      {deptWorkers.map((worker: any) => (
                        <TableRow key={worker.walletAddress} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20">
                          <TableCell className="py-2 pl-0 w-6">
                            <input
                              type="checkbox"
                              checked={selectedWorkers.has(worker.walletAddress)}
                              onChange={() => toggleWorkerSelection(worker.walletAddress)}
                              className="w-4 h-4 rounded border-border"
                              disabled={isProcessing}
                            />
                          </TableCell>
                          <TableCell className="text-sm font-medium text-foreground py-2">{worker.name || 'Unnamed'}</TableCell>
                          <TableCell className="text-sm text-muted-foreground py-2">{worker.role}</TableCell>
                          <TableCell className="py-2">
                            <Badge className={`rounded-full px-2 py-0.5 text-xs ${
                              worker.status === 'active'
                                ? 'bg-secondary/20 text-secondary'
                                : 'bg-yellow-100 text-yellow-700'
                            }`}>
                              {worker.status === 'active' ? 'Active' : 'Needs Tokens'}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground py-2">
                            {worker.currentPeriod?.validTo ? new Date(worker.currentPeriod.validTo).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Not paid'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-4">No workers in this department</p>
                )}
              </div>
            </div>

            {/* Periods Selector */}
            <div className="mb-6">
              <Label className="text-sm font-medium text-foreground block mb-3">Cover payroll for:</Label>
              <div className="flex gap-3">
                {['1', '3', '6', '12'].map((period) => (
                  <button
                    key={period}
                    onClick={() => setSelectedPeriods(period)}
                    disabled={isProcessing}
                    className={`px-4 py-2 rounded-lg font-medium text-sm transition ${
                      selectedPeriods === period
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border hover:border-primary'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    {period} {period === '1' ? 'month' : 'months'}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground mt-2">Paying for multiple months now means automatic payments later—no extra work.</p>
            </div>

            {/* Fee Summary */}
            <div className="bg-muted/30 rounded-lg p-4 border border-border mb-6">
              <p className="text-sm text-foreground">
                <span className="font-medium">Estimated network fee:</span> {constants.SCROLL_FIXED_COST} sats (Sponsored by Treasury)
              </p>
              <p className="text-xs text-muted-foreground mt-2">Company treasury pays this. Workers pay nothing.</p>
            </div>

            {/* Issue Button */}
            <Button 
              onClick={handleIssueTokens}
              disabled={selectedWorkers.size === 0 || isProcessing || !currentPlanNftUtxo || registeredDepts.length === 0}
              className="w-full bg-secondary hover:bg-secondary/90 disabled:bg-muted disabled:text-muted-foreground text-secondary-foreground font-semibold py-2 rounded-lg mb-6"
            >
              {isProcessing ? 'Processing (60-105 sec)...' : `Issue Tokens for ${selectedWorkers.size} ${selectedWorkers.size === 1 ? 'Worker' : 'Workers'}`}
            </Button>

            {/* Preview Section */}
            {selectedWorkers.size > 0 && (
              <div className="bg-primary/5 border border-primary/20 rounded-lg p-4">
                <p className="text-sm text-foreground mb-2">
                  <span className="font-medium">Summary:</span> {selectedWorkers.size} worker{selectedWorkers.size !== 1 ? 's' : ''} will receive tokens covering the next {selectedPeriods} month{parseInt(selectedPeriods) !== 1 ? 's' : ''}
                </p>
                <p className="text-sm text-foreground">
                  <span className="font-medium">Total:</span> {selectedWorkers.size * parseInt(selectedPeriods)} tokens issued in 1 Bitcoin transaction
                </p>
                <p className="text-xs text-muted-foreground mt-2">Instead of {selectedWorkers.size * parseInt(selectedPeriods)} separate transactions, you pay once.</p>
              </div>
            )}
          </Card>
        </div>

        {/* Table Filters */}
        <div className="flex gap-3 mb-6">
          {['all', 'Active', 'Needs Tokens'].map((status) => (
            <button
              key={status}
              onClick={() => setStatusFilter(status)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition ${
                statusFilter === status
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground border border-border hover:border-primary'
              }`}
            >
              {status === 'all' ? 'All' : status}
            </button>
          ))}
        </div>

        {/* Workforce Registry Table */}
        <Card className="bg-card border border-border rounded-xl overflow-hidden">
          <div className="px-8 py-6 border-b border-border flex items-center justify-between">
            <div>
              <h2 className="text-xl font-bold text-primary">Workforce Registry</h2>
              <p className="text-sm text-muted-foreground mt-1">{filteredByStatus.length} workers</p>
            </div>
            <p className="text-xs text-muted-foreground">🟡 Yellow = Needs Tokens. Select them above to issue coverage.</p>
          </div>

          <div className="overflow-x-auto max-h-96 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-card">
                <TableRow className="border-b border-border hover:bg-transparent">
                  <TableHead className="text-foreground font-semibold">Worker</TableHead>
                  <TableHead className="text-foreground font-semibold">Role</TableHead>
                  <TableHead className="text-foreground font-semibold">Department</TableHead>
                  <TableHead className="text-foreground font-semibold">Status</TableHead>
                  <TableHead className="text-foreground font-semibold">Paid Through</TableHead>
                  <TableHead className="text-foreground font-semibold text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {/* FIX C: Use walletAddress as key and ensure valid name filtering */}
                {filteredByStatus.map((worker: any) => (
                  <TableRow key={worker.walletAddress || worker.id} className="border-b border-border hover:bg-muted/30 transition">
                    <TableCell className="font-medium text-foreground">{worker.name || 'Unnamed'}</TableCell>
                    <TableCell className="text-foreground">{worker.role}</TableCell>
                    <TableCell>
                      <Badge className={`rounded-full px-3 py-1 text-xs ${
                        worker.engagementType === 'freelancer'
                          ? 'bg-accent/20 text-accent'
                          : 'bg-primary/10 text-primary'
                      }`}>
                        {worker.engagementType === 'freelancer' ? 'Freelancer' : 
                         worker.department ? 
                         worker.department.charAt(0).toUpperCase() + worker.department.slice(1) : 
                         'Engineering'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge
                        className={`rounded-full px-3 py-1 text-sm ${
                          worker.status === 'active'
                            ? 'bg-secondary/20 text-secondary'
                            : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {worker.status === 'active' ? 'Active' : 'Needs Tokens'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-foreground text-sm">
                      {worker.currentPeriod?.validTo ? new Date(worker.currentPeriod.validTo).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Not paid'}
                    </TableCell>
                    <TableCell className="text-right flex gap-2 justify-end">
                      <button className="px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground rounded-lg transition border border-border">
                        Edit
                      </button>
                      <Button 
                        variant="ghost" 
                        size="sm" 
                        className="text-destructive hover:text-destructive hover:bg-destructive/10"
                        onClick={() => handleTerminate(worker.walletAddress)}
                      >
                        Terminate
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </Card>

        {/* Helper Text */}
        <div className="mt-8 p-4 bg-muted/30 rounded-lg border border-border">
          <p className="text-sm text-foreground">
            <span className="font-medium">✨ One NFT per department, unlimited workers.</span> Create a department NFT once, then add as many workers as you need with different salaries. All workers under the same department share the same pay frequency.
          </p>
          <p className="text-sm text-foreground mt-2">
            <span className="font-medium">🔒 Salaries encrypted.</span> Only you and the worker can see payment details. The blockchain only enforces the pay period, not individual salaries.
          </p>
        </div>
      </main>
    </div>
  )
}