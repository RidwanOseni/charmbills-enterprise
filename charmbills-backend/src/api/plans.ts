import { Request, Response } from 'express';
import { Database } from 'sqlite3';
import { generateUnsignedTransactions } from '../charms/proverClient'; 
import { encryptPayrollData } from '@shared/encryption';
import { pinToIPFS } from '../lib/ipfs-pinner';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

const db = new (require('sqlite3').Database)(process.env.PAYROLL_DB_PATH || './payroll.db');

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface CreatePayrollPlanRequest {
  // Bitcoin UTXO data
  anchorUtxo: string;
  anchorTxHex: string;
  anchorValue: number;
  fundingUtxo: string;
  fundingValue: number;
  employerAddress: string;
  
  // Payroll configuration
  department: string;
  role: string;
  
  // Enforcement fields
  compensationSats: number;
  payPeriodSeconds: number;
  scrollPolicy: 0 | 1;
  
  // NEW PRODUCTION FIELDS
  encryptionEntropy: string; // From wallet signature [3]
  multiSigRequired?: boolean;
  multiSigSigners?: string[]; // Allows dynamic signer sets instead of .env [4]
}

interface PayrollPlanResponse extends ProverResult {
  ipfsCid: string;
  appId: string;
  metadataHash: string;
  department: string;
}

// --------------------------------------------------------------------------------
// Validation Functions
// --------------------------------------------------------------------------------

