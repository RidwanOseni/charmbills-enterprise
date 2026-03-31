import { Request, Response } from 'express';
import { generateUnsignedTransactions, batchPayroll } from '../charms/proverClient';
import { getDynamicFundingUtxo, estimateRequiredSats, fetchTransactionHex } from '../lib/utxo-manager';
import { SpellRequest, ProverResult } from '@shared/types';
import { calculateScrollFee, verifyUtxoStatus } from '../lib/charms-utils';
import { encryptPayrollData } from '@shared/encryption';
import { pinToIPFS } from '../lib/ipfs-pinner';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';
import { Database } from 'sqlite3';

const db = new (require('sqlite3').Database)(process.env.PAYROLL_DB_PATH || './payroll.db');

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface WorkerAllocation {
  address: string;
  periods: number;        // Number of pay periods (1 token = 1 period)
  salarySats: number;     // Individual worker salary in satoshis
  role: string;           // Worker's role (e.g., "Senior Engineer")
}

interface MintPayrollTokenRequest {
  authorityUtxo: string;      // Plan NFT UTXO from frontend scanner
  authorityTxHex: string;     // Plan NFT creation tx hex (for provenance)
  workers: WorkerAllocation[]; // Array of workers with their allocations, salaries, and roles
  employerAddress: string;     // Where to return the Plan NFT
  planMetadata: {
    appId: string;
    ticker: string;
    remaining: number;
    metadataHash: string;
    scrollPolicy: number;
    payPeriodSeconds: number;
    compensationSats: number;
  };
  encryptionEntropy: string;   // REQUIRED: From wallet signature
}

interface CompanyRecord {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  createdAt: string;
  updatedAt?: string;
}

// --------------------------------------------------------------------------------
// Database Helper
// --------------------------------------------------------------------------------

async function getCompanyByEmployer(employerAddress: string): Promise<CompanyRecord | null> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
      [employerAddress],
      (err: Error | null, row: any) => {
        if (err) reject(err);
        else resolve(row || null);
      }
    );
  });
}

// --------------------------------------------------------------------------------
// Validation Functions
// --------------------------------------------------------------------------------

function validateMintRequest(body: any): asserts body is MintPayrollTokenRequest {
  const required = [
    'authorityUtxo',
    'authorityTxHex',
    'workers',
    'employerAddress',
    'planMetadata',
    'encryptionEntropy'
  ];
  
  const missing = required.filter(field => {
    const value = body[field];
    return value === undefined || value === null || value === '';
  });
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
  // Validate authorityUtxo format
  if (!/^[0-9a-f]+:\d+$/i.test(body.authorityUtxo)) {
    throw new Error('authorityUtxo must be in format "txid:vout"');
  }
  
  // Validate authorityTxHex is a valid hex string
  if (!/^[0-9a-f]+$/i.test(body.authorityTxHex.replace(/\s/g, ''))) {
    throw new Error('authorityTxHex must be a valid hex string');
  }
  
  // Validate workers array
  if (!Array.isArray(body.workers) || body.workers.length === 0) {
    throw new Error('workers must be a non-empty array');
  }
  
  // Validate each worker with new fields
  body.workers.forEach((w: any, i: number) => {
    if (!w.address || typeof w.address !== 'string') {
      throw new Error(`Worker ${i}: address is required`);
    }
    
    // Validate periods (optional, default 1)
    if (w.periods !== undefined && (typeof w.periods !== 'number' || w.periods <= 0)) {
      throw new Error(`Worker ${i}: periods must be a positive number if provided`);
    }
    
    // Validate salarySats
    if (typeof w.salarySats !== 'number' || w.salarySats < constants.MIN_OUTPUT_SATS) {
      throw new Error(`Worker ${i}: salarySats must be a number >= ${constants.MIN_OUTPUT_SATS}`);
    }
    
    // Validate role
    if (!w.role || typeof w.role !== 'string' || w.role.trim().length === 0) {
      throw new Error(`Worker ${i}: role is required and must be a non-empty string`);
    }
    
    // Validate address format (basic Bech32 check)
    if (!w.address.startsWith('tb1') && !w.address.startsWith('bc1')) {
      throw new Error(`Worker ${i}: address must be a valid Bech32 address (tb1... or bc1...)`);
    }
  });
  
  // Validate employer address
  if (!body.employerAddress.startsWith('tb1') && !body.employerAddress.startsWith('bc1')) {
    throw new Error('employerAddress must be a valid Bech32 address');
  }
  
  // Validate planMetadata
  if (!body.planMetadata.appId || typeof body.planMetadata.appId !== 'string') {
    throw new Error('planMetadata.appId is required');
  }
  
  if (typeof body.planMetadata.remaining !== 'number' || body.planMetadata.remaining < 0) {
    throw new Error('planMetadata.remaining must be a non-negative number');
  }
  
  if (!body.planMetadata.metadataHash || typeof body.planMetadata.metadataHash !== 'string') {
    throw new Error('planMetadata.metadataHash is required');
  }
  
  // Validate encryptionEntropy is a non-empty string
  if (typeof body.encryptionEntropy !== 'string' || body.encryptionEntropy.length === 0) {
    throw new Error('encryptionEntropy must be a non-empty string from wallet signature');
  }
}

