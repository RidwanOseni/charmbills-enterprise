import { Request, Response } from 'express';
import { generateUnsignedTransactions, batchPayroll } from '../charms/proverClient';
import { getDynamicFundingUtxo, estimateRequiredSats, fetchTransactionHex } from '../lib/utxo-manager';
import { SpellRequest, ProverResult } from '@shared/types';
import { calculateScrollFee, verifyUtxoStatus } from '../lib/charms-utils';
import { encryptPayrollData } from '@shared/encryption';
import { pinToIPFS } from '../lib/ipfs-pinner';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

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
  utxoAddress: string;        // The Bitcoin address associated with the authority UTXO
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
    anchorUtxo: string;        // Original anchor UTXO that created the appId (for witness)
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
// Database Helper - Uses db from req.app.locals
// --------------------------------------------------------------------------------

async function getCompanyByEmployer(db: any, employerAddress: string): Promise<CompanyRecord | null> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
  return result.rows[0] || null;
}

// --------------------------------------------------------------------------------
// Helper to get existing worker name
// --------------------------------------------------------------------------------

async function getExistingWorkerName(db: any, walletAddress: string, planId: string): Promise<string | null> {
  const result = await db.execute({
    sql: 'SELECT name FROM workers WHERE walletAddress = ? AND planId = ?',
    args: [walletAddress, planId]
  });
  return result.rows[0] ? result.rows[0].name : null;
}

// --------------------------------------------------------------------------------
// Helper to save or update worker - sets status to 'minting_pending'
// --------------------------------------------------------------------------------

