import { Request, Response } from 'express';
import { generateUnsignedTransactions } from '../charms/proverClient'; 
import { encryptPayrollData } from '@shared/encryption';
import { pinToIPFS } from '../lib/ipfs-pinner';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { syncIndexer } from '../lib/indexer';

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface CreatePayrollPlanRequest {
  // Bitcoin UTXO data - ALL MUST COME FROM FRONTEND WALLET [1, 2]
  anchorUtxo: string;           // Selected by HR wallet
  anchorTxHex: string;          // The transaction hex containing the anchor UTXO
  anchorValue: number;          // Value of the anchor UTXO in sats
  fundingUtxo: string;          // Selected by HR wallet for fees
  fundingValue: number;         // Value of the funding UTXO in sats
  fundingTxHex: string;         // Raw transaction hex for the funding UTXO (from frontend)
  fundingScript?: string;       // The actual on-chain scriptPubKey for the funding UTXO (for wallet signing)
  employerAddress: string;      // Where the Plan NFT will be sent
  utxoAddress: string;          // The Bitcoin address associated with the anchor UTXO (for app_private_inputs)
  
  // Payroll configuration (Unified Departmental NFT Model)
  department: string;            // Department name (e.g., "Engineering")
  
  // Enforcement fields (salary removed - now in encrypted IPFS per worker)
  payPeriodSeconds: number;      // Pay frequency (e.g., 1209600 for 2 weeks)
  scrollPolicy: 0 | 1;           // 0=Time-based, 1=Proof-based
  
  // Department budget (total pay periods this department can issue)
  remaining: number;             // Total pay periods budget (e.g., 100) [14]
  
  // PRODUCTION FIELDS - Non-custodial encryption [3, 4]
  encryptionEntropy: string;     // From wallet signature - NO .env key
  
  // Multi-sig support (optional) [5, 6]
  multiSigRequired?: boolean;
  multiSigSigners?: string[];
  multiSigThreshold?: number;
}

interface PayrollPlanResponse extends ProverResult {
  ipfsCid: string;
  appId: string;
  metadataHash: string;
  department: string;
}

interface CompanyRecord {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  createdAt: string;
  updatedAt?: string;
}

// --------------------------------------------------------------------------------
// Validation Functions - UPDATED for Unified Departmental NFT Model
// --------------------------------------------------------------------------------

