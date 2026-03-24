import { Request, Response } from 'express';
import { generateUnsignedTransactions } from '../charms/proverClient';
import { batchPayroll } from '../charms/proverClient';
import { getDynamicFundingUtxo, estimateRequiredSats } from '../lib/utxo-manager';
import { SpellRequest, ProverResult } from '@shared/types';
import { calculateScrollFee } from '../lib/charms-utils';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface WorkerAllocation {
  address: string;
  periods: number;  // Number of pay periods to allocate (1 token = 1 period)
}

interface MintPayrollTokenRequest {
  authorityUtxo: string;      // Plan NFT UTXO from frontend scanner [1]
  authorityTxHex: string;     // Plan NFT creation tx hex (for provenance)
  workers: WorkerAllocation[]; // Array of workers with their allocations
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
    'planMetadata'
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
  
  // Validate each worker
  body.workers.forEach((w: any, i: number) => {
    if (!w.address || typeof w.address !== 'string') {
      throw new Error(`Worker ${i}: address is required`);
    }
    if (w.periods !== undefined && (typeof w.periods !== 'number' || w.periods <= 0)) {
      throw new Error(`Worker ${i}: periods must be a positive number if provided`);
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
}

// --------------------------------------------------------------------------------
// Main API Handler - PRODUCTION VERSION
// --------------------------------------------------------------------------------

/**
 * Endpoint to hire workers (mint payroll tokens) with dynamic UTXO selection
 * POST /api/subscriptions/mint
 * 
 * PRODUCTION CHANGES:
 * 1. authorityUtxo comes from frontend scanner, NOT .env [1]
 * 2. Batch proving creates M tokens and returns 1 NFT to employer [10, 14]
 * 3. Dynamic funding selection for gas sponsorship [13]
 * 4. Uses batchPayroll helper for 1:M:N scaling [14]
 */
export async function mintPayrollToken(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START mintPayrollToken =====`);
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Validate request body - authorityUtxo MUST come from frontend [1]
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
      appId: req.body.planMetadata?.appId ? `${req.body.planMetadata.appId.substring(0, 16)}...` : 'missing'
    });
    
    // Validate all required fields
    validateMintRequest(req.body);
    
    const { 
      authorityUtxo,      // Plan NFT UTXO from frontend scanner [1]
      authorityTxHex,     // Plan NFT creation tx hex (for provenance)
      workers,            // Array of worker allocations
      employerAddress,    // Where to return the Plan NFT
      planMetadata        // Plan NFT metadata (passed from frontend)
    } = req.body;
    
    // Clean hex
    const cleanAuthorityTxHex = authorityTxHex.replace(/\s/g, '');
    
    console.log(`[HIRING API:${requestId}] ✅ Validation passed`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Calculate total tokens being minted
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
    // Step 3: Get treasury address from environment
    // ----------------------------------------------------------------------------
    const treasuryAddress = process.env.PAYROLL_TREASURY_ADDRESS;
    if (!treasuryAddress) {
      throw new Error('PAYROLL_TREASURY_ADDRESS not set in environment');
    }
    
    // ----------------------------------------------------------------------------
    // Step 4: Calculate required satoshis for fee sponsorship [13]
    // ----------------------------------------------------------------------------
    const requiredSats = estimateRequiredSats(workers.length);
    console.log(`[HIRING API:${requestId}] Estimated required: ${requiredSats} sats`);
    
    // ----------------------------------------------------------------------------
    // Step 5: Dynamically select funding UTXO from treasury [13]
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Selecting funding UTXO...`);
    const funding = await getDynamicFundingUtxo(treasuryAddress, requiredSats);
    
    console.log(`[HIRING API:${requestId}] Selected funding:`, {
      utxo: funding.utxoId,
      value: funding.value,
      hexLength: funding.hex.length
    });
    
    // ----------------------------------------------------------------------------
    // Step 6: Calculate Scroll service fee (ENTERPRISE ADDITION)
    // ----------------------------------------------------------------------------
    const totalSatsSpent = funding.value;
    const numInputs = 2; // Authority UTXO + Funding UTXO
    const scrollFee = calculateScrollFee(numInputs, totalSatsSpent);
    
    console.log(`[HIRING API:${requestId}] 💳 Calculated Scroll Service Fee: ${scrollFee} sats`);
    
    // ----------------------------------------------------------------------------
    // Step 7: Prepare worker allocations for batchPayroll
    // ----------------------------------------------------------------------------
    const workerAllocations = workers.map(w => ({
      address: w.address,
      amount: w.periods || 1  // Default 1 token = 1 pay period
    }));
    
    console.log(`[HIRING API:${requestId}] Worker allocations:`, {
      count: workerAllocations.length,
      totalTokens: workerAllocations.reduce((sum, w) => sum + w.amount, 0)
    });
    
    // ----------------------------------------------------------------------------
    // Step 8: Generate batch hiring transactions via batchPayroll [10, 14]
    // This creates M worker tokens and returns 1 NFT to employer
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Calling batchPayroll (1:M:N scaling)...`);
    
    const result: ProverResult = await batchPayroll(
      authorityUtxo,                                      // Plan NFT UTXO [1]
      workerAllocations,                                  // M workers with their token amounts
      { utxo: funding.utxoId, value: funding.value },    // Dynamic funding UTXO [13]
      employerAddress,                                    // Where to return the Plan NFT
      planMetadata.appId,                                 // App ID from plan metadata
      undefined                                           // Multi-sig signers (optional)
    );
    
    console.log(`[HIRING API:${requestId}] ✅ Transactions generated via batchPayroll`);
    
    // ----------------------------------------------------------------------------
    // Step 9: Return success response with fee information
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
      requestId
    };
    
    console.log(`[HIRING API:${requestId}] ===== SUCCESS =====`);
    console.log(`  Commit Tx: ${result.commitTxHex.substring(0, 40)}...`);
    console.log(`  Spell Tx:  ${result.spellTxHex.substring(0, 40)}...`);
    console.log(`  Workers:   ${workers.length}`);
    console.log(`  Tokens:    ${totalTokens}`);
    console.log(`  Remaining: ${newRemainingSupply}`);
    console.log(`[HIRING API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json(response);

  } catch (error: any) {
    console.error(`\n[HIRING API:${requestId}] ❌ ERROR =====`);
    console.error(`Error: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.error(`[HIRING API:${requestId}] ===== END =====\n`);
    
    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('Missing') || 
        error.message.includes('must be') ||
        error.message.includes('Insufficient supply')) {
      statusCode = 400;
    } else if (error.message.includes('Prover') || error.message.includes('generate')) {
      statusCode = 502;
    } else if (error.message.includes('funding') || error.message.includes('UTXO')) {
      statusCode = 503;
    }
    
    return res.status(statusCode).json({
      error: error.message,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Batch Hire API - For hiring multiple workers in one transaction
// --------------------------------------------------------------------------------

/**
 * Endpoint to batch hire multiple workers
 * POST /api/subscriptions/batch-hire
 */
export async function batchHireWorkers(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START batchHireWorkers =====`);
  
  try {
    const { 
      authorityUtxo,      // Plan NFT UTXO from frontend scanner
      authorityTxHex,     // Plan NFT creation tx hex
      workers,            // Array of worker addresses (each gets 1 token)
      employerAddress,    // Where to return the Plan NFT
      planMetadata        // Plan NFT metadata
    } = req.body;
    
    // Validate
    if (!authorityUtxo || !authorityTxHex || !workers || !employerAddress || !planMetadata) {
      throw new Error('Missing required fields');
    }
    
    if (!Array.isArray(workers) || workers.length === 0) {
      throw new Error('workers must be a non-empty array');
    }
    
    // Convert simple addresses to allocations with 1 token each
    const allocations = workers.map((address: string) => ({
      address,
      amount: 1
    }));
    
    // Delegate to main mint function
    req.body.workers = allocations;
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
// Get Hiring Quote API - Estimate fees before hiring
// --------------------------------------------------------------------------------

/**
 * Endpoint to get a quote for hiring workers
 * POST /api/subscriptions/quote
 */
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
    
    // Calculate estimated fees
    const requiredSats = estimateRequiredSats(workerCount);
    const scrollFee = calculateScrollFee(2, requiredSats); // 2 inputs: authority + funding
    
    // Calculate supply impact
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