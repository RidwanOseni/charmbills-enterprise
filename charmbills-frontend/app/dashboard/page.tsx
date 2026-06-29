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
import { Wallet, Users, CheckCircle, Building2, PlusCircle, CreditCard, Clock, Download, Lock } from 'lucide-react'
import { useWallet } from '@/lib/WalletContext';
import { getWalletStatus, scanAddressForCharms } from '@/lib/charms-utils';
import { WorkerStatus, ProverResult } from '../../shared/types';
import * as constants from '../../shared/constants';
import { decryptPayrollData, EncryptedData } from '../../shared/encryption';
import { getFromIPFS } from '@/lib/ipfs-pinner';
import { ExportPayrollButton } from '@/components/ExportPayrollButton';

import * as btc from '@scure/btc-signer';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002',
  timeout: 600000
});

const frequencyToSeconds = (freq: string) => {
  const map: Record<string, number> = {
    'weekly': constants.SECONDS_PER_WEEK,
    'biweekly': constants.SECONDS_PER_BIWEEK,
    'monthly': constants.SECONDS_PER_MONTH,
    'demo': constants.DEMO_SECONDS_PER_PERIOD
  };
  return map[freq] || constants.SECONDS_PER_BIWEEK;
};

const getStatusBadge = (status: string) => {
  switch(status) {
    case 'active': 
      return <Badge className="bg-green-500 hover:bg-green-600">Active (On-Chain)</Badge>;
    case 'minting_pending': 
      return <Badge className="bg-blue-500 animate-pulse hover:bg-blue-600">Confirming (Mempool)...</Badge>;
    case 'pending': 
      return <Badge variant="outline" className="text-yellow-600 border-yellow-600">Needs Tokens</Badge>;
    default: 
      return <Badge variant="secondary">Inactive</Badge>;
  }
};

const decryptDepartmentMetadata = async (metadataHash: string, entropy: string): Promise<any> => {
  try {
    console.log(`[DECRYPT] Decrypting metadata for hash: ${metadataHash.substring(0, 16)}...`);
    
    const cidResponse = await api.get(`/api/ipfs/cid/${metadataHash}`);
    const cid = cidResponse.data.cid;
    
    if (!cid) {
      console.error(`[DECRYPT] No CID found for metadata hash: ${metadataHash}`);
      return null;
    }
    
    console.log(`[DECRYPT] Retrieved CID: ${cid}`);
    
    const encryptedBlob = await getFromIPFS(cid);
    
    const preparedBlob = {
      content: hexToBytes(encryptedBlob.content),
      iv: hexToBytes(encryptedBlob.iv),
      tag: hexToBytes(encryptedBlob.tag)
    };
    
    console.log(`[DECRYPT] Converted hex to bytes - content: ${preparedBlob.content.length} bytes, iv: ${preparedBlob.iv.length} bytes`);
    
    const decrypted = await decryptPayrollData(preparedBlob as any, entropy);
    
    console.log(`[DECRYPT] Successfully decrypted metadata`);
    return decrypted;
  } catch (error) {
    console.error('[DECRYPT] Failed to decrypt metadata:', error);
    return null;
  }
};

const estimateDynamicFee = async (workerCount: number): Promise<number> => {
  try {
    const response = await api.get('/api/fees/recommended');
    const { fastestFee } = response.data;
    
    const feeRate = fastestFee + Math.ceil(fastestFee * 0.2);
    const estimatedTxSize = 200 + (workerCount * 50);
    const estimatedFee = feeRate * estimatedTxSize;
    
    console.log(`[FEE ESTIMATE] Rate: ${feeRate} sats/vb, Size: ${estimatedTxSize} vb, Fee: ${estimatedFee} sats`);
    return estimatedFee;
  } catch (error) {
    console.warn('[FEE ESTIMATE] Failed to fetch from backend, using fallback');
    return 2000 + (workerCount * 100);
  }
};

