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
  // Bitcoin UTXO data - ALL MUST COME FROM FRONTEND WALLET [1, 2]
  anchorUtxo: string;           // Selected by HR wallet
  anchorTxHex: string;          // The transaction hex containing the anchor UTXO
  anchorValue: number;          // Value of the anchor UTXO in sats
  fundingUtxo: string;          // Selected by HR wallet for fees
  fundingValue: number;         // Value of the funding UTXO in sats
  employerAddress: string;      // Where the Plan NFT will be sent
  
  // Payroll configuration
  department: string;
  role: string;
  
  // Enforcement fields
  compensationSats: number;
  payPeriodSeconds: number;
  scrollPolicy: 0 | 1;
  
  // PRODUCTION FIELDS - Non-custodial encryption [3, 4]
  encryptionEntropy: string;    // From wallet signature - NO .env key
  
  // Multi-sig support (optional)
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
// Validation Functions
// --------------------------------------------------------------------------------

function validatePayrollPlanRequest(body: any): asserts body is CreatePayrollPlanRequest {
  const required = [
    // Bitcoin UTXO data - MUST BE PROVIDED BY FRONTEND [1, 2]
    'anchorUtxo', 
    'anchorTxHex', 
    'anchorValue',
    'fundingUtxo', 
    'fundingValue',
    'employerAddress',
    
    // Payroll configuration
    'department', 
    'role',
    
    // Enforcement fields
    'compensationSats', 
    'payPeriodSeconds', 
    'scrollPolicy',
    
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
  
  // Validate encryptionEntropy is a non-empty string [3]
  if (typeof body.encryptionEntropy !== 'string' || body.encryptionEntropy.length === 0) {
    throw new Error('encryptionEntropy must be a non-empty string from wallet signature');
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
// Database Helper Functions
// --------------------------------------------------------------------------------

/**
 * Look up company by employer address
 */
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

/**
 * Save plan record with employer reference
 */
async function savePlanRecord(
  appId: string,
  planUtxo: string,
  employerAddress: string,
  department: string,
  role: string,
  compensationSats: number,
  payPeriodSeconds: number,
  metadataHash: string,
  scrollPolicy: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO plans (appId, nftUtxoId, ticker, employerAddress, department, role, compensationSats, payPeriodSeconds, metadataHash, scrollPolicy, createdAt, updatedAt) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        appId, 
        planUtxo, 
        constants.PAYROLL_NFT_TICKER, 
        employerAddress,
        department, 
        role, 
        compensationSats, 
        payPeriodSeconds, 
        metadataHash, 
        scrollPolicy, 
        new Date().toISOString(),
        new Date().toISOString()
      ],
      (err: Error | null) => err ? reject(err) : resolve()
    );
  });
}

// --------------------------------------------------------------------------------
// Flexible Multi-sig Configuration
// --------------------------------------------------------------------------------

