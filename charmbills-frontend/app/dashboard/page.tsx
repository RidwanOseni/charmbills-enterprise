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
import { Wallet, Users, CheckCircle } from 'lucide-react'
import { useWallet } from '@/lib/WalletContext';
import { getWalletStatus } from '@/lib/charms-utils';
import { WorkerStatus, ProverResult } from '../../shared/types';
import * as constants from '../../shared/constants';

export default function EmployerDashboard() {
  // FIX 1: Add connect/disconnect to destructuring [3, 4]
  const { 
    address, 
    walletConnected, 
    connectWallet, 
    disconnectWallet, 
    signAndBroadcastPackage 
  } = useWallet();

  const [workers, setWorkers] = useState<any[]>([]);
  const [vaultBalance, setVaultBalance] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [nextRunDate, setNextRunDate] = useState<string>('Calculating...');
  const [hasActiveWorkers, setHasActiveWorkers] = useState<boolean>(false);
  
  const [fullName, setFullName] = useState('')
  const [role, setRole] = useState('')
  const [salary, setSalary] = useState('')
  const [bitcoinAddress, setBitcoinAddress] = useState('')
  const [department, setDepartment] = useState('engineering')
  const [payFrequency, setPayFrequency] = useState('monthly')
  const [workerType, setWorkerType] = useState('employee')
  
  // FIX 2: Explicitly type Set as string to fix "never" errors [1, 2]
  const [selectedWorkers, setSelectedWorkers] = useState<Set<string>>(new Set());
  const [selectedDept, setSelectedDept] = useState('engineering')
  const [selectedPeriods, setSelectedPeriods] = useState('1')
  const [statusFilter, setStatusFilter] = useState('all')
  const [toast, setToast] = useState('')
  
  // State for the active Plan NFT (Authority) needed for batch minting
  const [currentPlanNftUtxo, setCurrentPlanNftUtxo] = useState('');
  const [currentPlanMetadata, setCurrentPlanMetadata] = useState<any>(null);

  // DYNAMIC DATA FETCHING (Overview Cards)
  useEffect(() => {
    const fetchStats = async () => {
      try {
        const statsRes = await axios.get('/api/dashboard/stats');
        if (statsRes.data.nextRun) {
          const date = new Date(statsRes.data.nextRun);
          setNextRunDate(date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }));
          setHasActiveWorkers(true);
        } else {
          setNextRunDate("Waiting for first hire"); // Fix for hardcoded oversight [4]
          setHasActiveWorkers(false);
        }
      } catch (err) {
        setNextRunDate("No active payroll");
        setHasActiveWorkers(false);
      }
    };
    fetchStats();
  }, [workers]);

  // Dynamic Fetch: Workforce Registry & Company Vault
  useEffect(() => {
    const fetchDashboardData = async () => {
      if (!walletConnected) return;
      
      try {
        // 1. Fetch Company Vault Balance (Treasury)
        const treasuryAddr = process.env.NEXT_PUBLIC_TREASURY_ADDRESS!; 
        const status = await getWalletStatus(treasuryAddr);
        setVaultBalance(status.totalBalance);

        // 2. Fetch Workers from Derivable Indexer
        const response = await axios.get('/api/workers'); 
        setWorkers(response.data);
        
        // Check if there are any active workers
        const activeExists = response.data.some((w: any) => w.currentPeriod?.status === 'active');
        setHasActiveWorkers(activeExists);
        
      } catch (error) {
        console.error('Failed to fetch dashboard data:', error);
      }
    };
    fetchDashboardData();
  }, [walletConnected]);

  // Implement Dynamic Plan NFT Retrieval
  useEffect(() => {
    const fetchPlanForDepartment = async () => {
      if (!walletConnected || selectedDept === 'all') return;
      try {
        // Fetch the Plan NFT governing this department from the Derivable Indexer cache [7]
        const response = await axios.get(`/api/plans?department=${selectedDept}`);
        if (response.data && response.data.length > 0) {
          const plan = response.data;
          setCurrentPlanNftUtxo(plan.nftUtxoId);
          // Metadata is required for supply math in the ZK-proof [8, 9]
          setCurrentPlanMetadata({
            ticker: plan.ticker,
            remaining: plan.remaining,
            metadataHash: plan.metadataHash,
            scrollPolicy: plan.scrollPolicy,
            payPeriodSeconds: plan.payPeriodSeconds,
            compensationSats: plan.compensationSats
          });
        }
      } catch (error) {
        console.error('Failed to fetch departmental Plan NFT:', error);
      }
    };
    fetchPlanForDepartment();
  }, [walletConnected, selectedDept]);

  // Card Helper: Dynamic Team Count
  const totalWorkers = workers.length;

  // FIX 3: Department filter with type assertion to access metadata [10, 12]
  const deptWorkers = selectedDept === 'all' 
    ? workers 
    : workers.filter((w: any) => w.department === selectedDept);

  const filteredByStatus = statusFilter === 'all'
    ? workers
    : workers.filter((w: any) => {
        if (statusFilter === 'Active') return w.currentPeriod?.status === 'active';
        if (statusFilter === 'Needs Tokens') return w.currentPeriod?.status === 'pending' || !w.currentPeriod;
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
      // Map to unique wallet addresses [14, 15]
      setSelectedWorkers(new Set(deptWorkers.map((w: any) => w.wallet)));
    }
  };

  const refreshWorkers = async () => {
    try {
      const response = await axios.get('/api/workers');
      setWorkers(response.data);
    } catch (error) {
      console.error('Failed to refresh workers:', error);
    }
  };

  // PRODUCTION ENCRYPTION (Hire Logic)
  const handleHire = async () => {
    if (!fullName || !role || !salary || !bitcoinAddress) return;
    setIsProcessing(true);

    try {
      // Request wallet signature for non-custodial entropy [5]
      console.log("🔐 Requesting encryption authority from wallet...");
      const signatureResponse = await (window as any).LeatherProvider.request("signMessage", {
        message: "CharmBills Payroll Encryption Authority v1",
        paymentType: "p2tr",
        network: "testnet"
      });

      const payload = {
        department,
        role,
        compensationSats: parseInt(salary),
        payPeriodSeconds: constants.SECONDS_PER_BIWEEK,
        scrollPolicy: workerType === 'employee' ? 0 : 1,
        employerAddress: address,
        encryptionEntropy: signatureResponse.result.signature, // Non-custodial fix
        multiSigRequired: true
      };

      const response = await axios.post('/api/plans/mint', payload);
      const proverResult: ProverResult = response.data;

      // Step 2: Trigger Phase 3 Dual-Signing (Commit + Spell)
      // FIX: Use optional chaining to prevent crashes if user closes wallet without signing
      const signingResult = await signAndBroadcastPackage(proverResult, response.data.dualUtxoContext);
      const txids = signingResult?.txids;

      if (txids && txids.length > 0) {
        setToast(`✅ Hire Initiated! Tx: ${txids[0]}`);
        // Optimistic UI Update
        setWorkers([...workers, { 
          wallet: bitcoinAddress, 
          name: fullName, 
          role, 
          department,
          engagementType: workerType as any, 
          currentPeriod: {
            tokenId: '',
            validFrom: new Date().toISOString(),
            validTo: new Date(Date.now() + constants.SECONDS_PER_BIWEEK * 1000).toISOString(),
            status: 'pending'
          }
        } as any]);
        setFullName('');
        setRole('');
        setSalary('');
        setBitcoinAddress('');
        setDepartment('engineering');
        setPayFrequency('monthly');
        setWorkerType('employee');
      } else {
        // Handle case where user cancelled signing
        console.log('User cancelled signing or no transaction IDs returned');
        setToast('⚠️ Signing was cancelled or failed');
      }
    } catch (err: any) {
      console.error("Hire failed:", err.message);
      setToast(`❌ Hire failed: ${err.message}`);
    } finally {
      setIsProcessing(false);
      setTimeout(() => setToast(''), 4000);
    }
  };

  // Correct handleIssueTokens Implementation
  const handleIssueTokens = async () => {
    if (selectedWorkers.size === 0 || !currentPlanNftUtxo) {
      setToast("❌ Please select workers and ensure a Plan NFT is active.");
      return;
    }
    setIsProcessing(true);

    try {
      // Filter the workforce to only the selected wallets [17, 19]
      const workerList = workers.filter(w => selectedWorkers.has(w.wallet));
      const periods = parseInt(selectedPeriods);

      // Construct payload for /api/payrollhiring/mint [8]
      const payload = {
        authorityUtxo: currentPlanNftUtxo, // The Plan NFT found by the indexer
        workers: workerList.map(w => ({ address: w.wallet, periods })),
        employerAddress: address,
        planMetadata: currentPlanMetadata // Necessary for ZK-supply math [9]
      };

      const response = await axios.post('/api/payrollhiring/mint', payload);
      
      // Execute the Dual-Signing Flow (Commit + Spell) [16, 20]
      // FIX: Use optional chaining to prevent crashes if user closes wallet without signing
      const signingResult = await signAndBroadcastPackage(response.data, response.data.dualUtxoContext);
      const txids = signingResult?.txids;
      
      if (txids && txids.length > 0) {
        setToast(`✅ Batch tokens issued! ${workerList.length} workers covered.`);
        await refreshWorkers();
        setSelectedWorkers(new Set());
      } else {
        // Handle case where user cancelled signing
        console.log('User cancelled signing or no transaction IDs returned');
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

  // PRODUCTION TERMINATION HANDLER: Triggers 3-of-5 Board override to freeze vault funds
  const handleTerminate = async (workerWallet: string) => {
    if (!confirm("Are you sure? This triggers a 3-of-5 Board override to freeze vault funds.")) return;
    
    try {
      await axios.post('/api/workers/terminate', { walletAddress: workerWallet });
      setToast("✅ Termination initiated. Check Treasury for Board approval.");
      await refreshWorkers(); // Refresh workers list
    } catch (err) {
      console.error("Termination failed:", err);
      setToast("❌ Failed to initiate termination.");
      setTimeout(() => setToast(''), 4000);
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Main Content */}
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
            <p className="text-xs text-muted-foreground mt-2">Employees and freelancers</p>
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
          <h1 className="text-3xl font-bold text-primary mb-2">Manage Your Team</h1>
          <p className="text-foreground">Add workers and issue tokens for payroll</p>
        </div>

        {/* Action Cards Grid */}
        <div className="grid lg:grid-cols-3 gap-8 mb-12">
          {/* Card A: New Hire */}
          <Card className="p-8 bg-card border border-border rounded-xl">
            <div className="flex items-center gap-3 mb-6">
              <div className="p-2 bg-primary/10 rounded-lg">
                <Users className="w-6 h-6 text-primary" />
              </div>
              <h2 className="text-2xl font-bold text-primary">New Hire</h2>
            </div>

            <div className="space-y-5">
              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Full Name</Label>
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
                <Label className="text-sm font-medium text-foreground block mb-2">Salary (sats)</Label>
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

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Department</Label>
                <Select value={department} onValueChange={setDepartment} disabled={workerType === 'freelancer' || isProcessing}>
                  <SelectTrigger className="rounded-lg border-border bg-background text-foreground disabled:opacity-60">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="engineering">Engineering</SelectItem>
                    <SelectItem value="design">Design</SelectItem>
                    <SelectItem value="product">Product</SelectItem>
                    <SelectItem value="marketing">Marketing</SelectItem>
                    <SelectItem value="operations">Operations</SelectItem>
                  </SelectContent>
                </Select>
                {workerType === 'freelancer' && (
                  <p className="text-xs text-muted-foreground mt-1">Freelancers are automatically assigned to the Freelancer category</p>
                )}
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Pay Frequency</Label>
                <Select value={payFrequency} onValueChange={setPayFrequency} disabled={isProcessing}>
                  <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="weekly">Weekly</SelectItem>
                    <SelectItem value="biweekly">Bi-weekly</SelectItem>
                    <SelectItem value="monthly">Monthly</SelectItem>
                    <SelectItem value="demo">Demo</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label className="text-sm font-medium text-foreground block mb-2">Worker Type</Label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setWorkerType('employee')}
                    disabled={isProcessing}
                    className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                      workerType === 'employee'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Employee
                  </button>
                  <button
                    onClick={() => setWorkerType('freelancer')}
                    disabled={isProcessing}
                    className={`flex-1 px-4 py-2 rounded-lg font-medium transition ${
                      workerType === 'freelancer'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground border border-border'
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    Freelancer
                  </button>
                </div>
              </div>

              <Button 
                onClick={handleHire} 
                disabled={isProcessing}
                className="w-full bg-primary hover:bg-primary/90 text-primary-foreground font-semibold py-2 rounded-lg disabled:opacity-50"
              >
                {isProcessing ? 'Processing...' : 'Hire'}
              </Button>
            </div>
          </Card>

          {/* Card B: Batch Minting */}
          <Card className="p-8 bg-card border border-border rounded-xl flex flex-col md:col-span-2">
            <div>
              <h2 className="text-2xl font-bold text-primary mb-1">Pay Your Team — All at Once</h2>
              <p className="text-foreground mb-6">Issue tokens in one transaction. Save 90% on fees.</p>

              {/* Department Selector */}
              <div className="mb-6">
                <Label className="text-sm font-medium text-foreground block mb-2">Select Department/Role</Label>
                <Select value={selectedDept} onValueChange={setSelectedDept} disabled={isProcessing}>
                  <SelectTrigger className="rounded-lg border-border bg-background text-foreground">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="engineering">Engineering Department</SelectItem>
                    <SelectItem value="design">Design Department</SelectItem>
                    <SelectItem value="product">Product Department</SelectItem>
                    <SelectItem value="marketing">Marketing Department</SelectItem>
                    <SelectItem value="operations">Operations Department</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Worker Selection Table */}
              <div className="mb-6">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-sm font-medium text-foreground">Workers in {selectedDept.charAt(0).toUpperCase() + selectedDept.slice(1)}</p>
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
                          <TableRow key={worker.wallet} className="border-b border-border/50 last:border-b-0 hover:bg-muted/20">
                            <TableCell className="py-2 pl-0 w-6">
                              <input
                                type="checkbox"
                                // Correctly checks the wallet against the explicitly typed Set [23, 24]
                                checked={selectedWorkers.has(worker.wallet)}
                                onChange={() => toggleWorkerSelection(worker.wallet)}
                                className="w-4 h-4 rounded border-border"
                                disabled={isProcessing}
                              />
                            </TableCell>
                            <TableCell className="text-sm font-medium text-foreground py-2">{worker.name || 'Unnamed'}</TableCell>
                            <TableCell className="text-sm text-muted-foreground py-2">{worker.role}</TableCell>
                            <TableCell className="py-2">
                              <Badge className={`rounded-full px-2 py-0.5 text-xs ${
                                worker.currentPeriod?.status === 'active'
                                  ? 'bg-secondary/20 text-secondary'
                                  : 'bg-yellow-100 text-yellow-700'
                              }`}>
                                {worker.currentPeriod?.status === 'active' ? 'Active' : 'Needs Tokens'}
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
                disabled={selectedWorkers.size === 0 || isProcessing || !currentPlanNftUtxo}
                className="w-full bg-secondary hover:bg-secondary/90 disabled:bg-muted disabled:text-muted-foreground text-secondary-foreground font-semibold py-2 rounded-lg mb-6"
              >
                {isProcessing ? 'Processing...' : `Issue Tokens for ${selectedWorkers.size} ${selectedWorkers.size === 1 ? 'Worker' : 'Workers'}`}
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
            </div>
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
                {filteredByStatus.map((worker: any) => (
                  <TableRow
                    key={worker.wallet}
                    className="border-b border-border hover:bg-muted/30 transition"
                  >
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
                          worker.currentPeriod?.status === 'active'
                            ? 'bg-secondary/20 text-secondary'
                            : 'bg-yellow-100 text-yellow-700'
                        }`}
                      >
                        {worker.currentPeriod?.status === 'active' ? 'Active' : 'Needs Tokens'}
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
                        onClick={() => handleTerminate(worker.wallet)}
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
            <span className="font-medium">✨ One transaction pays your whole team.</span> Instead of {totalWorkers} separate payments, you pay once. Workers see their status instantly.
          </p>
          <p className="text-sm text-foreground mt-2">
            <span className="font-medium">🔒 All salaries encrypted.</span> Only you and the worker can see payment details.
          </p>
        </div>
      </main>
    </div>
  )
}