// --------------------------------------------------------------------------------
// Main API Handler - PRODUCTION VERSION
// --------------------------------------------------------------------------------

/**
 * Endpoint to hire workers (mint payroll tokens) with dynamic UTXO selection
 * POST /api/payrollhiring/mint
 * 
 * UNIFIED DEPARTMENTAL NFT MODEL:
 * - Each worker has their own salary and role stored in encrypted IPFS
 * - One Plan NFT governs the entire department
 * - Salary enforcement happens at Scroll Settlement Layer, not on-chain
 */
export async function mintPayrollToken(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START mintPayrollToken =====`);
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Validate request body
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Validating request body...`);
    
    if (!req.body || Object.keys(req.body).length === 0) {
      console.error(`[HIRING API:${requestId}] ❌ Empty request body`);
      return res.status(400).json({ error: 'Request body is required' });
    }
    
    // Log sanitized request
    console.log(`[HIRING API:${requestId}] Request summary:`, {
      authorityUtxo: req.body.authorityUtxo ? `${req.body.authorityUtxo.substring(0, 30)}...` : 'missing',
      workerCount: req.body.workers?.length || 0,
      employerAddress: req.body.employerAddress ? `${req.body.employerAddress.substring(0, 20)}...` : 'missing',
      hasPlanMetadata: !!req.body.planMetadata,
      appId: req.body.planMetadata?.appId ? `${req.body.planMetadata.appId.substring(0, 16)}...` : 'missing',
      hasEncryptionEntropy: !!req.body.encryptionEntropy
    });
    
    // Validate all required fields
    validateMintRequest(req.body);
    
    const { 
      authorityUtxo,
      authorityTxHex,
      workers,
      employerAddress,
      planMetadata,
      encryptionEntropy
    } = req.body;
    
    // Clean hex
    const cleanAuthorityTxHex = authorityTxHex.replace(/\s/g, '');
    
    console.log(`[HIRING API:${requestId}] ✅ Validation passed`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Safely handle encryption entropy - FIX TS2345
    // This ensures the value passed to encryption is NEVER undefined
    // ----------------------------------------------------------------------------
    const entropy: string = encryptionEntropy || process.env.DEFAULT_ENCRYPTION_ENTROPY || "";
    
    if (!entropy) {
      throw new Error("No encryption entropy source available. Wallet signature required.");
    }
    
    console.log(`[HIRING API:${requestId}] 🔐 Encryption entropy available (length: ${entropy.length})`);
    
    // ----------------------------------------------------------------------------
    // Step 3: Look up company to get treasuryHexDest
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] 🔍 Looking up company for employer: ${employerAddress.substring(0, 20)}...`);
    
    const company = await getCompanyByEmployer(employerAddress);
    
    if (!company) {
      console.error(`[HIRING API:${requestId}] ❌ Company not found for employer: ${employerAddress}`);
      return res.status(404).json({ 
        error: 'Company not registered. Please complete company onboarding first.',
        employerAddress: employerAddress.substring(0, 20) + '...'
      });
    }
    
    console.log(`[HIRING API:${requestId}] ✅ Company found`);
    console.log(`[HIRING API:${requestId}] Company treasuryHexDest: ${company.treasuryHexDest.substring(0, 30)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 4: Verify Plan NFT is still unspent
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] 🔍 Verifying Plan NFT UTXO: ${authorityUtxo.substring(0, 30)}...`);
    
    const utxoStatus = await verifyUtxoStatus(authorityUtxo);
    
    if (utxoStatus.spent) {
      console.error(`[HIRING API:${requestId}] ❌ Plan NFT has been spent or is in mempool`);
      return res.status(400).json({ 
        error: "Plan NFT (Authority) has been spent or is in mempool. Please wait for confirmation.",
        utxo: authorityUtxo,
        status: utxoStatus
      });
    }
    
    console.log(`[HIRING API:${requestId}] ✅ Plan NFT is unspent and confirmed`);
    
    // ----------------------------------------------------------------------------
    // Step 5: Encrypt worker data to IPFS with wallet entropy
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] 🔐 Encrypting worker data for ${workers.length} workers...`);
    
    const workerMetadataHashes: string[] = [];
    
    for (let i = 0; i < workers.length; i++) {
      const worker = workers[i];
      console.log(`[HIRING API:${requestId}]   Worker ${i + 1}: ${worker.address.substring(0, 16)}... (${worker.role})`);
      
      // Encrypt worker-specific data using wallet entropy (REAL SALARY is used here)
      const encryptedWorkerData = encryptPayrollData({
        walletAddress: worker.address,
        role: worker.role,
        salarySats: worker.salarySats,  // REAL SALARY for IPFS encryption
        department: planMetadata.ticker?.replace('-PAY', '') || 'Unknown',
        hiredAt: new Date().toISOString(),
        periods: worker.periods || 1
      }, entropy);
      
      // Pin to IPFS
      const { metadataHash } = await pinToIPFS(encryptedWorkerData);
      workerMetadataHashes.push(metadataHash);
      
      // Save to workers table
      await new Promise((resolve, reject) => {
        db.run(
          `INSERT OR REPLACE INTO workers (walletAddress, name, planId, engagementType, status, lastMintedPeriod, currentTokenUtxo, expiresAt, metadataHash, salarySats, role)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            worker.address,
            worker.role,
            planMetadata.appId,
            planMetadata.scrollPolicy === 0 ? 0 : 1,
            'active',
            new Date().toISOString(),
            null,
            new Date(Date.now() + planMetadata.payPeriodSeconds * 1000).toISOString(),
            metadataHash,
            worker.salarySats,  // REAL SALARY stored in DB
            worker.role
          ],
          (err: Error | null) => err ? reject(err) : resolve(null)
        );
      });
    }
    
    console.log(`[HIRING API:${requestId}] ✅ Worker data encrypted and pinned to IPFS`);
    
    // ----------------------------------------------------------------------------
    // Step 6: Calculate total tokens being minted
    // ----------------------------------------------------------------------------
    const totalTokens = workers.reduce((sum, w) => sum + (w.periods || 1), 0);
    const newRemainingSupply = planMetadata.remaining - totalTokens;
    
    console.log(`[HIRING API:${requestId}] Supply calculation:`, {
      currentSupply: planMetadata.remaining,
      tokensToMint: totalTokens,
      newRemaining: newRemainingSupply
    });
    
    // Validate supply constraints
    if (totalTokens > planMetadata.remaining) {
      throw new Error(
        `Insufficient supply: trying to mint ${totalTokens} tokens ` +
        `but only ${planMetadata.remaining} remaining in Plan NFT`
      );
    }
    
    // ----------------------------------------------------------------------------
    // Step 7: Get treasury address from environment
    // ----------------------------------------------------------------------------
    const treasuryAddress = process.env.PAYROLL_TREASURY_ADDRESS;
    if (!treasuryAddress) {
      throw new Error('PAYROLL_TREASURY_ADDRESS not set in environment');
    }
    
    // ----------------------------------------------------------------------------
    // Step 8: Calculate required satoshis for fee sponsorship
    // ----------------------------------------------------------------------------
    const requiredSats = estimateRequiredSats(workers.length);
    console.log(`[HIRING API:${requestId}] Estimated required: ${requiredSats} sats`);
    
    // ----------------------------------------------------------------------------
    // Step 9: Dynamically select funding UTXO from treasury
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Selecting funding UTXO...`);
    
    const funding = await getDynamicFundingUtxo(
      treasuryAddress, 
      requiredSats,
      employerAddress
    );
    
    console.log(`[HIRING API:${requestId}] Selected funding:`, {
      utxo: funding.utxoId,
      value: funding.value
    });
    
    // ----------------------------------------------------------------------------
    // Step 10: Fetch funding UTXO hex from the blockchain
    // CRITICAL: Frontend provides only the UTXO ID, prover needs the full hex
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] 🔍 Fetching funding UTXO hex...`);
    
    const fundingTxid = funding.utxoId.split(':')[0];
    let fundingTxHex: string;
    
    try {
      fundingTxHex = await fetchTransactionHex(fundingTxid);
      console.log(`[HIRING API:${requestId}] ✅ Funding UTXO hex fetched (length: ${fundingTxHex.length} chars)`);
    } catch (error: any) {
      console.error(`[HIRING API:${requestId}] ❌ Failed to fetch funding UTXO hex:`, error.message);
      return res.status(400).json({ 
        error: `Failed to fetch funding transaction hex: ${error.message}`,
        fundingTxid
      });
    }
    
    // ----------------------------------------------------------------------------
    // Step 11: Calculate Scroll service fee
    // ----------------------------------------------------------------------------
    const scrollFee = calculateScrollFee(2, funding.value);
    console.log(`[HIRING API:${requestId}] 💳 Scroll Service Fee: ${scrollFee} sats`);
    
    // ----------------------------------------------------------------------------
    // Step 12: Prepare worker allocations for batchPayroll
    // ----------------------------------------------------------------------------
    const workerAllocations = workers.map(w => ({
      address: w.address,
      amount: w.periods || 1
    }));
    
    console.log(`[HIRING API:${requestId}] Worker allocations:`, {
      count: workerAllocations.length,
      totalTokens: workerAllocations.reduce((sum, w) => sum + w.amount, 0)
    });
    
    // ----------------------------------------------------------------------------
    // Step 13: Create return metadata with placeholder compensationSats
    // CRITICAL FIX: Use placeholder (>= 1000) for the Authority NFT return output [Source 269]
    // The REAL salary is stored in IPFS and DB, but the on-chain NFT needs the placeholder
    // to satisfy the Rust contract validation (compensation_sats >= 1000)
    // ----------------------------------------------------------------------------
    const returnMetadata = {
      ...planMetadata,
      compensationSats: Math.max(planMetadata.compensationSats || 0, constants.MIN_OUTPUT_SATS || 1000)
    };
    
    console.log(`[HIRING API:${requestId}] Return metadata prepared:`, {
      appId: returnMetadata.appId.substring(0, 16) + '...',
      remaining: returnMetadata.remaining,
      compensationSats: returnMetadata.compensationSats,
      isPlaceholder: returnMetadata.compensationSats === (constants.MIN_OUTPUT_SATS || 1000)
    });
    
    // ----------------------------------------------------------------------------
    // Step 14: Generate batch hiring transactions
    // CRITICAL: Pass ALL required parameters to batchPayroll
    // The updated batchPayroll expects:
    // - planUtxo: authorityUtxo
    // - workers: workerAllocations
    // - fundingUtxo: funding
    // - changeAddress: employerAddress (or treasury address for change)
    // - appId: planMetadata.appId
    // - employerAddress: Where to return the Plan NFT
    // - planMetadata: returnMetadata (with placeholder compensationSats)
    // - treasuryHexDest: company.treasuryHexDest
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Calling batchPayroll...`);
    console.log(`[HIRING API:${requestId}] batchPayroll parameters:`, {
      planUtxo: authorityUtxo.substring(0, 30) + '...',
      workerCount: workerAllocations.length,
      fundingUtxo: funding.utxoId,
      changeAddress: employerAddress.substring(0, 20) + '...',
      appId: planMetadata.appId.substring(0, 16) + '...',
      employerAddress: employerAddress.substring(0, 20) + '...',
      returnMetadataCompensation: returnMetadata.compensationSats,
      treasuryHexDest: company.treasuryHexDest.substring(0, 30) + '...'
    });
    
    const result = await batchPayroll(
      authorityUtxo,                           // planUtxo
      workerAllocations,                       // workers
      { utxo: funding.utxoId, value: funding.value }, // fundingUtxo
      employerAddress,                         // changeAddress (for Bitcoin change)
      planMetadata.appId,                      // appId
      employerAddress,                         // employerAddress (where NFT returns)
      returnMetadata,                          // planMetadata (with placeholder compensationSats) ✅
      company.treasuryHexDest,                 // treasuryHexDest
      undefined                                // multiSigSigners
    );
    
    console.log(`[HIRING API:${requestId}] ✅ Transactions generated`);
    
    // ----------------------------------------------------------------------------
    // Step 15: Return success response
    // ----------------------------------------------------------------------------
    const response = {
      ...result,
      fundingUsed: funding.utxoId,
      fundingValue: funding.value,
      workerCount: workers.length,
      totalTokens,
      supplyRemaining: newRemainingSupply,
      scrollFee,
      sponsored: true,
      authorityUtxo: authorityUtxo,
      utxoVerification: { verified: true, unspent: true },
      workerMetadataHashes,
      requestId,
      returnMetadataCompensation: returnMetadata.compensationSats  // Include for debugging
    };
    
    console.log(`[HIRING API:${requestId}] ===== SUCCESS =====`);
    console.log(`  Workers: ${workers.length}`);
    console.log(`  Tokens: ${totalTokens}`);
    console.log(`  Remaining: ${newRemainingSupply}`);
    console.log(`  Return NFT compensationSats: ${returnMetadata.compensationSats}`);
    console.log(`[HIRING API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json(response);

  } catch (error: any) {
    console.error(`\n[HIRING API:${requestId}] ❌ ERROR =====`);
    console.error(`Error: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.error(`[HIRING API:${requestId}] ===== END =====\n`);
    
    let statusCode = 500;
    if (error.message.includes('Missing') || 
        error.message.includes('must be') ||
        error.message.includes('Insufficient supply')) {
      statusCode = 400;
    } else if (error.message.includes('Prover') || error.message.includes('generate')) {
      statusCode = 502;
    } else if (error.message.includes('funding') || error.message.includes('UTXO') || error.message.includes('fetch funding')) {
      statusCode = 503;
    }
    
    return res.status(statusCode).json({
      error: error.message,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Batch Hire API
// --------------------------------------------------------------------------------

export async function batchHireWorkers(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START batchHireWorkers =====`);
  
  try {
    const { 
      authorityUtxo,
      authorityTxHex,
      workers,
      employerAddress,
      planMetadata,
      encryptionEntropy
    } = req.body;
    
    if (!authorityUtxo || !authorityTxHex || !workers || !employerAddress || !planMetadata) {
      throw new Error('Missing required fields');
    }
    
    if (!Array.isArray(workers) || workers.length === 0) {
      throw new Error('workers must be a non-empty array');
    }
    
    // Convert simple addresses to full worker objects
    const allocations = workers.map((w: any) => ({
      address: w.address,
      periods: w.periods || 1,
      salarySats: w.salarySats,
      role: w.role
    }));
    
    req.body.workers = allocations;
    req.body.encryptionEntropy = encryptionEntropy;
    return await mintPayrollToken(req, res);
    
  } catch (error: any) {
    console.error(`\n[HIRING API:${requestId}] ❌ ERROR =====`);
    console.error(error.message);
    
    return res.status(400).json({
      error: error.message,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Get Hiring Quote API
// --------------------------------------------------------------------------------

export async function getHiringQuote(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START getHiringQuote =====`);
  
  try {
    const { workerCount, planRemaining } = req.body;
    
    if (!workerCount || typeof workerCount !== 'number' || workerCount <= 0) {
      throw new Error('workerCount must be a positive number');
    }
    
    if (planRemaining !== undefined && (typeof planRemaining !== 'number' || planRemaining < 0)) {
      throw new Error('planRemaining must be a non-negative number if provided');
    }
    
    const requiredSats = estimateRequiredSats(workerCount);
    const scrollFee = calculateScrollFee(2, requiredSats);
    const supplyRemaining = planRemaining !== undefined ? planRemaining - workerCount : undefined;
    
    const response = {
      workerCount,
      estimatedSatsRequired: requiredSats,
      scrollFee,
      totalSatsRequired: requiredSats + scrollFee,
      supplyRemaining,
      isSupplySufficient: planRemaining !== undefined ? workerCount <= planRemaining : true
    };
    
    console.log(`[HIRING API:${requestId}] Quote:`, response);
    console.log(`[HIRING API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json(response);
    
  } catch (error: any) {
    console.error(`\n[HIRING API:${requestId}] ❌ ERROR =====`);
    console.error(error.message);
    
    return res.status(400).json({
      error: error.message,
      requestId
    });
  }
}