function getMultiSigConfig(multiSigRequired?: boolean, requestSigners?: string[], requestThreshold?: number): {
  multiSigSigners?: string[];
  multiSigThreshold?: number;
} {
  if (!multiSigRequired) return {};

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
// Main API Handler - PRODUCTION VERSION
// --------------------------------------------------------------------------------

/**
 * Creates a Departmental Plan NFT with Hybrid Metadata.
 * Endpoint: POST /api/plans/mint
 * 
 * PRODUCTION CHANGES:
 * 1. All UTXOs come from frontend wallet selection, NOT .env [1, 2]
 * 2. Encryption uses wallet-provided entropy, NO .env key [3, 4]
 * 3. Multi-sig uses dynamic signers from request, NOT .env [5]
 * 4. Plan records are saved with employer reference [9]
 * 5. Company treasuryHexDest is fetched from database, NOT .env [16, 17, 18, 19]
 */
export async function createPayrollPlan(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
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
      fundingUtxo: req.body.fundingUtxo ? `${req.body.fundingUtxo.substring(0, 20)}...` : 'missing',
      employerAddress: req.body.employerAddress ? `${req.body.employerAddress.substring(0, 20)}...` : 'missing',
      department: req.body.department,
      role: req.body.role,
      compensationSats: req.body.compensationSats,
      payPeriodSeconds: req.body.payPeriodSeconds,
      scrollPolicy: req.body.scrollPolicy,
      multiSigRequired: req.body.multiSigRequired,
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
      employerAddress,
      department,
      role,
      compensationSats,
      payPeriodSeconds,
      scrollPolicy,
      encryptionEntropy,      // From wallet signature - NON-CUSTODIAL [3]
      multiSigRequired,
      multiSigSigners,
      multiSigThreshold
    } = req.body;
    
    // Clean hex - remove whitespace
    const cleanAnchorTxHex = anchorTxHex.replace(/\s/g, '');
    
    console.log(`[PLANS API:${requestId}] ✅ Validation passed`);
    
    // ----------------------------------------------------------------------------
    // Step 2: Look up company in database - NO .env fallback [16, 17]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔍 Looking up company for employer: ${employerAddress.substring(0, 20)}...`);
    
    const company = await getCompanyByEmployer(employerAddress);
    
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
    // Step 3: Encrypt using wallet-provided entropy (Backend acts as blind relay) [3, 4]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 🔐 Encrypting payroll data with wallet entropy...`);
    
    // No environment key - using encryptionEntropy from wallet signature
    const encryptedBlob = encryptPayrollData({
      department,
      role,
      employerAddress,
      baseSalarySats: compensationSats,
      created: new Date().toISOString(),
      scrollPolicy,
      payPeriodSeconds,
      uiTemplate: scrollPolicy === 0 ? 'employee' : 'freelancer'
    }, encryptionEntropy);
    
    console.log(`[PLANS API:${requestId}] ✅ Data encrypted with wallet entropy (non-custodial)`);
    
    // ----------------------------------------------------------------------------
    // Step 4: Pin encrypted data to IPFS [6, 7]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 📦 Pinning to IPFS...`);
    
    const { cid, metadataHash } = await pinToIPFS(encryptedBlob);
    
    console.log(`[PLANS API:${requestId}] ✅ IPFS pin successful`);
    console.log(`    CID: ${cid}`);
    console.log(`    Hash: ${metadataHash.substring(0, 16)}...`);
    
    // ----------------------------------------------------------------------------
    // Step 5: Persist CID mapping for indexer lookup [7]
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
    // Step 6: Construct SpellRequest with dynamic signers [4, 5, 8]
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
      ...getMultiSigConfig(multiSigRequired, multiSigSigners, multiSigThreshold)
    };
    
    // ----------------------------------------------------------------------------
    // Step 7: Generate unsigned transactions via prover [8]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] ⏳ Calling proverClient...`);
    
    const result = await generateUnsignedTransactions(
      request, 
      [cleanAnchorTxHex, fundingUtxo], // Both UTXOs from frontend
      undefined // appId not needed for mint-nft
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Transactions generated`);
    
    // ----------------------------------------------------------------------------
    // Step 8: Derive App ID from anchor UTXO
    // ----------------------------------------------------------------------------
    const appId = crypto.createHash('sha256').update(anchorUtxo).digest('hex');
    
    // ----------------------------------------------------------------------------
    // Step 9: Derive Plan NFT UTXO from spellTxHex [9]
    // ----------------------------------------------------------------------------
    const spellTx = require('bitcoinjs-lib').Transaction.fromHex(result.spellTxHex);
    const planUtxo = `${spellTx.getId()}:0`;
    
    // ----------------------------------------------------------------------------
    // Step 10: Save plan record with employer reference [9]
    // ----------------------------------------------------------------------------
    console.log(`[PLANS API:${requestId}] 💾 Saving plan record...`);
    
    await savePlanRecord(
      appId,
      planUtxo,
      employerAddress,
      department,
      role,
      compensationSats,
      payPeriodSeconds,
      metadataHash,
      scrollPolicy
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Plan record saved`);
    
    // ----------------------------------------------------------------------------
    // Step 11: Return success response
    // ----------------------------------------------------------------------------
    const response: PayrollPlanResponse = {
      commitTxHex: result.commitTxHex,
      spellTxHex: result.spellTxHex,
      ipfsCid: cid,
      appId,
      metadataHash,
      department
    };
    
    console.log(`[PLANS API:${requestId}] ✅ Success - App ID: ${appId.substring(0, 16)}...`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Plan UTXO: ${planUtxo}`);
    console.log(`[PLANS API:${requestId}] ✅ Success - Treasury Hex: ${company.treasuryHexDest.substring(0, 30)}...`);
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
// Plan Query API - For frontend dashboard [9]
// --------------------------------------------------------------------------------

/**
 * Retrieves plans from the database, optionally filtered by department or employer.
 * Endpoint: GET /api/plans
 */
export async function getPlans(req: Request, res: Response) {
  try {
    const { department, employerAddress, limit = '50', offset = '0' } = req.query;
    
    let query = 'SELECT * FROM plans WHERE 1=1';
    const params: any[] = [];
    
    if (department) {
      query += ' AND department = ?';
      params.push(department);
    }
    
    if (employerAddress) {
      query += ' AND employerAddress = ?';
      params.push(employerAddress);
    }
    
    query += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit as string), parseInt(offset as string));
    
    db.all(query, params, (err: Error | null, rows: any[]) => {
      if (err) {
        console.error('[PLANS API] Error fetching plans:', err);
        return res.status(500).json({ error: err.message });
      }
      
      // Sanitize response - remove any sensitive data
      const sanitizedRows = rows.map(row => ({
        appId: row.appId,
        nftUtxoId: row.nftUtxoId,
        ticker: row.ticker,
        employerAddress: row.employerAddress ? row.employerAddress.substring(0, 20) + '...' : null,
        department: row.department,
        role: row.role,
        compensationSats: row.compensationSats,
        payPeriodSeconds: row.payPeriodSeconds,
        metadataHash: row.metadataHash.substring(0, 16) + '...',
        scrollPolicy: row.scrollPolicy,
        createdAt: row.createdAt
      }));
      
      res.json(sanitizedRows);
    });
  } catch (error: any) {
    console.error('[PLANS API] Error in getPlans:', error);
    res.status(500).json({ error: error.message });
  }
}

// --------------------------------------------------------------------------------
// Plan Details API - Get single plan by appId
// --------------------------------------------------------------------------------

/**
 * Retrieves a single plan by its appId.
 * Endpoint: GET /api/plans/:appId
 */
export async function getPlanById(req: Request, res: Response) {
  try {
    const { appId } = req.params;
    
    if (!appId) {
      return res.status(400).json({ error: 'appId is required' });
    }
    
    db.get(
      'SELECT * FROM plans WHERE appId = ?',
      [appId],
      (err: Error | null, row: any) => {
        if (err) {
          console.error('[PLANS API] Error fetching plan:', err);
          return res.status(500).json({ error: err.message });
        }
        
        if (!row) {
          return res.status(404).json({ error: 'Plan not found' });
        }
        
        // Sanitize response
        const sanitizedRow = {
          appId: row.appId,
          nftUtxoId: row.nftUtxoId,
          ticker: row.ticker,
          employerAddress: row.employerAddress ? row.employerAddress.substring(0, 20) + '...' : null,
          department: row.department,
          role: row.role,
          compensationSats: row.compensationSats,
          payPeriodSeconds: row.payPeriodSeconds,
          metadataHash: row.metadataHash.substring(0, 16) + '...',
          scrollPolicy: row.scrollPolicy,
          createdAt: row.createdAt
        };
        
        res.json(sanitizedRow);
      }
    );
  } catch (error: any) {
    console.error('[PLANS API] Error in getPlanById:', error);
    res.status(500).json({ error: error.message });
  }
}