async function saveWorkerRecord(
  db: any,
  walletAddress: string,
  workerName: string,
  planId: string,
  engagementType: number,
  status: string,
  lastMintedPeriod: string,
  currentTokenUtxo: string | null,
  expiresAt: string,
  metadataHash: string,
  salarySats: number,
  role: string
): Promise<void> {
  await db.execute({
    sql: `INSERT OR REPLACE INTO workers (walletAddress, name, planId, engagementType, status, lastMintedPeriod, currentTokenUtxo, expiresAt, metadataHash, salarySats, role)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      walletAddress,
      workerName,
      planId,
      engagementType,
      status,
      lastMintedPeriod,
      currentTokenUtxo,
      expiresAt,
      metadataHash,
      salarySats,
      role
    ]
  });
}

// --------------------------------------------------------------------------------
// Helper to update worker status
// --------------------------------------------------------------------------------

async function updateWorkerStatus(
  db: any,
  walletAddress: string,
  planId: string,
  status: 'active' | 'terminated' | 'pending' | 'minting_pending'
): Promise<void> {
  await db.execute({
    sql: `UPDATE workers 
          SET status = ?, 
              updatedAt = ?
          WHERE walletAddress = ? AND planId = ?`,
    args: [
      status,
      new Date().toISOString(),
      walletAddress,
      planId
    ]
  });
}

// --------------------------------------------------------------------------------
// Helper to update worker after mint (token UTXO) - sets status to 'active'
// This is called ONLY by the Indexer when transaction is confirmed on-chain
// --------------------------------------------------------------------------------

async function updateWorkerPostMint(
  db: any,
  walletAddress: string,
  planId: string,
  tokenUtxo: string,
  expiresAt: string,
  lastMintedPeriod: string
): Promise<void> {
  await db.execute({
    sql: `UPDATE workers 
          SET currentTokenUtxo = ?, 
              expiresAt = ?, 
              lastMintedPeriod = ?,
              status = 'active',
              updatedAt = ?
          WHERE walletAddress = ? AND planId = ?`,
    args: [
      tokenUtxo,
      expiresAt,
      lastMintedPeriod,
      new Date().toISOString(),
      walletAddress,
      planId
    ]
  });
}

// --------------------------------------------------------------------------------
// Validation Functions
// --------------------------------------------------------------------------------

function validateMintRequest(body: any): asserts body is MintPayrollTokenRequest {
  const required = [
    'authorityUtxo',
    // 'authorityTxHex', // REMOVED - will be fetched automatically if needed
    'utxoAddress',
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
  
  // Validate utxoAddress format (basic Bech32 check)
  if (!body.utxoAddress.startsWith('tb1') && !body.utxoAddress.startsWith('bc1')) {
    throw new Error('utxoAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  // Only validate hex format if authorityTxHex is provided and not empty
  if (body.authorityTxHex && body.authorityTxHex.trim() !== '') {
    if (!/^[0-9a-f]+$/i.test(body.authorityTxHex.replace(/\s/g, ''))) {
      throw new Error('authorityTxHex must be a valid hex string');
    }
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
  
  // Validate anchorUtxo in planMetadata (required for mint-token witness)
  if (!body.planMetadata.anchorUtxo || typeof body.planMetadata.anchorUtxo !== 'string') {
    throw new Error('planMetadata.anchorUtxo is required for mint-token witness');
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
 * 
 * DERIVABLE MODEL IMPLEMENTATION:
 * - Workers are set to 'minting_pending' status after transaction generation
 * - The Indexer updates workers to 'active' with actual token UTXOs when confirmed
 * 
 * FIX: Returns fundingTxHex in response to ensure frontend uses the exact UTXO
 *       selected by the backend, preventing UTXO mismatch that causes high fees.
 * 
 * FIX: DYNAMIC TREASURY LOOKUP - Removed hardcoded PAYROLL_TREASURY_ADDRESS env var.
 *       Now uses company.treasuryAddress from database for fee sponsorship.
 */
export async function mintPayrollToken(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  // Get database from app locals
  const db = req.app.locals.db;
  
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
      utxoAddress: req.body.utxoAddress ? `${req.body.utxoAddress.substring(0, 20)}...` : 'missing',
      workerCount: req.body.workers?.length || 0,
      employerAddress: req.body.employerAddress ? `${req.body.employerAddress.substring(0, 20)}...` : 'missing',
      hasPlanMetadata: !!req.body.planMetadata,
      appId: req.body.planMetadata?.appId ? `${req.body.planMetadata.appId.substring(0, 16)}...` : 'missing',
      hasAnchorUtxoInMetadata: !!req.body.planMetadata?.anchorUtxo,
      hasEncryptionEntropy: !!req.body.encryptionEntropy
    });
    
    // Validate all required fields
    validateMintRequest(req.body);
    
    const { 
      authorityUtxo,
      authorityTxHex,
      utxoAddress,
      workers,
      employerAddress,
      planMetadata,
      encryptionEntropy
    } = req.body;
    
    // Fetch authority transaction hex if not provided by frontend
    let cleanAuthorityTxHex = authorityTxHex ? authorityTxHex.replace(/\s/g, '') : '';
    
    if (!cleanAuthorityTxHex || cleanAuthorityTxHex === '') {
      console.log(`[HIRING API:${requestId}] 🔍 authorityTxHex empty, fetching from blockchain...`);
      const authorityTxid = authorityUtxo.split(':')[0];
      cleanAuthorityTxHex = await fetchTransactionHex(authorityTxid);
      console.log(`[HIRING API:${requestId}] ✅ Fetched authority tx hex (length: ${cleanAuthorityTxHex.length})`);
    }
    
    console.log(`[HIRING API:${requestId}] ✅ Validation passed`);
    console.log(`[HIRING API:${requestId}] planMetadata.anchorUtxo: ${planMetadata.anchorUtxo.substring(0, 30)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Safely handle encryption entropy
    // ----------------------------------------------------------------------------
    const entropy: string = encryptionEntropy || process.env.DEFAULT_ENCRYPTION_ENTROPY || "";
    
    if (!entropy) {
      throw new Error("No encryption entropy source available. Wallet signature required.");
    }
    
    console.log(`[HIRING API:${requestId}] 🔐 Encryption entropy available (length: ${entropy.length})`);
    
    // ----------------------------------------------------------------------------
    // Step 3: Look up company to get treasury configuration (DYNAMIC - NO ENV HARDCODING)
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] 🔍 Looking up company for employer: ${employerAddress.substring(0, 20)}...`);
    
    const company = await getCompanyByEmployer(db, employerAddress);
    
    if (!company) {
      console.error(`[HIRING API:${requestId}] ❌ Company not found for employer: ${employerAddress}`);
      return res.status(404).json({ 
        error: 'Company not registered. Please complete company onboarding first.',
        employerAddress: employerAddress.substring(0, 20) + '...'
      });
    }
    
    // CRITICAL FIX: Use treasuryAddress from database, NOT hardcoded env var
    const treasuryAddress = company.treasuryAddress;
    const treasuryHexDest = company.treasuryHexDest;
    
    console.log(`[HIRING API:${requestId}] ✅ Company found`);
    console.log(`[HIRING API:${requestId}] Company treasuryAddress: ${treasuryAddress.substring(0, 30)}...`);
    console.log(`[HIRING API:${requestId}] Company treasuryHexDest: ${treasuryHexDest.substring(0, 30)}...`);
    
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
      
      // Get existing worker name to preserve it
      const existingName = await getExistingWorkerName(db, worker.address, planMetadata.appId);
      const workerName = existingName || worker.role;
      
      console.log(`[HIRING API:${requestId}]   Worker name: ${workerName} (${existingName ? 'existing' : 'new'})`);
      
      // Encrypt worker-specific data using wallet entropy (REAL SALARY is used here)
      const encryptedWorkerData = await encryptPayrollData({
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
      
      // =========================================================================
      // DERIVABLE MODEL: Mark as 'minting_pending' instead of 'active'
      // This tells the frontend that the transaction is in flight but not yet confirmed
      // The indexer will update this to 'active' when the transaction is confirmed on-chain
      // =========================================================================
      await saveWorkerRecord(
        db,
        worker.address,
        workerName,
        planMetadata.appId,
        planMetadata.scrollPolicy === 0 ? 0 : 1,
        'minting_pending',
        new Date().toISOString(),
        null,
        new Date(Date.now() + planMetadata.payPeriodSeconds * 1000).toISOString(),
        metadataHash,
        worker.salarySats,
        worker.role
      );
      
      console.log(`[HIRING API:${requestId}]   Worker status set to 'minting_pending'`);
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
    // Step 7: Calculate required satoshis for fee sponsorship
    // CRITICAL FIX: Increased buffer from 30000 to 50000 to cover higher fees
    // ----------------------------------------------------------------------------
    const requiredSats = estimateRequiredSats(workers.length, 50);  // 50% buffer
    console.log(`[HIRING API:${requestId}] Estimated required: ${requiredSats} sats (with 50000 buffer)`);
    
    // ----------------------------------------------------------------------------
    // Step 8: Dynamically select funding UTXO from company treasury (DYNAMIC ADDRESS)
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Selecting funding UTXO from treasury: ${treasuryAddress.substring(0, 30)}...`);
    
    const funding = await getDynamicFundingUtxo(
      db,
      treasuryAddress,  // ✅ DYNAMIC: Uses company.treasuryAddress from database
      requiredSats,
      employerAddress
    );
    
    console.log(`[HIRING API:${requestId}] Selected funding:`, {
      utxo: funding.utxoId,
      value: funding.value
    });
    
    // ----------------------------------------------------------------------------
    // Step 9: Fetch funding UTXO hex from the blockchain
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
    // Step 10: Calculate Scroll service fee
    // ----------------------------------------------------------------------------
    const scrollFee = calculateScrollFee(2, funding.value);
    console.log(`[HIRING API:${requestId}] 💳 Scroll Service Fee: ${scrollFee} sats`);
    
    // ----------------------------------------------------------------------------
    // Step 11: Prepare worker allocations for batchPayroll
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
    // Step 12: Create return metadata with placeholder compensationSats
    // ----------------------------------------------------------------------------
    const returnMetadata = {
      ...planMetadata,
      anchorUtxo: planMetadata.anchorUtxo,
      compensationSats: Math.max(planMetadata.compensationSats || 0, constants.MIN_OUTPUT_SATS || 1000)
    };
    
    console.log(`[HIRING API:${requestId}] Return metadata prepared:`, {
      appId: returnMetadata.appId.substring(0, 16) + '...',
      remaining: returnMetadata.remaining,
      compensationSats: returnMetadata.compensationSats,
      anchorUtxo: returnMetadata.anchorUtxo ? returnMetadata.anchorUtxo.substring(0, 30) + '...' : 'missing',
      isPlaceholder: returnMetadata.compensationSats === (constants.MIN_OUTPUT_SATS || 1000)
    });
    
    // ----------------------------------------------------------------------------
    // Step 13: Generate batch hiring transactions
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
      returnMetadataHasAnchorUtxo: !!returnMetadata.anchorUtxo,
      treasuryHexDest: treasuryHexDest.substring(0, 30) + '...',  // ✅ DYNAMIC: Uses company.treasuryHexDest from database
      utxoAddress: utxoAddress.substring(0, 20) + '...'
    });
    
    const result = await batchPayroll(
      authorityUtxo,
      workerAllocations,
      { utxo: funding.utxoId, value: funding.value },
      employerAddress,
      planMetadata.appId,
      employerAddress,
      returnMetadata,
      treasuryHexDest,  // ✅ DYNAMIC: Uses company.treasuryHexDest from database
      utxoAddress,
      undefined
    );
    
    console.log(`[HIRING API:${requestId}] ✅ Transactions generated`);
    
    // =========================================================================
    // DERIVABLE MODEL: Do NOT update workers with token UTXOs here
    // The transaction is not yet confirmed. The Indexer will handle activation.
    // Only update status to 'minting_pending' to show transaction is in mempool.
    // =========================================================================
    console.log(`[HIRING API:${requestId}] Workers in mempool - keeping status as 'minting_pending'...`);
    console.log(`[HIRING API:${requestId}] The Indexer will activate workers once transaction is confirmed.`);

    for (const worker of workers) {
        // Workers already have 'minting_pending' status from saveWorkerRecord above
        // No additional update needed - the Indexer will set to 'active' when confirmed
        console.log(`[HIRING API:${requestId}]   Worker ${worker.address.substring(0, 16)}... status remains 'minting_pending' (awaiting confirmation)`);
    }

    console.log(`[HIRING API:${requestId}] ✅ Workers remain in 'minting_pending' state. Awaiting block confirmation.`);
    
    // ----------------------------------------------------------------------------
    // Step 14: Return success response
    // FIX: Added fundingTxHex to response so frontend uses exact UTXO selected by backend
    // ----------------------------------------------------------------------------
    const response = {
      ...result,
      fundingUsed: funding.utxoId,
      fundingValue: funding.value,
      fundingTxHex: fundingTxHex,  // CRITICAL FIX: Return hex for frontend signing
      workerCount: workers.length,
      totalTokens,
      supplyRemaining: newRemainingSupply,
      scrollFee,
      sponsored: true,
      authorityUtxo: authorityUtxo,
      utxoVerification: { verified: true, unspent: true },
      workerMetadataHashes,
      requestId,
      returnMetadataCompensation: returnMetadata.compensationSats,
      treasuryAddressUsed: treasuryAddress.substring(0, 30) + '...',  // Log which treasury was used
      treasuryHexDestUsed: treasuryHexDest.substring(0, 30) + '...'   // Log which hex dest was used
    };
    
    console.log(`[HIRING API:${requestId}] ===== SUCCESS =====`);
    console.log(`  Workers: ${workers.length}`);
    console.log(`  Tokens: ${totalTokens}`);
    console.log(`  Remaining: ${newRemainingSupply}`);
    console.log(`  Return NFT compensationSats: ${returnMetadata.compensationSats}`);
    console.log(`  Return NFT anchorUtxo: ${returnMetadata.anchorUtxo ? returnMetadata.anchorUtxo.substring(0, 30) + '...' : 'missing'}`);
    console.log(`  Funding UTXO used: ${funding.utxoId} (${funding.value} sats)`);
    console.log(`  Funding TX hex returned: ${fundingTxHex ? fundingTxHex.substring(0, 30) + '...' : 'missing'}`);
    console.log(`  Treasury Address Used: ${treasuryAddress.substring(0, 30)}...`);
    console.log(`  Treasury Hex Dest Used: ${treasuryHexDest.substring(0, 30)}...`);
    console.log(`  Workers status: minting_pending (awaiting confirmation)`);
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
  
  // Get database from app locals
  const db = req.app.locals.db;
  
  console.log(`\n[HIRING API:${requestId}] ===== START batchHireWorkers =====`);
  
  try {
    const { 
      authorityUtxo,
      authorityTxHex,
      utxoAddress,
      workers,
      employerAddress,
      planMetadata,
      encryptionEntropy
    } = req.body;
    
    if (!authorityUtxo || !authorityTxHex || !utxoAddress || !workers || !employerAddress || !planMetadata) {
      throw new Error('Missing required fields: authorityUtxo, authorityTxHex, utxoAddress, workers, employerAddress, planMetadata');
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
    req.body.utxoAddress = utxoAddress;
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
    
    const requiredSats = estimateRequiredSats(workerCount, 50);
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