function validatePayrollPlanRequest(body: any): asserts body is CreatePayrollPlanRequest {
  // Updated required fields - includes 'remaining' for department budget [14]
  // Also includes 'utxoAddress' for app_private_inputs conversion
  // Also includes 'fundingTxHex' for funding UTXO hex from frontend
  // CRITICAL: anchorTxHex is now REQUIRED - must be provided by frontend
  // NOTE: fundingScript is optional - not required for prover, but needed for wallet signing
  const required = [
    // Bitcoin UTXO data - MUST BE PROVIDED BY FRONTEND [1, 2]
    'anchorUtxo', 
    'anchorTxHex',              // MANDATORY - The transaction hex that created the anchor UTXO
    'anchorValue',
    'fundingUtxo', 
    'fundingValue',
    'fundingTxHex',             // MANDATORY - The transaction hex that created the funding UTXO
    'employerAddress',
    'utxoAddress',              // REQUIRED for app_private_inputs conversion
    
    // Payroll configuration (Unified Departmental Model)
    'department',
    
    // Enforcement fields (salary removed)
    'payPeriodSeconds', 
    'scrollPolicy',
    
    // Department budget
    'remaining',
    
    // Non-custodial encryption - REQUIRED, no .env fallback [3, 4]
    'encryptionEntropy'
  ];
  
  const missing = required.filter(field => {
    const value = body[field];
    return value === undefined || value === null || value === '';
  });
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
  // Validate types and ranges
  if (typeof body.anchorValue !== 'number' || body.anchorValue < constants.MIN_OUTPUT_SATS) {
    throw new Error(`anchorValue must be a number >= ${constants.MIN_OUTPUT_SATS}`);
  }
  
  if (typeof body.fundingValue !== 'number' || body.fundingValue < constants.MIN_OUTPUT_SATS) {
    throw new Error(`fundingValue must be a number >= ${constants.MIN_OUTPUT_SATS}`);
  }
  
  if (typeof body.payPeriodSeconds !== 'number' || body.payPeriodSeconds <= 0) {
    throw new Error('payPeriodSeconds must be a positive number');
  }
  
  if (![0, 1].includes(body.scrollPolicy)) {
    throw new Error('scrollPolicy must be 0 (Time) or 1 (Proof)');
  }
  
  // Validate remaining (department budget) [14]
  if (typeof body.remaining !== 'number' || body.remaining <= 0) {
    throw new Error('remaining must be a positive number (total pay periods budget)');
  }
  
  // Validate hex strings - BOTH anchor and funding hexes must be valid
  if (!/^[0-9a-f]+$/i.test(body.anchorTxHex.replace(/\s/g, ''))) {
    throw new Error('anchorTxHex contains invalid hex characters');
  }
  
  if (!/^[0-9a-f]+$/i.test(body.fundingTxHex.replace(/\s/g, ''))) {
    throw new Error('fundingTxHex contains invalid hex characters');
  }
  
  // Validate UTXO format
  if (!/^[0-9a-f]+:\d+$/i.test(body.anchorUtxo)) {
    throw new Error('anchorUtxo must be in format "txid:vout"');
  }
  
  if (!/^[0-9a-f]+:\d+$/i.test(body.fundingUtxo)) {
    throw new Error('fundingUtxo must be in format "txid:vout"');
  }
  
  // Validate utxoAddress format (basic Bech32 check)
  if (!body.utxoAddress.startsWith('tb1') && !body.utxoAddress.startsWith('bc1')) {
    throw new Error('utxoAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  // Validate encryptionEntropy is a non-empty string [3]
  if (typeof body.encryptionEntropy !== 'string' || body.encryptionEntropy.length === 0) {
    throw new Error('encryptionEntropy must be a non-empty string from wallet signature');
  }
  
  // Validate department is a non-empty string
  if (typeof body.department !== 'string' || body.department.trim().length === 0) {
    throw new Error('department must be a non-empty string');
  }
  
  // Validate multiSigSigners if provided
  if (body.multiSigSigners !== undefined) {
    if (!Array.isArray(body.multiSigSigners)) {
      throw new Error('multiSigSigners must be an array if provided');
    }
    if (body.multiSigSigners.length < 2) {
      throw new Error('multiSigSigners must contain at least 2 signers');
    }
  }
  
  // Validate multiSigThreshold if provided
  if (body.multiSigThreshold !== undefined) {
    if (typeof body.multiSigThreshold !== 'number' || body.multiSigThreshold < 1) {
      throw new Error('multiSigThreshold must be a positive number');
    }
    if (body.multiSigSigners && body.multiSigThreshold > body.multiSigSigners.length) {
      throw new Error('multiSigThreshold cannot exceed number of signers');
    }
  }
}

// --------------------------------------------------------------------------------
// Database Helper Functions (with db parameter)
// --------------------------------------------------------------------------------

/**
 * Look up company by employer address
 */
async function getCompanyByEmployer(db: any, employerAddress: string): Promise<CompanyRecord | null> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
  return result.rows[0] || null;
}

/**
 * Save plan record with employer reference - UPDATED for Unified Model
 * Now includes remaining field (department budget)
 * CRITICAL FIX: Added 'status' field set to 'pending' for derivable model tracking
 */
async function savePlanRecord(
  db: any,
  appId: string,
  planUtxo: string,
  anchorUtxo: string,
  employerAddress: string,
  department: string,
  payPeriodSeconds: number,
  remaining: number,
  metadataHash: string,
  scrollPolicy: number
): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[PLANS API] Saving plan record with status 'pending': ${appId.substring(0, 16)}...`);
  
  await db.execute({
    sql: `INSERT INTO plans (appId, nftUtxoId, anchorUtxo, ticker, employerAddress, department, payPeriodSeconds, remaining, metadataHash, scrollPolicy, status, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      appId, 
      planUtxo, 
      anchorUtxo,
      constants.PAYROLL_NFT_TICKER, 
      employerAddress,
      department, 
      payPeriodSeconds, 
      remaining,
      metadataHash, 
      scrollPolicy,
      'pending',                                    // 👈 ADDED: Initial status for derivable model
      now,
      now
    ]
  });
  
  console.log(`[PLANS API] ✅ Plan record saved with status 'pending'`);
}

