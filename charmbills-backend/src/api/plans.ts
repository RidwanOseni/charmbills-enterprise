import { Request, Response } from 'express';
import { generateUnsignedTransactions } from '../charms/proverClient'; 
import { encryptPayrollData } from '@shared/encryption';
import { pinToIPFS } from '../lib/ipfs-pinner';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';
import { syncIndexer } from '../lib/indexer';

interface CreatePayrollPlanRequest {
  anchorUtxo: string;
  anchorTxHex: string;
  anchorValue: number;
  fundingUtxo: string;
  fundingValue: number;
  fundingTxHex: string;
  fundingScript?: string;
  employerAddress: string;
  utxoAddress: string;
  department: string;
  payPeriodSeconds: number;
  scrollPolicy: 0 | 1;
  remaining: number;
  encryptionEntropy: string;
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

function validatePayrollPlanRequest(body: any): asserts body is CreatePayrollPlanRequest {
  const required = [
    'anchorUtxo', 'anchorTxHex', 'anchorValue',
    'fundingUtxo', 'fundingValue', 'fundingTxHex',
    'employerAddress', 'utxoAddress', 'department',
    'payPeriodSeconds', 'scrollPolicy', 'remaining', 'encryptionEntropy'
  ];
  
  const missing = required.filter(field => {
    const value = body[field];
    return value === undefined || value === null || value === '';
  });
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
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
  
  if (typeof body.remaining !== 'number' || body.remaining <= 0) {
    throw new Error('remaining must be a positive number (total pay periods budget)');
  }
  
  if (!/^[0-9a-f]+$/i.test(body.anchorTxHex.replace(/\s/g, ''))) {
    throw new Error('anchorTxHex contains invalid hex characters');
  }
  
  if (!/^[0-9a-f]+$/i.test(body.fundingTxHex.replace(/\s/g, ''))) {
    throw new Error('fundingTxHex contains invalid hex characters');
  }
  
  if (!/^[0-9a-f]+:\d+$/i.test(body.anchorUtxo)) {
    throw new Error('anchorUtxo must be in format "txid:vout"');
  }
  
  if (!/^[0-9a-f]+:\d+$/i.test(body.fundingUtxo)) {
    throw new Error('fundingUtxo must be in format "txid:vout"');
  }
  
  if (!body.utxoAddress.startsWith('tb1') && !body.utxoAddress.startsWith('bc1')) {
    throw new Error('utxoAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  if (typeof body.encryptionEntropy !== 'string' || body.encryptionEntropy.length === 0) {
    throw new Error('encryptionEntropy must be a non-empty string from wallet signature');
  }
  
  if (typeof body.department !== 'string' || body.department.trim().length === 0) {
    throw new Error('department must be a non-empty string');
  }
  
  if (body.multiSigSigners !== undefined) {
    if (!Array.isArray(body.multiSigSigners)) {
      throw new Error('multiSigSigners must be an array if provided');
    }
    if (body.multiSigSigners.length < 2) {
      throw new Error('multiSigSigners must contain at least 2 signers');
    }
  }
  
  if (body.multiSigThreshold !== undefined) {
    if (typeof body.multiSigThreshold !== 'number' || body.multiSigThreshold < 1) {
      throw new Error('multiSigThreshold must be a positive number');
    }
    if (body.multiSigSigners && body.multiSigThreshold > body.multiSigSigners.length) {
      throw new Error('multiSigThreshold cannot exceed number of signers');
    }
  }
}

async function getCompanyByEmployer(db: any, employerAddress: string): Promise<CompanyRecord | null> {
  const result = await db.execute({
    sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt FROM companies WHERE employerAddress = ?',
    args: [employerAddress]
  });
  return result.rows[0] || null;
}

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
  scrollPolicy: number,
  compensationSats: number
): Promise<void> {
  const now = new Date().toISOString();
  console.log(`[PLANS API] Saving plan record with status 'pending': ${appId.substring(0, 16)}...`);
  
  await db.execute({
    sql: `INSERT INTO plans (appId, nftUtxoId, anchorUtxo, ticker, employerAddress, department, payPeriodSeconds, remaining, compensationSats, metadataHash, scrollPolicy, status, createdAt, updatedAt) 
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      appId, 
      planUtxo, 
      anchorUtxo,
      constants.PAYROLL_NFT_TICKER, 
      employerAddress,
      department, 
      payPeriodSeconds, 
      remaining,
      compensationSats,
      metadataHash, 
      scrollPolicy,
      'pending',
      now,
      now
    ]
  });
  
  console.log(`[PLANS API] ✅ Plan record saved with status 'pending'`);
}

function getMultiSigConfig(multiSigRequired?: boolean, requestSigners?: string[], requestThreshold?: number): {
  multiSigSigners?: string[];
  multiSigThreshold?: number;
} {
  const isMultiSigRequired = multiSigRequired === true;
  
  if (!isMultiSigRequired) return {};

  if (requestSigners && requestSigners.length >= 2) {
    return {
      multiSigSigners: requestSigners,
      multiSigThreshold: requestThreshold || 2
    };
  }

  throw new Error('Multi-sig signers must be specified for departmental plan creation when multiSigRequired is true');
}

export async function createPayrollPlan(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const db = req.app.locals.db;
  
  console.log(`\n[PLANS API:${requestId}] ===== START createPayrollPlan =====`);
  
  try {
    console.log(`[PLANS API:${requestId}] Validating request body...`);
    
    if (!req.body || Object.keys(req.body).length === 0) {
      console.error(`[PLANS API:${requestId}] ❌ Empty request body`);
      return res.status(400).json({ error: 'Request body is required' });
    }
    
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
    
    validatePayrollPlanRequest(req.body);
    
    const {
      anchorUtxo,
      anchorTxHex,
      anchorValue,
      fundingUtxo,
      fundingValue,
      fundingTxHex,
      fundingScript,
      employerAddress,
      utxoAddress,
      department,
      payPeriodSeconds,
      scrollPolicy,
      remaining,
      encryptionEntropy,
      multiSigRequired,
      multiSigSigners,
      multiSigThreshold
    } = req.body;
    
    const cleanAnchorTxHex = anchorTxHex.replace(/\s/g, '');
    const cleanFundingTxHex = fundingTxHex.replace(/\s/g, '');
    
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
    
    console.log(`[PLANS API:${requestId}] ✅ Using funding UTXO hex from frontend (length: ${cleanFundingTxHex.length} chars)`);
    
    console.log(`[PLANS API:${requestId}] 🔐 Encrypting payroll data with wallet entropy...`);
    
    const encryptedBlob = await encryptPayrollData({
      department,
      remaining,
      created: new Date().toISOString(),
      scrollPolicy,
      payPeriodSeconds,
      uiTemplate: scrollPolicy === 0 ? 'employee' : 'freelancer'
    }, encryptionEntropy);
    
    console.log(`[PLANS API:${requestId}] ✅ Data encrypted with wallet entropy (non-custodial)`);
    
    console.log(`[PLANS API:${requestId}] 📦 Pinning to IPFS...`);
    
    const { cid, metadataHash } = await pinToIPFS(encryptedBlob);
    
    console.log(`[PLANS API:${requestId}] ✅ IPFS pin successful`);
    console.log(`    CID: ${cid}`);
    console.log(`    Hash: ${metadataHash.substring(0, 16)}...`);
    
    await db.execute({
      sql: 'INSERT OR IGNORE INTO ipfs_mappings (metadataHash, cid, createdAt) VALUES (?, ?, ?)',
      args: [metadataHash, cid, new Date().toISOString()]
    });
    
    console.log(`[PLANS API:${requestId}] ✅ CID Mapping saved: ${metadataHash.substring(0, 16)}... -> ${cid}`);
    
    console.log(`[PLANS API:${requestId}] 🔧 Building SpellRequest...`);
    
    const isCollapsed = anchorUtxo === fundingUtxo;
    console.log(`[PLANS API:${requestId}] Input deduplication check: anchorUtxo === fundingUtxo? ${isCollapsed}`);
    
    if (isCollapsed) {
      console.log(`[PLANS API:${requestId}] 🚀 Collapsed Model detected - using single UTXO for both anchor and fee`);
      console.log(`[PLANS API:${requestId}] This reduces transaction to single input for v14 NFT Scanner compatibility`);
    }
    
    const spellRequest: SpellRequest = {
      type: 'mint-nft',
      anchorUtxo: anchorUtxo,
      anchorValue: anchorValue,
      fundingUtxo: fundingUtxo,
      fundingUtxoValue: fundingValue,
      changeAddress: employerAddress,
      utxoAddress: utxoAddress,
      feeRate: constants.DEFAULT_FEE_RATE,
      fundingScript: fundingScript,
      outputs: [{
        address: employerAddress,
        nftMetadata: {
          ticker: `${department.toUpperCase()}-PAY`,
          remaining: remaining,
          metadataHash: metadataHash,
          scrollPolicy: scrollPolicy,
          payPeriodSeconds: payPeriodSeconds,
          compensationSats: 0
        }
      }],
      ...getMultiSigConfig(multiSigRequired, multiSigSigners, multiSigThreshold)
    };
    
    console.log(`[PLANS API:${requestId}] SpellRequest constructed with fundingUtxo: ${spellRequest.fundingUtxo ? spellRequest.fundingUtxo.substring(0, 20) + '...' : 'undefined'}`);
    console.log(`[PLANS API:${requestId}] Collapsed mode: anchorUtxo === fundingUtxo? ${anchorUtxo === fundingUtxo}`);
    
    console.log(`[PLANS API:${requestId}] ⏳ Calling proverClient...`);
    
    console.log(`[PLANS API:${requestId}] Collapsed Model detection: anchorUtxo === fundingUtxo? ${anchorUtxo === fundingUtxo}`);
    
    const contextHexes = isCollapsed 
      ? [cleanAnchorTxHex] 
      : [cleanAnchorTxHex, cleanFundingTxHex];
    
    console.log(`[PLANS API:${requestId}] Context hexes count: ${contextHexes.length}`);
    console.log(`[PLANS API:${requestId}] Context hexes details:`, contextHexes.map((hex, i) => ({
      index: i,
      length: hex.length,
      prefix: hex.substring(0, 30) + '...'
    })));
    
    const result = await generateUnsignedTransactions(
      spellRequest, 
      contextHexes,
      company.treasuryHexDest,
      undefined,
      utxoAddress
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Transactions generated`);
    
    const appId = crypto.createHash('sha256').update(anchorUtxo).digest('hex');
    
    const spellTx = bitcoin.Transaction.fromHex(result.spellTxHex);
    const planUtxo = `${spellTx.getId()}:0`;
    
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
      scrollPolicy,
      1000
    );
    
    console.log(`[PLANS API:${requestId}] ✅ Plan record saved with budget: ${remaining} and status: pending`);
    
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

export async function getPlans(req: Request, res: Response) {
  const db = req.app.locals.db;
  
  try {
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

export async function getPlanById(req: Request, res: Response) {
  const db = req.app.locals.db;
  
  try {
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