export default function EmployerDashboard() {
  const { 
    address, 
    walletConnected, 
    connectWallet, 
    disconnectWallet, 
    signAndBroadcastPackage,
    taprootPublicKey
  } = useWallet();

  const [registeredDepts, setRegisteredDepts] = useState<any[]>([]);
  const [setupDeptName, setSetupDeptName] = useState('');
  const [setupBudget, setSetupBudget] = useState('100');
  const [setupFrequency, setSetupFrequency] = useState('biweekly');
  const [setupType, setSetupType] = useState('employee');
  const [isSettingUpDept, setIsSettingUpDept] = useState(false);
  
  const [masterAccessKey, setMasterAccessKey] = useState<string>('');
  const [showKeyModal, setShowKeyModal] = useState<boolean>(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [pendingSetupData, setPendingSetupData] = useState<any>(null);
  
  const [selectedDeptId, setSelectedDeptId] = useState('');
  const [fullName, setFullName] = useState('');
  const [role, setRole] = useState('');
  const [salary, setSalary] = useState('');
  const [bitcoinAddress, setBitcoinAddress] = useState('');
  
  const [workers, setWorkers] = useState<any[]>([]);
  const [vaultBalance, setVaultBalance] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [nextRunDate, setNextRunDate] = useState<string>('Calculating...');
  const [hasActiveWorkers, setHasActiveWorkers] = useState<boolean>(false);
  const [isOnboarding, setIsOnboarding] = useState<boolean>(false);
  const [companyRegistered, setCompanyRegistered] = useState<boolean>(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingAttempted, setOnboardingAttempted] = useState<boolean>(false);
  
  const [selectedWorkers, setSelectedWorkers] = useState<Set<string>>(new Set());
  const [selectedDept, setSelectedDept] = useState('');
  const [selectedPeriods, setSelectedPeriods] = useState('1');
  const [statusFilter, setStatusFilter] = useState('all');
  const [toast, setToast] = useState('');
  
  const [currentPlanNftUtxo, setCurrentPlanNftUtxo] = useState('');
  const [currentPlanMetadata, setCurrentPlanMetadata] = useState<any>(null);

  const getDeterministicEntropy = async (): Promise<string | null> => {
    let accessKey = masterAccessKey;
    
    if (!accessKey) {
      const savedKey = sessionStorage.getItem('charm_master_key');
      if (savedKey) {
        setMasterAccessKey(savedKey);
        accessKey = savedKey;
      }
    }
    
    if (!accessKey) {
      console.log('[ENTROPY] No master access key found');
      return null;
    }
    
    try {
      let pubKey = taprootPublicKey;
      
      if (!pubKey && (window as any).LeatherProvider) {
        const response = await (window as any).LeatherProvider.request("getAddresses");
        if (response?.result?.addresses) {
          const p2tr = response.result.addresses.find((a: any) => a.type === 'p2tr');
          if (p2tr && p2tr.publicKey) {
            pubKey = p2tr.publicKey;
          }
        }
      }
      
      if (!pubKey) {
        console.error('[ENTROPY] No public key available');
        return null;
      }
      
      const encoder = new TextEncoder();
      const data = encoder.encode(pubKey + accessKey);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const entropy = bytesToHex(new Uint8Array(hashBuffer));
      
      console.log('[ENTROPY] Derived deterministic entropy (length: ' + entropy.length + ')');
      return entropy;
      
    } catch (error) {
      console.error('[ENTROPY] Failed to derive entropy:', error);
      return null;
    }
  };

  const requireMasterKey = async (action: string): Promise<boolean> => {
    const existingKey = sessionStorage.getItem('charm_master_key');
    if (existingKey) {
      setMasterAccessKey(existingKey);
      return true;
    }
    
    setPendingAction(action);
    setShowKeyModal(true);
    return false;
  };

  const KeyEntryModal = () => {
    const [tempKey, setTempKey] = useState('');
    const [error, setError] = useState('');

    const handleSubmit = async () => {
      if (!tempKey.trim()) {
        setError('Please enter your Master Access Key');
        return;
      }
      
      sessionStorage.setItem('charm_master_key', tempKey);
      setMasterAccessKey(tempKey);
      setShowKeyModal(false);
      
      if (pendingAction === 'fetchPlans') {
        await fetchPlans();
      } else if (pendingAction === 'refreshWorkers') {
        await refreshWorkers();
      } else if (pendingAction === 'setupDepartment' && pendingSetupData) {
        await executeDepartmentSetup(pendingSetupData);
        setPendingSetupData(null);
      }
      setPendingAction(null);
    };

    return (
      <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
        <Card className="max-w-md w-full mx-4 p-6">
          <div className="text-center mb-4">
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-3">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <h2 className="text-xl font-bold text-primary">Unlock Payroll Data</h2>
            <p className="text-sm text-muted-foreground mt-2">
              Enter your company's Master Access Key to view and manage payroll data.
              This key is only stored in your browser for this session.
            </p>
          </div>
          
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-foreground block mb-2">
                Master Access Key
              </Label>
              <Input
                type="password"
                placeholder="Enter your company's access key"
                value={tempKey}
                onChange={(e) => {
                  setTempKey(e.target.value);
                  setError('');
                }}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
                className="rounded-lg border-border bg-background text-foreground"
                autoFocus
              />
              {error && (
                <p className="text-xs text-destructive mt-1">{error}</p>
              )}
            </div>
            
            <div className="text-xs text-muted-foreground bg-muted/30 p-3 rounded-lg">
              <p className="font-medium mb-1">🔐 What is this?</p>
              <p>This key is combined with your wallet's public key to create a secure encryption key. It never leaves your browser.</p>
              <p className="mt-2 font-medium">⚠️ Important:</p>
              <p>You need the SAME key to access data later. Store it securely.</p>
            </div>
            
            <Button onClick={handleSubmit} className="w-full">
              Unlock Dashboard
            </Button>
          </div>
        </Card>
      </div>
    );
  };

  const getBtcContext = async () => {
    if (!address) throw new Error("Wallet not connected");
    
    console.log("[DEPARTMENT SETUP] Scanning wallet for UTXOs...");
    
    // Get all UTXOs
    const response = await axios.get(`${api.defaults.baseURL}/api/utxos/${address}`);
    const utxos = response.data;
    
    console.log(`[DEPARTMENT SETUP] Found ${utxos.length} UTXOs`);
    
    // Scan for charmed UTXOs using the scanner
    console.log("[DEPARTMENT SETUP] Scanning for charmed UTXOs...");
    const charmedTokens = await scanAddressForCharms(address);
    const charmedUtxoIds = new Set(charmedTokens.map((t: any) => t.utxoId));
    console.log(`[DEPARTMENT SETUP] Found ${charmedUtxoIds.size} charmed UTXOs`);
    
    // Fetch hex and script for each UTXO, filtering out charmed ones
    const utxosWithDetails = await Promise.all(
      utxos.map(async (utxo: any) => {
        const utxoId = `${utxo.txid}:${utxo.vout}`;
        const isCharmed = charmedUtxoIds.has(utxoId);
        
        try {
          const hexResponse = await axios.get(`${api.defaults.baseURL}/api/tx/${utxo.txid}/hex`);
          const tx = btc.RawTx.decode(hexToBytes(hexResponse.data));
          const script = tx.outputs[utxo.vout].script;
          return {
            utxoId,
            value: utxo.value,
            hex: hexResponse.data,
            script: bytesToHex(script),
            confirmed: utxo.status?.confirmed,
            isCharmed
          };
        } catch (error) {
          return {
            utxoId,
            value: utxo.value,
            hex: '',
            script: '',
            confirmed: false,
            isCharmed
          };
        }
      })
    );
    
    // Filter to confirmed UTXOs only
    const confirmedUtxos = utxosWithDetails.filter(u => u.confirmed);
    console.log(`[DEPARTMENT SETUP] Confirmed UTXOs: ${confirmedUtxos.length}`);
    
    // Find fresh UTXOs (not charmed) with sufficient value
    const freshUtxos = confirmedUtxos.filter(u => !u.isCharmed && u.value >= 10000);
    console.log(`[DEPARTMENT SETUP] Fresh UTXOs with >= 10,000 sats: ${freshUtxos.length}`);
    
    if (freshUtxos.length === 0) {
      console.error("[DEPARTMENT SETUP] No fresh UTXOs found with >= 10,000 sats");
      console.log("[DEPARTMENT SETUP] Available UTXOs:");
      confirmedUtxos.forEach((u: any) => {
        console.log(`  ${u.utxoId}: ${u.value} sats, charmed: ${u.isCharmed}`);
      });
      throw new Error("No fresh UTXO found with sufficient balance. Please send new funds to your wallet.");
    }
    
    // Select the largest fresh UTXO
    const selectedUtxo = freshUtxos.reduce((a: any, b: any) => a.value > b.value ? a : b);
    console.log(`[DEPARTMENT SETUP] Selected fresh UTXO: ${selectedUtxo.utxoId} (${selectedUtxo.value} sats)`);
    
    return {
      utxos: confirmedUtxos,
      anchor: selectedUtxo,
      fee: selectedUtxo
    };
  };

  const executeDepartmentSetup = async (payload: any) => {
    console.log("[DEPARTMENT SETUP] Executing with payload");
    
    const response = await axios.post('/api/plans/mint', payload, {
      timeout: 600000,
      baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'
    });
    
    const { appId, ...proverData } = response.data;
    const proverResult: ProverResult = proverData;
    
    const signingContext = {
      anchor: payload.consolidatedUtxo,
      fee: payload.consolidatedUtxo
    };
    
    const signingResult = await signAndBroadcastPackage(proverResult, signingContext);
    const txids = signingResult?.txids;
    
    if (txids && txids.length > 0) {
      const newDept = {
        appId: appId || crypto.randomUUID(),
        department: payload.setupDeptName.toLowerCase(),
        ticker: `${payload.setupDeptName.substring(0, 3).toUpperCase()}-PAY`,
        remaining: payload.budgetValue,
        status: 'pending'
      };
      
      setRegisteredDepts(prev => [...prev, newDept]);
      setSelectedDeptId(appId);
      
      setToast(`✅ ${payload.setupDeptName} Department created with ${payload.budgetValue} pay periods budget!`);
      await fetchPlans();
      
      setSetupDeptName('');
      setSetupBudget('100');
      setSetupFrequency('biweekly');
      setSetupType('employee');
    } else {
      setToast('⚠️ Department setup was cancelled or failed');
    }
  };

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
    
    const hasKey = await requireMasterKey('setupDepartment');
    if (!hasKey) {
      setPendingSetupData({
        setupDeptName,
        budgetValue,
        setupFrequency,
        setupType
      });
      return;
    }
    
    setIsSettingUpDept(true);
    
    try {
      console.log("[DEPARTMENT SETUP] Creating department:", setupDeptName);
      console.log("[DEPARTMENT SETUP] Budget:", budgetValue, "pay periods");
      
      const btcContext = await getBtcContext();
      
      console.log(`[DEPARTMENT SETUP] Found ${btcContext.utxos.length} confirmed UTXOs`);
      btcContext.utxos.forEach((utxo: any, i: number) => {
        console.log(`  UTXO ${i}: ${utxo.utxoId}, value=${utxo.value}`);
      });
      
      const consolidatedUtxo = btcContext.anchor;
      
      if (!consolidatedUtxo) {
        throw new Error("No UTXO found with >= 15,000 sats. Please fund your wallet with a larger UTXO for the Plan NFT.");
      }
      
      console.log("[DEPARTMENT SETUP] Selected consolidated UTXO:", {
        utxoId: consolidatedUtxo.utxoId,
        value: consolidatedUtxo.value,
        hasScript: !!consolidatedUtxo.script,
        scriptLength: consolidatedUtxo.script?.length || 0
      });
      
      if (!(window as any).LeatherProvider) {
        throw new Error("Leather wallet not detected");
      }
      
      const encryptionEntropy = await getDeterministicEntropy();
      
      if (!encryptionEntropy) {
        throw new Error("Failed to derive encryption entropy. Please ensure master access key is set.");
      }
      
      console.log("[DEPARTMENT SETUP] Using deterministic entropy for encryption (not signature)");
      
      const payload = {
        anchorUtxo: consolidatedUtxo.utxoId,
        anchorTxHex: consolidatedUtxo.hex,
        anchorValue: consolidatedUtxo.value,
        fundingUtxo: consolidatedUtxo.utxoId,
        fundingValue: consolidatedUtxo.value,
        fundingTxHex: consolidatedUtxo.hex,
        fundingScript: consolidatedUtxo.script,
        employerAddress: address,
        utxoAddress: address,
        department: setupDeptName.toLowerCase(),
        ticker: `${setupDeptName.substring(0, 3).toUpperCase()}-PAY`,
        role: "Department Authority",
        compensationSats: 1000,
        payPeriodSeconds: frequencyToSeconds(setupFrequency),
        scrollPolicy: setupType === 'employee' ? 0 : 1,
        remaining: budgetValue,
        encryptionEntropy: encryptionEntropy,
        multiSigRequired: false,
        consolidatedUtxo: consolidatedUtxo,
        setupDeptName: setupDeptName,
        budgetValue: budgetValue
      };
      
      console.log("[DEPARTMENT SETUP] Payload prepared with single consolidated UTXO");
      
      await executeDepartmentSetup(payload);
      
    } catch (err: any) {
      console.error("[DEPARTMENT SETUP] Failed:", err.message);
      setToast(`❌ Department setup failed: ${err.message}`);
    } finally {
      setIsSettingUpDept(false);
      setTimeout(() => setToast(''), 4000);
    }
  };
  
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
      
      const payload = {
        name: fullName,
        walletAddress: bitcoinAddress,
        planId: dept.appId,
        role: role || "Team Member",
        engagementType: setupType === 'employee' ? 'employee' : 'freelancer',
        salarySats: parseInt(salary) || 5000000,
        status: 'pending'
      };
      
      console.log("[HIRE ADMIN] Payload:", payload);
      
      await api.post('/api/workers/add', payload);
      
      setToast(`✅ Worker added to registry. They'll receive tokens in the next run.`);
      await refreshWorkers();
      
      setFullName('');
      setRole('');
      setSalary('');
      setBitcoinAddress('');
      
    } catch (err: any) {
      console.error("[HIRE ADMIN] Failed:", err.message);
      setToast(`❌ Failed to add worker to registry: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setToast(''), 4000);
    }
  };
  
  const handleIssueTokens = async () => {
    console.log('[BATCH MINT] ===== START =====');
    console.log('[BATCH MINT] selectedWorkers.size:', selectedWorkers.size);
    console.log('[BATCH MINT] currentPlanNftUtxo:', currentPlanNftUtxo);
    console.log('[BATCH MINT] currentPlanMetadata:', currentPlanMetadata ? 'exists' : 'null');
    console.log('[BATCH MINT] registeredDepts.length:', registeredDepts.length);
    console.log('[BATCH MINT] isProcessing:', isProcessing);
    
    if (selectedWorkers.size === 0) {
      console.log('[BATCH MINT] ❌ No workers selected');
      setToast("❌ Please select workers to issue tokens.");
      return;
    }
    
    if (!currentPlanNftUtxo) {
      console.log('[BATCH MINT] ❌ No currentPlanNftUtxo');
      setToast("❌ No active Plan NFT found for this department.");
      return;
    }

    if (!currentPlanMetadata) {
      console.log('[BATCH MINT] ❌ No currentPlanMetadata');
      setToast("❌ Plan metadata not found. Please refresh the page.");
      return;
    }  
    
    setIsProcessing(true);

    try {
      const workerList = workers.filter(w => selectedWorkers.has(w.walletAddress));
      console.log('[BATCH MINT] workerList length:', workerList.length);
      const periods = parseInt(selectedPeriods);
      
      const authorityUtxoId = currentPlanNftUtxo;
      console.log(`[BATCH MINT] Authority (Plan NFT) UTXO: ${authorityUtxoId}`);
      
      const estimatedFee = await estimateDynamicFee(workerList.length);
      
      const outputsCost = (workerList.length + 3) * constants.MIN_OUTPUT_SATS;
      const totalNeeded = outputsCost + estimatedFee + Math.ceil(estimatedFee * 0.5);
      
      console.log(`[BATCH MINT] Dynamic requirement calculation:`);
      console.log(`  Outputs cost (${workerList.length + 3} outputs): ${outputsCost} sats`);
      console.log(`  Estimated fee: ${estimatedFee} sats`);
      console.log(`  Total needed: ${totalNeeded} sats`);

      const payload = {
        authorityUtxo: authorityUtxoId,
        authorityTxHex: '',
        employerAddress: address,
        utxoAddress: address,
        workers: workerList.map(w => ({ 
          address: w.walletAddress, 
          periods,
          salarySats: w.salarySats || 5000000,
          role: w.role || "Team Member"
        })),
        planMetadata: currentPlanMetadata,
        encryptionEntropy: "placeholder"
      };

      console.log("[BATCH MINT] Payload prepared (backend will select funding UTXO):", {
        authorityUtxo: payload.authorityUtxo.substring(0, 30) + '...',
        workersCount: payload.workers.length
      });

      const response = await axios.post('/api/payrollhiring/mint', payload, {
        timeout: 600000,
        baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002'
      });
      
      console.log('[BATCH MINT] Response received from payrollhiring/mint');
      console.log('[BATCH MINT] Backend selected funding UTXO:', {
        utxoId: response.data.fundingUsed,
        value: response.data.fundingValue,
        hasHex: !!response.data.fundingTxHex
      });
      
      const backendFundingUtxo = {
        utxoId: response.data.fundingUsed,
        value: response.data.fundingValue,
        hex: response.data.fundingTxHex,
        script: ''
      };
      
      console.log('[BATCH MINT] Using backend-selected funding UTXO:', {
        utxoId: backendFundingUtxo.utxoId,
        value: backendFundingUtxo.value,
        hexLength: backendFundingUtxo.hex?.length || 0
      });
      
      const [anchorTxid] = authorityUtxoId.split(':');
      const anchorHexResponse = await axios.get(`${api.defaults.baseURL}/api/tx/${anchorTxid}/hex`, { responseType: 'text' });
      const anchorHex = anchorHexResponse.data;
      
      const signingContext = {
        anchor: {
          utxoId: authorityUtxoId,
          value: 1000,
          hex: anchorHex,
          script: ''
        },
        fee: backendFundingUtxo,
        isSingle: true
      };
      
      const signingResult = await signAndBroadcastPackage(response.data, signingContext);
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
    console.log('[BATCH MINT] ===== END =====');
  };
  
  const fetchPlans = async () => {
    if (!address) return;
    try {
      console.log('[FETCH PLANS] Fetching plans for employer:', address);
      const res = await api.get(`/api/plans?employerAddress=${address}`);
      let plans = res.data;
      
      console.log(`[FETCH PLANS] Received ${plans.length} plans from backend`);
      
      if (walletConnected && plans.length > 0) {
        console.log('[FETCH PLANS] Wallet connected, attempting to decrypt missing department names...');
        
        const entropy = await getDeterministicEntropy();
        
        if (entropy) {
          const updatedPlans = [...plans];
          let hasUpdates = false;
          
          for (let i = 0; i < updatedPlans.length; i++) {
            const plan = updatedPlans[i];
            if (!plan.department && plan.metadataHash) {
              console.log(`[FETCH PLANS] 🔓 Attempting to decrypt plan ${plan.appId.substring(0, 8)}... with hash ${plan.metadataHash.substring(0, 16)}...`);
              
              const decrypted = await decryptDepartmentMetadata(plan.metadataHash, entropy);
              
              if (decrypted && decrypted.department) {
                console.log(`[FETCH PLANS] ✅ Successfully decrypted department name: ${decrypted.department}`);
                updatedPlans[i] = { ...plan, department: decrypted.department };
                hasUpdates = true;
              } else {
                console.log(`[FETCH PLANS] ⚠️ Failed to decrypt department name for plan ${plan.appId.substring(0, 8)}...`);
              }
            }
          }
          
          if (hasUpdates) {
            plans = updatedPlans;
          }
          
          console.log('[FETCH PLANS] Lazy decryption loop completed');
        } else {
          console.log('[FETCH PLANS] ⚠️ No entropy available, showing key modal');
          await requireMasterKey('fetchPlans');
          return;
        }
      } else {
        console.log('[FETCH PLANS] Wallet not connected or no plans, skipping decryption');
      }
      
      setRegisteredDepts(plans);
      console.log('[FETCH PLANS] registeredDepts updated with', plans.length, 'plans');
      
      if (plans.length > 0 && !selectedDeptId) {
        setSelectedDeptId(plans[0].appId);
      }
    } catch (error) {
      console.error('Failed to fetch plans:', error);
    }
  };
  
  const refreshWorkers = async () => {
    try {
      console.log('[REFRESH WORKERS] Starting refresh...');
      
      const deptMap: Record<string, string> = {};
      registeredDepts.forEach((dept: any) => {
        if (dept.appId && dept.department) {
          deptMap[dept.appId] = dept.department;
        }
      });
      
      console.log('[DEBUG] Department map from registeredDepts:', deptMap);
      
      const response = await api.get('/api/workers');
      let workersData = response.data;
      
      console.log('[DEBUG] Workers from API:', workersData.map((w: any) => ({ 
        name: w.name, 
        planId: w.planId, 
        department: w.department 
      })));
      
      const enrichedWorkers = workersData.map((worker: any) => {
        if (worker.planId && deptMap[worker.planId]) {
          console.log(`[DEBUG] Enriching worker ${worker.name} (planId: ${worker.planId}) with department: ${deptMap[worker.planId]}`);
          return { ...worker, department: deptMap[worker.planId] };
        }
        return worker;
      });
      
      console.log('[DEBUG] Enriched workers:', enrichedWorkers.map((w: any) => ({ 
        name: w.name, 
        department: w.department 
      })));
      
      setWorkers(enrichedWorkers);
      console.log('[REFRESH WORKERS] Completed');
    } catch (error) {
      console.error('Failed to refresh workers:', error);
    }
  };
  
  useEffect(() => {
    if (registeredDepts.length > 0) {
      console.log('[USE EFFECT] registeredDepts changed, refreshing workers...');
      refreshWorkers();
    }
  }, [registeredDepts]);
  
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

  useEffect(() => {
    const fetchVaultBalance = async () => {
      const treasuryAddr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS || address;
      
      if (!walletConnected || !treasuryAddr) return;

      try {
        const status = await getWalletStatus(treasuryAddr);
        setVaultBalance(status.totalBalance);
      } catch (error) {
        console.error('Failed to fetch vault balance:', error);
        setVaultBalance(0);
      }
    };
    fetchVaultBalance();
  }, [walletConnected, address]);
  
  useEffect(() => {
    if (walletConnected && address) {
      console.log('[DASHBOARD] Wallet connected, fetching plans...');
      fetchPlans();
    }
  }, [walletConnected, address]);
  
  useEffect(() => {
    const fetchPlanForDepartment = async () => {
      console.log('[FETCH PLAN FOR DEPT] selectedDept changed to:', selectedDept);
      if (!selectedDept || !address) {
        console.log('[FETCH PLAN FOR DEPT] No department selected or no address');
        return;
      }
      try {
        const deptFromState = registeredDepts.find(d => d.department === selectedDept);
        if (deptFromState) {
          console.log('[FETCH PLAN FOR DEPT] Found department in state:', deptFromState);
          setCurrentPlanNftUtxo(deptFromState.nftUtxoId || '');
          setCurrentPlanMetadata({
            appId: deptFromState.appId,
            ticker: deptFromState.ticker,
            remaining: deptFromState.remaining,
            metadataHash: deptFromState.metadataHash,
            scrollPolicy: deptFromState.scrollPolicy,
            payPeriodSeconds: deptFromState.payPeriodSeconds,
            compensationSats: deptFromState.compensationSats || 0,
            anchorUtxo: deptFromState.anchorUtxo || ''
          });
          console.log('[FETCH PLAN FOR DEPT] Set currentPlanNftUtxo from state:', deptFromState.nftUtxoId);
          return;
        }
        
        console.log('[FETCH PLAN FOR DEPT] Department not in state, fetching from API...');
        const response = await api.get(`/api/plans?department=${selectedDept}&employerAddress=${address}`);
        if (response.data && response.data.length > 0) {
          const plan = response.data[0];
          console.log('[FETCH PLAN FOR DEPT] Plan from API:', plan);
          setCurrentPlanNftUtxo(plan.nftUtxoId);
          setCurrentPlanMetadata({
            appId: plan.appId,
            ticker: plan.ticker,
            remaining: plan.remaining,
            metadataHash: plan.metadataHash,
            scrollPolicy: plan.scrollPolicy,
            payPeriodSeconds: plan.payPeriodSeconds,
            compensationSats: plan.compensationSats,
            anchorUtxo: plan.anchorUtxo
          });
          console.log('[FETCH PLAN FOR DEPT] Set currentPlanNftUtxo from API:', plan.nftUtxoId);
        } else {
          console.log('[FETCH PLAN FOR DEPT] No plan found for department:', selectedDept);
        }
      } catch (error) {
        console.error('Failed to fetch plan metadata:', error);
      }
    };
    fetchPlanForDepartment();
  }, [selectedDept, address, registeredDepts]);

  const totalWorkers = workers.length;
  const deptWorkers = selectedDept === 'all' 
    ? workers 
    : workers.filter((w: any) => w.department === selectedDept);

  const filteredByStatus = workers.filter((worker) => {
    if (!worker.name) return false;

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
    console.log('[TOGGLE] selectedWorkers size:', newSelected.size);
  };

  const selectAllDeptWorkers = () => {
    if (selectedWorkers.size === deptWorkers.length && deptWorkers.length > 0) {
      setSelectedWorkers(new Set());
      console.log('[SELECT ALL] Cleared all selections');
    } else {
      const newSelected = new Set(deptWorkers.map((w: any) => w.walletAddress));
      setSelectedWorkers(newSelected);
      console.log('[SELECT ALL] Selected', newSelected.size, 'workers');
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

  const getDepartmentDisplayName = (dept: any): string => {
    if (dept.department) {
      return dept.department.charAt(0).toUpperCase() + dept.department.slice(1);
    }
    if (dept.ticker) {
      const tickerName = dept.ticker.replace('-PAY', '');
      return tickerName.charAt(0).toUpperCase() + tickerName.slice(1).toLowerCase();
    }
    return 'Department';
  };

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
        {toast && (
          <div className="mb-6 p-4 bg-secondary/20 text-secondary rounded-lg border border-secondary/30 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <p className="text-sm font-medium">{toast}</p>
          </div>
        )}

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

        <div className="mb-8 flex justify-between items-center">
          <div>
            <h1 className="text-3xl font-bold text-primary mb-2">Employer Orchestration</h1>
            <p className="text-foreground">Create departments, hire workers, and manage payroll with one-click batch payments</p>
          </div>
          <ExportPayrollButton 
            workers={workers}
            registeredDepts={registeredDepts}
            decryptedDeptNames={{}}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-12">
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
                    <SelectItem value="demo">Investor Demo (4 Minutes)</SelectItem>
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
                    <SelectValue>
                      {selectedDeptId ? (
                        getDepartmentDisplayName(registeredDepts.find(d => d.appId === selectedDeptId) || {})
                      ) : (
                        registeredDepts.length === 0 ? "Create a department first" : "Select department"
                      )}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {registeredDepts.map((dept) => (
                      <SelectItem key={dept.appId} value={dept.appId}>
                        {getDepartmentDisplayName(dept)}
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
                <Label className="text-sm font-medium text-foreground block mb-2">Role</Label>
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

        <div className="flex justify-center mb-12">
          <Card className="w-full max-w-4xl p-8 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-secondary/10 rounded-lg">
                <CreditCard className="w-6 h-6 text-secondary" />
              </div>
              <h2 className="text-2xl font-bold text-primary">Pay Your Team — All at Once</h2>
            </div>
            <p className="text-foreground mb-6">Issue tokens in one transaction. Save 90% on fees.</p>

            <div className="mb-6">
              <Label className="text-sm font-medium text-foreground block mb-2">Select Department</Label>
              <Select value={selectedDept} onValueChange={setSelectedDept} disabled={isProcessing || registeredDepts.length === 0}>
                <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                  <SelectValue>
                    {selectedDept ? getDepartmentDisplayName(registeredDepts.find(d => d.department === selectedDept) || {}) : "Select department"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {registeredDepts.map((dept) => (
                    <SelectItem key={dept.appId} value={dept.department || getDepartmentDisplayName(dept).toLowerCase()}>
                      {getDepartmentDisplayName(dept)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className="text-sm font-medium text-foreground">
                  Workers in {selectedDept ? getDepartmentDisplayName(registeredDepts.find(d => d.department === selectedDept) || {}) : 'selected department'}
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
                            {getStatusBadge(worker.status)}
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground py-2">
                            {worker.lastMintedPeriod ? new Date(worker.lastMintedPeriod).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Not paid'}
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

            <div className="bg-muted/30 rounded-lg p-4 border border-border mb-6">
              <p className="text-sm text-foreground">
                <span className="font-medium">Estimated network fee:</span> {constants.SCROLL_FIXED_COST} sats (Sponsored by Treasury)
              </p>
              <p className="text-xs text-muted-foreground mt-2">Company treasury pays this. Workers pay nothing.</p>
            </div>

            <Button 
              onClick={handleIssueTokens}
              disabled={selectedWorkers.size === 0 || isProcessing || !currentPlanNftUtxo || registeredDepts.length === 0}
              className="w-full bg-secondary hover:bg-secondary/90 disabled:bg-muted disabled:text-muted-foreground text-secondary-foreground font-semibold py-2 rounded-lg mb-6"
            >
              {isProcessing ? 'Processing (60-105 sec)...' : `Issue Tokens for ${selectedWorkers.size} ${selectedWorkers.size === 1 ? 'Worker' : 'Workers'}`}
            </Button>

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
                {filteredByStatus.map((worker: any) => (
                  <TableRow key={worker.walletAddress || worker.id} className="border-b border-border hover:bg-muted/30 transition">
                    <TableCell className="font-medium text-foreground">{worker.name || 'Unnamed'}</TableCell>
                    <TableCell className="text-foreground">{worker.role || 'Team Member'}</TableCell>
                    <TableCell>
                      <Badge className="rounded-full px-3 py-1 text-xs bg-primary/10 text-primary">
                        {worker.department ? worker.department.charAt(0).toUpperCase() + worker.department.slice(1) : 'General'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {getStatusBadge(worker.status)}
                    </TableCell>
                    <TableCell className="text-foreground text-sm">
                      {worker.lastMintedPeriod ? new Date(worker.lastMintedPeriod).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) : 'Not paid'}
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

        <div className="mt-8 p-4 bg-muted/30 rounded-lg border border-border">
          <p className="text-sm text-foreground">
            <span className="font-medium">✨ One NFT per department, unlimited workers.</span> Create a department NFT once, then add as many workers as you need with different salaries. All workers under the same department share the same pay frequency.
          </p>
          <p className="text-sm text-foreground mt-2">
            <span className="font-medium">🔒 Salaries encrypted.</span> Only you and the worker can see payment details. The blockchain only enforces the pay period, not individual salaries.
          </p>
        </div>
      </main>
      
      {showKeyModal && <KeyEntryModal />}
    </div>
  )
}