// --------------------------------------------------------------------------------
// Flexible Multi-sig Configuration
// --------------------------------------------------------------------------------

function getMultiSigConfig(multiSigRequired?: boolean, requestSigners?: string[], requestThreshold?: number): {
  multiSigSigners?: string[];
  multiSigThreshold?: number;
} {
  // Default to false if not provided [5, 6]
  const isMultiSigRequired = multiSigRequired === true;
  
  if (!isMultiSigRequired) return {};

  // Prioritize dynamic signers passed in request for flexibility [4, 5]
  if (requestSigners && requestSigners.length >= 2) {
    return {
      multiSigSigners: requestSigners,
      multiSigThreshold: requestThreshold || 2 // Default to 2-of-M
    };
  }

  // No fallback to .env - production requires explicit signers
  throw new Error('Multi-sig signers must be specified for departmental plan creation when multiSigRequired is true');
}

// --------------------------------------------------------------------------------
// Main API Handler - PRODUCTION VERSION (Unified Departmental NFT Model)
// --------------------------------------------------------------------------------

/**
 * Creates a Departmental Plan NFT with Hybrid Metadata.
 * Endpoint: POST /api/plans/mint
 * 
 * UNIFIED DEPARTMENTAL NFT MODEL:
 * 1. One NFT per department (e.g., "Engineering")
 * 2. No salary or role in on-chain enforcement
 * 3. Salary enforcement moved to Scroll Settlement Layer
 * 4. Individual worker salaries stored in encrypted IPFS
 * 5. Department budget (remaining) sets total available pay periods [14]
 * 
 * PRODUCTION CHANGES:
 * 1. All UTXOs come from frontend wallet selection, NOT .env [1, 2]
 * 2. Encryption uses wallet-provided entropy, NO .env key [3, 4]
 * 3. Multi-sig uses dynamic signers from request, NOT .env [5]
 * 4. Plan records are saved with employer reference [9]
 * 5. Company treasuryHexDest is fetched from database, NOT .env [16, 17, 18, 19]
 * 6. REMOVED role and compensationSats from validation and record saving
 * 7. ADDED remaining field for department budget [14]
 * 8. USE fundingTxHex directly from frontend (no blockchain fetch) [22]
 * 9. ADDED utxoAddress field for app_private_inputs conversion
 * 10. CRITICAL FIX: BOTH anchorTxHex AND fundingTxHex are now passed to prover
 * 11. ADDED fundingScript to accept the actual on-chain script for wallet signing
 * 12. CRITICAL FIX: Collapsed Model - passes same UTXO for both anchor and fee when equal
 * 13. CRITICAL FIX: Deduplicate prev_txs hexes when anchor and funding UTXOs are the same
 */