function validatePayrollPlanRequest(body: any): asserts body is CreatePayrollPlanRequest {
  const required = [
    'anchorUtxo', 'anchorTxHex', 'anchorValue',
    'fundingUtxo', 'fundingValue',
    'employerAddress',
    'department', 'role',
    'compensationSats', 'payPeriodSeconds', 'scrollPolicy',
    'encryptionEntropy' // ADDED: Required for non-custodial encryption
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
  
  if (typeof body.compensationSats !== 'number' || body.compensationSats < constants.MIN_OUTPUT_SATS) {
    throw new Error(`compensationSats must be a number >= ${constants.MIN_OUTPUT_SATS}`);
  }
  
  if (typeof body.payPeriodSeconds !== 'number' || body.payPeriodSeconds <= 0) {
    throw new Error('payPeriodSeconds must be a positive number');
  }
  
  if (![0, 1].includes(body.scrollPolicy)) {
    throw new Error('scrollPolicy must be 0 (Time) or 1 (Proof)');
  }
  
  // Validate hex strings
  if (!/^[0-9a-f]+$/i.test(body.anchorTxHex.replace(/\s/g, ''))) {
    throw new Error('anchorTxHex contains invalid hex characters');
  }
  
  // Validate UTXO format
  if (!/^[0-9a-f]+:\d+$/i.test(body.anchorUtxo)) {
    throw new Error('anchorUtxo must be in format "txid:vout"');
  }
  
  if (!/^[0-9a-f]+:\d+$/i.test(body.fundingUtxo)) {
    throw new Error('fundingUtxo must be in format "txid:vout"');
  }
  
  // Validate encryptionEntropy is a non-empty string
  if (typeof body.encryptionEntropy !== 'string' || body.encryptionEntropy.length === 0) {
    throw new Error('encryptionEntropy must be a non-empty string');
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
}

// --------------------------------------------------------------------------------
// Flexible Multi-sig Configuration
// --------------------------------------------------------------------------------

function getMultiSigConfig(multiSigRequired?: boolean, requestSigners?: string[]): {
  multiSigSigners?: string[];
  multiSigThreshold?: number;
} {
  if (!multiSigRequired) return {};

  // Prioritize dynamic signers passed in request for flexibility
  if (requestSigners && requestSigners.length >= 2) {
    return {
      multiSigSigners: requestSigners,
      multiSigThreshold: 2 // Standard 2-of-3 operational layer [5]
    };
  }

  // Fallback: Fetch from a central registry or specific organizational defaults
  // For now, ensure we aren't restricted to hardcoded .env variables
  throw new Error('Multi-sig signers must be specified for departmental plan creation.');
}

// --------------------------------------------------------------------------------
// Main API Handler - THIS IS WHAT INDEX.TS CALLS
// --------------------------------------------------------------------------------

/**
 * Creates a Departmental Plan NFT with Hybrid Metadata.
 * Endpoint: POST /api/plans/mint
 */
export async function createPayrollPlan(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[PLANS API:${requestId}] ===== START createPayrollPlan =====`);
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Validate request body
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] Validating request body...`);
    
    if (!req.body || Object.keys(req.body).length === 0) {
      console.error(`[PLANS API:${requestId}] ❌ Empty request body`);
      return res.status(400).json({ error: 'Request body is required' });
    }
    
    // Log sanitized request
    console.log(`[PLANS API:${requestId}] Request summary:`, {
      department: req.body.department,
      role: req.body.role,
      compensationSats: req.body.compensationSats,
      payPeriodSeconds: req.body.payPeriodSeconds,
      scrollPolicy: req.body.scrollPolicy,
      multiSigRequired: req.body.multiSigRequired,
      multiSigSignersCount: req.body.multiSigSigners?.length || 0,
      hasEncryptionEntropy: !!req.body.encryptionEntropy
    });
    
    // Validate required fields (now includes encryptionEntropy)
    validatePayrollPlanRequest(req.body);
    
    const {
      anchorUtxo,
      anchorTxHex,
      anchorValue,
      fundingUtxo,
      fundingValue,
      employerAddress,
      department,
      role,
      compensationSats,
      payPeriodSeconds,
      scrollPolicy,
      encryptionEntropy, // From wallet signature [3]
      multiSigRequired,
      multiSigSigners
    } = req.body;
    
    // Clean hex
    const cleanAnchorTxHex = anchorTxHex.replace(/\s/g, '');
    
    console.log(`[PLANS API:${requestId}] ✅ Validation passed`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Encrypt using wallet-provided entropy (Backend acts as a blind relay) [7]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔐 Encrypting payroll data with wallet entropy...`);
    
    // No environment key needed - using encryptionEntropy from wallet
    const encryptedBlob = encryptPayrollData({
      department,
      role,
      baseSalarySats: compensationSats,
      created: new Date().toISOString(),
      scrollPolicy,
      payPeriodSeconds,
      uiTemplate: scrollPolicy === 0 ? 'employee' : 'freelancer'
    }, encryptionEntropy); // Use entropy from signature instead of .env [3]
    
    console.log(`[PLANS API:${requestId}] ✅ Data encrypted with wallet entropy`);
    
    // ----------------------------------------------------------------------------
    // Step 3: Pin encrypted data to IPFS
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 📦 Pinning to IPFS...`);
    
    const { cid, metadataHash } = await pinToIPFS(encryptedBlob);
    
    console.log(`[PLANS API:${requestId}] ✅ IPFS pin successful`);
    console.log(`    CID: ${cid}`);
    console.log(`    Hash: ${metadataHash.substring(0, 16)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 4: Persist CID mapping so the indexer can find it later
    // ----------------------------------------------------------------------------
    await new Promise((resolve, reject) => {
      db.run(
        'INSERT OR IGNORE INTO ipfs_mappings (metadataHash, cid, createdAt) VALUES (?, ?, ?)',
        [metadataHash, cid, new Date().toISOString()],
        (err: Error | null) => err ? reject(err) : resolve(null)
      );
    });
    
    console.log(`[PLANS API:${requestId}] ✅ CID Mapping saved: ${metadataHash.substring(0, 16)}... -> ${cid}`);
    
    // ----------------------------------------------------------------------------
    // Step 5: Construct SpellRequest with flexible signers [4, 9]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔧 Building SpellRequest...`);
    
    const request: SpellRequest = {
      type: 'mint-nft',
      anchorUtxo,
      anchorValue,
      fundingUtxo,
      fundingUtxoValue: fundingValue,
      changeAddress: employerAddress,
      feeRate: constants.DEFAULT_FEE_RATE,
      outputs: [{
        address: employerAddress,
        nftMetadata: {
          ticker: constants.PAYROLL_NFT_TICKER,
          remaining: 1,
          metadataHash: metadataHash,
          scrollPolicy: scrollPolicy,
          payPeriodSeconds: payPeriodSeconds,
          compensationSats: compensationSats
        }
      }],
      ...getMultiSigConfig(multiSigRequired, multiSigSigners) // Uses dynamic signers
    };
    
    // ----------------------------------------------------------------------------
    // Step 6: Generate unsigned transactions via prover
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] ⏳ Calling proverClient...`);
    
    const result = await generateUnsignedTransactions(request, [cleanAnchorTxHex]);
    
    console.log(`[PLANS API:${requestId}] ✅ Transactions generated`);
    
    // ----------------------------------------------------------------------------
    // Step 7: Derive App ID
    // ----------------------------------------------------------------------------
    const appId = crypto.createHash('sha256').update(anchorUtxo).digest('hex');
    
    // ----------------------------------------------------------------------------
    // Step 8: Return success response
    // ----------------------------------------------------------------------------
    const response: PayrollPlanResponse = {
      ...result,
      ipfsCid: cid,
      appId,
      metadataHash,
      department
    };
    
    console.log(`[PLANS API:${requestId}] ✅ Success - App ID: ${appId.substring(0, 16)}...`);
    console.log(`[PLANS API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json(response);
    
  } catch (error: any) {
    console.error(`\n[PLANS API:${requestId}] ❌ ERROR =====`);
    console.error(`Error: ${error.message}`);
    console.error(`Stack: ${error.stack}`);
    console.error(`[PLANS API:${requestId}] ===== END =====\n`);
    
    let statusCode = 500;
    if (error.message.includes('Missing required') || error.message.includes('must be')) {
      statusCode = 400;
    } else if (error.message.includes('Prover')) {
      statusCode = 502;
    } else if (error.message.includes('IPFS')) {
      statusCode = 503;
    } else if (error.message.includes('Multi-sig signers must be specified')) {
      statusCode = 400;
    }
    
    return res.status(statusCode).json({
      error: error.message,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Plan Query API - Added for frontend dashboard
// --------------------------------------------------------------------------------

/**
 * Retrieves plans from the database, optionally filtered by department.
 * Endpoint: GET /api/plans
 */
export async function getPlans(req: Request, res: Response) {
    const { department } = req.query;
    const query = department ? 'SELECT * FROM plans WHERE ticker = ?' : 'SELECT * FROM plans';
    const params = department ? [department] : [];

    db.all(query, params, (err: Error | null, rows: any[]) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
}