export async function createPayrollPlan(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const db = req.app.locals.db;
  
  console.log(`\n[PLANS API:${requestId}] ===== START createPayrollPlan =====`);
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Validate request body - ALL FIELDS MUST COME FROM FRONTEND [1, 2]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] Validating request body...`);
    
    if (!req.body || Object.keys(req.body).length === 0) {
      console.error(`[PLANS API:${requestId}] ❌ Empty request body`);
      return res.status(400).json({ error: 'Request body is required' });
    }
    
    // Log sanitized request (no sensitive data)
    console.log(`[PLANS API:${requestId}] Request summary:`, {
      anchorUtxo: req.body.anchorUtxo ? `${req.body.anchorUtxo.substring(0, 20)}...` : 'missing',
      hasAnchorTxHex: !!req.body.anchorTxHex,
      anchorTxHexLength: req.body.anchorTxHex?.length || 0,
      fundingUtxo: req.body.fundingUtxo ? `${req.body.fundingUtxo.substring(0, 20)}...` : 'missing',
      hasFundingTxHex: !!req.body.fundingTxHex,
      fundingTxHexLength: req.body.fundingTxHex?.length || 0,
      hasFundingScript: !!req.body.fundingScript,
      fundingScriptLength: req.body.fundingScript?.length || 0,
      employerAddress: req.body.employerAddress ? `${req.body.employerAddress.substring(0, 20)}...` : 'missing',
      utxoAddress: req.body.utxoAddress ? `${req.body.utxoAddress.substring(0, 20)}...` : 'missing',
      department: req.body.department,
      remaining: req.body.remaining,
      payPeriodSeconds: req.body.payPeriodSeconds,
      scrollPolicy: req.body.scrollPolicy,
      multiSigRequired: req.body.multiSigRequired || false,
      multiSigSignersCount: req.body.multiSigSigners?.length || 0,
      hasEncryptionEntropy: !!req.body.encryptionEntropy
    });
    
    // Validate all required fields (no .env fallbacks)
    validatePayrollPlanRequest(req.body);
    
    const {
      anchorUtxo,
      anchorTxHex,
      anchorValue,
      fundingUtxo,
      fundingValue,
      fundingTxHex,
      fundingScript,           // Optional - actual on-chain script for wallet signing
      employerAddress,
      utxoAddress,             // Address associated with anchor UTXO
      department,
      payPeriodSeconds,
      scrollPolicy,
      remaining,               // Department budget [14]
      encryptionEntropy,       // From wallet signature - NON-CUSTODIAL [3]
      multiSigRequired,
      multiSigSigners,
      multiSigThreshold
    } = req.body;
    
    // Clean hex - remove whitespace
    const cleanAnchorTxHex = anchorTxHex.replace(/\s/g, '');
    const cleanFundingTxHex = fundingTxHex.replace(/\s/g, '');
    
    // DEBUG: Log hex lengths to verify both are present
    console.log(`[PLANS API:${requestId}] ✅ Validation passed`);
    console.log(`[PLANS API:${requestId}] Anchor hex length: ${cleanAnchorTxHex.length} chars`);
    console.log(`[PLANS API:${requestId}] Funding hex length: ${cleanFundingTxHex.length} chars`);
    if (fundingScript) {
      console.log(`[PLANS API:${requestId}] Funding script provided (length: ${fundingScript.length} chars)`);
    } else {
      console.log(`[PLANS API:${requestId}] ⚠️ No fundingScript provided - wallet may fail to sign Input 1`);
    }
    console.log(`[PLANS API:${requestId}] Department budget: ${remaining} pay periods`);
    console.log(`[PLANS API:${requestId}] utxoAddress: ${utxoAddress.substring(0, 20)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Look up company in database - NO .env fallback [16, 17]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔍 Looking up company for employer: ${employerAddress.substring(0, 20)}...`);
    
    const company = await getCompanyByEmployer(db, employerAddress);
    
    if (!company) {
      console.error(`[PLANS API:${requestId}] ❌ Company not found for employer: ${employerAddress}`);
      return res.status(404).json({ 
        error: 'Company not registered. Please complete company onboarding first.',
        employerAddress: employerAddress.substring(0, 20) + '...'
      });
    }
    
    console.log(`[PLANS API:${requestId}] ✅ Company found:`, {
      treasuryHexDest: company.treasuryHexDest.substring(0, 30) + '...',
      treasuryAddress: company.treasuryAddress.substring(0, 20) + '...'
    });
    
    // ----------------------------------------------------------------------------
    // Step 3: Use funding UTXO hex directly from frontend
    // CRITICAL: Frontend provides the full hex, no need to fetch from blockchain [22]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] ✅ Using funding UTXO hex from frontend (length: ${cleanFundingTxHex.length} chars)`);
    
    // ----------------------------------------------------------------------------
    // Step 4: Encrypt using wallet-provided entropy (Backend acts as blind relay) [3, 4]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔐 Encrypting payroll data with wallet entropy...`);
    
    // No environment key - using encryptionEntropy from wallet signature
    // NOTE: No salary or role in department-level metadata
    const encryptedBlob = await encryptPayrollData({
      department,
      remaining,           // Include budget in encrypted metadata
      created: new Date().toISOString(),
      scrollPolicy,
      payPeriodSeconds,
      uiTemplate: scrollPolicy === 0 ? 'employee' : 'freelancer'
    }, encryptionEntropy);
    
    console.log(`[PLANS API:${requestId}] ✅ Data encrypted with wallet entropy (non-custodial)`);
    
    // ----------------------------------------------------------------------------
    // Step 5: Pin encrypted data to IPFS [6, 7]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 📦 Pinning to IPFS...`);
    
    const { cid, metadataHash } = await pinToIPFS(encryptedBlob);
    
    console.log(`[PLANS API:${requestId}] ✅ IPFS pin successful`);
    console.log(`    CID: ${cid}`);
    console.log(`    Hash: ${metadataHash.substring(0, 16)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 6: Persist CID mapping for indexer lookup [7]
    // ----------------------------------------------------------------------------
    await db.execute({
      sql: 'INSERT OR IGNORE INTO ipfs_mappings (metadataHash, cid, createdAt) VALUES (?, ?, ?)',
      args: [metadataHash, cid, new Date().toISOString()]
    });
    
    console.log(`[PLANS API:${requestId}] ✅ CID Mapping saved: ${metadataHash.substring(0, 16)}... -> ${cid}`);
    
    // ----------------------------------------------------------------------------
    // Step 7: Construct SpellRequest with dynamic signers [4, 5, 8]
    // NOTE: Pass remaining as the budget [14], compensationSats = 0 for Unified Model [15]
    // CRITICAL: Include utxoAddress for app_private_inputs conversion
    // CRITICAL: Include fundingScript if provided (for wallet signing context)
    // CRITICAL FIX: Collapsed Model - pass the same UTXO for both anchor and fee when equal
    // This satisfies the Type System while telling the Prover that the source of authority
    // and the source of fees are the same UTXO, enabling single-input transaction for v14 scanner
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔧 Building SpellRequest...`);
    
    // CRITICAL DEDUPLICATION: Check if anchor and funding UTXOs are the same
    const isCollapsed = anchorUtxo === fundingUtxo;
    console.log(`[PLANS API:${requestId}] Input deduplication check: anchorUtxo === fundingUtxo? ${isCollapsed}`);
    
    if (isCollapsed) {
      console.log(`[PLANS API:${requestId}] 🚀 Collapsed Model detected - using single UTXO for both anchor and fee`);
      console.log(`[PLANS API:${requestId}] This reduces transaction to single input for v14 NFT Scanner compatibility`);
    }
    
    // CRITICAL FIX: Pass the variables directly. If isCollapsed is true,
    // they already contain the same UTXO ID and Value.
    // This satisfies the 'string' and 'number' type requirements.
    const spellRequest: SpellRequest = {
      type: 'mint-nft',
      anchorUtxo: anchorUtxo,
      anchorValue: anchorValue,
      // FIX: Pass the variables directly. If isCollapsed is true,
      // they already contain the same UTXO ID and Value.
      // This satisfies the 'string' and 'number' type requirements.
      fundingUtxo: fundingUtxo,
      fundingUtxoValue: fundingValue,
      changeAddress: employerAddress,
      utxoAddress: utxoAddress,      // REQUIRED: Address for app_private_inputs conversion
      feeRate: constants.DEFAULT_FEE_RATE,
      fundingScript: fundingScript,   // Pass through the actual fee script for wallet signing
      outputs: [{
        address: employerAddress,
        nftMetadata: {
          ticker: `${department.toUpperCase()}-PAY`, // Department-based ticker
          remaining: remaining,                      // Department budget [14]
          metadataHash: metadataHash,
          scrollPolicy: scrollPolicy,
          payPeriodSeconds: payPeriodSeconds,
          compensationSats: 0                        // Explicitly 0 for Unified Model [15]
        }
      }],
      ...getMultiSigConfig(multiSigRequired, multiSigSigners, multiSigThreshold)
    };
    
    console.log(`[PLANS API:${requestId}] SpellRequest constructed with fundingUtxo: ${spellRequest.fundingUtxo ? spellRequest.fundingUtxo.substring(0, 20) + '...' : 'undefined'}`);
    console.log(`[PLANS API:${requestId}] Collapsed mode: anchorUtxo === fundingUtxo? ${anchorUtxo === fundingUtxo}`);
    
    // ----------------------------------------------------------------------------
    // Step 8: Generate unsigned transactions via prover
    // CRITICAL FIX: DEDUPLICATE prev_txs hexes when anchor and funding UTXOs are the same
    // Pass only the unique hexes needed for context to avoid duplicate context
    // The prover's collapsed model deduplication will handle the rest
    // =========================================================================
    // FRIEND'S FIX: Build the context array for the Prover
    // If collapsed, we pass only 1 hex. If separate, we pass 2.
    // This creates the single-input architecture the v12 Scanner requires [Source 144]
    // =========================================================================
    console.log(`[PLANS API:${requestId}] ⏳ Calling proverClient...`);
    
    // 1. Detect if we are in "Collapsed Model" (Same UTXO for authority and gas)
    console.log(`[PLANS API:${requestId}] Collapsed Model detection: anchorUtxo === fundingUtxo? ${anchorUtxo === fundingUtxo}`);
    
    // 2. Build the context array for the Prover
    // If collapsed, we pass only 1 hex. If separate, we pass 2.
    const contextHexes = isCollapsed 
      ? [cleanAnchorTxHex] 
      : [cleanAnchorTxHex, cleanFundingTxHex];
    
    console.log(`[PLANS API:${requestId}] Context hexes count: ${contextHexes.length}`);
    console.log(`[PLANS API:${requestId}] Context hexes details:`, contextHexes.map((hex, i) => ({
      index: i,
      length: hex.length,
      prefix: hex.substring(0, 30) + '...'
    })));
    
    // 3. Call the newly unlocked prover with the deduplicated context array
    const result = await generateUnsignedTransactions(
      spellRequest, 
      contextHexes,                               // Pass the deduplicated array (length 1 or 2)
      company.treasuryHexDest,                   // Pass treasuryHexDest from company lookup
      undefined,                                 // appId not needed for mint-nft
      utxoAddress                                // Pass utxoAddress for app_private_inputs conversion
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Transactions generated`);
    
    // ----------------------------------------------------------------------------
    // Step 9: Derive App ID from anchor UTXO
    // ----------------------------------------------------------------------------
    const appId = crypto.createHash('sha256').update(anchorUtxo).digest('hex');
    
    // ----------------------------------------------------------------------------
    // Step 10: Derive Plan NFT UTXO from spellTxHex [9]
    // ----------------------------------------------------------------------------
    const spellTx = bitcoin.Transaction.fromHex(result.spellTxHex);
    const planUtxo = `${spellTx.getId()}:0`;
    
    // ----------------------------------------------------------------------------
    // Step 11: Save plan record with employer reference [9] - UPDATED with status 'pending'
    // CRITICAL FIX: Initial status is set to 'pending' for derivable model tracking
    // The indexer will update this to 'active' when the transaction is confirmed on-chain
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 💾 Saving plan record with status 'pending'...`);
    
    await savePlanRecord(
      db,
      appId,
      planUtxo,
      anchorUtxo,
      employerAddress,
      department,
      payPeriodSeconds,
      remaining,
      metadataHash,
      scrollPolicy
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Plan record saved with budget: ${remaining} and status: pending`);
    
    // ----------------------------------------------------------------------------
    // Step 12: Return success response
    // ----------------------------------------------------------------------------
    const response: PayrollPlanResponse = {
      commitTxHex: result.commitTxHex,
      spellTxHex: result.spellTxHex,
      isSingle: result.isSingle,
      ipfsCid: cid,
      appId,
      metadataHash,
      department
    };
    
    console.log(`[PLANS API:${requestId}] ✅ Success - isSingle: ${result.isSingle}`);
    console.log(`[PLANS API:${requestId}] ✅ Success - App ID: ${appId.substring(0, 16)}...`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Plan UTXO: ${planUtxo}`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Department: ${department}`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Budget: ${remaining} pay periods`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Treasury Hex: ${company.treasuryHexDest.substring(0, 30)}...`);
    console.log(`[PLANS API:${requestId}] ✅ Success - utxoAddress: ${utxoAddress.substring(0, 20)}...`);
    console.log(`[PLANS API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json(response);
    
  } catch (error: any) {
    console.error(`\n[PLANS API:${requestId}] ❌ ERROR =====`);
    console.error(`Error: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.error(`[PLANS API:${requestId}] ===== END =====\n`);
    
    // Determine appropriate status code
    let statusCode = 500;
    if (error.message.includes('Missing required') || 
        error.message.includes('must be') ||
        error.message.includes('Multi-sig signers must be specified')) {
      statusCode = 400;
    } else if (error.message.includes('Company not registered')) {
      statusCode = 404;
    } else if (error.message.includes('Prover')) {
      statusCode = 502;
    } else if (error.message.includes('IPFS')) {
      statusCode = 503;
    }
    
    return res.status(statusCode).json({
      error: error.message,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Plan Query API - For frontend dashboard [9] - UPDATED WITH NON-BLOCKING SYNC
// --------------------------------------------------------------------------------

/**
 * Retrieves plans from the database, optionally filtered by department or employer.
 * Endpoint: GET /api/plans
 * 
 * CRITICAL FIX: Non-blocking background sync - removed 'await' to return data instantly
 * The indexer runs in background without blocking the HTTP response
 */
export async function getPlans(req: Request, res: Response) {
  const db = req.app.locals.db;
  
  try {
    // CRITICAL FIX: Remove await - trigger indexer sync in background (non-blocking)
    // This allows the API to return cached database data immediately
    // while the indexer updates the blockchain state in the background
    console.log('[PLANS API] Triggering background indexer sync (non-blocking)...');
    syncIndexer(db, 10).catch(err => {
      console.error('[PLANS API] Background indexer sync failed:', err);
    });
    
    const { department, employerAddress, limit = '50', offset = '0' } = req.query;
    
    let sql = 'SELECT appId, nftUtxoId, anchorUtxo, ticker, employerAddress, department, payPeriodSeconds, remaining, metadataHash, scrollPolicy, createdAt FROM plans WHERE 1=1';
    const args: any[] = [];
    
    if (department) {
      sql += ' AND department = ?';
      args.push(department);
    }
    
    if (employerAddress) {
      sql += ' AND employerAddress = ?';
      args.push(employerAddress);
    }
    
    sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    args.push(parseInt(limit as string), parseInt(offset as string));
    
    const result = await db.execute({ sql, args });
    const rows = result.rows || [];
    
    // Return full data including anchorUtxo (required for mint-token witness)
    const rowsWithAnchor = rows.map((row: any) => ({
      appId: row.appId,
      nftUtxoId: row.nftUtxoId,
      anchorUtxo: row.anchorUtxo,
      ticker: row.ticker,
      employerAddress: row.employerAddress,
      department: row.department,
      payPeriodSeconds: row.payPeriodSeconds,
      remaining: row.remaining,
      metadataHash: row.metadataHash,
      scrollPolicy: row.scrollPolicy,
      createdAt: row.createdAt
    }));
    
    console.log(`[PLANS API] Returning ${rowsWithAnchor.length} plans (cached data)`);
    res.json(rowsWithAnchor);
  } catch (error: any) {
    console.error('[PLANS API] Error in getPlans:', error);
    res.status(500).json({ error: error.message });
  }
}

// --------------------------------------------------------------------------------
// Plan Details API - Get single plan by appId - UPDATED WITH NON-BLOCKING SYNC
// --------------------------------------------------------------------------------

/**
 * Retrieves a single plan by its appId.
 * Endpoint: GET /api/plans/:appId
 * 
 * CRITICAL FIX: Non-blocking background sync - removed 'await' to return data instantly
 * The indexer runs in background without blocking the HTTP response
 */
export async function getPlanById(req: Request, res: Response) {
  const db = req.app.locals.db;
  
  try {
    // CRITICAL FIX: Remove await - trigger indexer sync in background (non-blocking)
    console.log('[PLANS API] Triggering background indexer sync for single plan (non-blocking)...');
    syncIndexer(db, 10).catch(err => {
      console.error('[PLANS API] Background indexer sync failed:', err);
    });
    
    const { appId } = req.params;
    
    if (!appId) {
      return res.status(400).json({ error: 'appId is required' });
    }
    
    const result = await db.execute({
      sql: 'SELECT appId, nftUtxoId, anchorUtxo, ticker, employerAddress, department, payPeriodSeconds, remaining, metadataHash, scrollPolicy, createdAt FROM plans WHERE appId = ?',
      args: [appId]
    });
    
    const row = result.rows[0];
    
    if (!row) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    // Return full data including anchorUtxo (required for mint-token witness)
    const rowWithAnchor = {
      appId: row.appId,
      nftUtxoId: row.nftUtxoId,
      anchorUtxo: row.anchorUtxo,
      ticker: row.ticker,
      employerAddress: row.employerAddress,
      department: row.department,
      payPeriodSeconds: row.payPeriodSeconds,
      remaining: row.remaining,
      metadataHash: row.metadataHash,
      scrollPolicy: row.scrollPolicy,
      createdAt: row.createdAt
    };
    
    console.log(`[PLANS API] Returning plan ${appId.substring(0, 16)}... (cached data)`);
    res.json(rowWithAnchor);
  } catch (error: any) {
    console.error('[PLANS API] Error in getPlanById:', error);
    res.status(500).json({ error: error.message });
  }
}