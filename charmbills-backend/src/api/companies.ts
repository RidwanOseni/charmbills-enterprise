// src/api/companies.ts
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { saveCompanyConfig } from '../db/schema';
import { getCompanyVaultAddress } from '../bitcoin/scrollsClient';

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface RegisterCompanyRequest {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
}

interface CompanyResponse {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
  vaultAddress: string;
  createdAt: string;
}

// --------------------------------------------------------------------------------
// Validation
// --------------------------------------------------------------------------------

function validateCompanyRequest(body: any): asserts body is RegisterCompanyRequest {
  const required = ['employerAddress', 'treasuryAddress', 'treasuryHexDest'];
  const missing = required.filter(field => !body[field]);
  
  if (missing.length > 0) {
    throw new Error(`Missing required fields: ${missing.join(', ')}`);
  }
  
  const addressRegex = /^(tb1|bc1)[a-zA-HJ-NP-Z0-9]{25,90}$/;
  if (!addressRegex.test(body.employerAddress)) {
    throw new Error('employerAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  if (!addressRegex.test(body.treasuryAddress)) {
    throw new Error('treasuryAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(body.treasuryHexDest) || body.treasuryHexDest.length % 2 !== 0) {
    throw new Error('treasuryHexDest must be a valid hex string (even number of hex characters)');
  }
  
  if (!body.treasuryHexDest.startsWith('5120')) {
    console.warn(`[WARNING] treasuryHexDest does not start with '5120' (Taproot prefix). Got: ${body.treasuryHexDest.substring(0, 4)}`);
  }
}

// --------------------------------------------------------------------------------
// Helper: Get database from request
// --------------------------------------------------------------------------------

function getDb(req: Request) {
  return req.app.locals.db;
}

// --------------------------------------------------------------------------------
// API Handlers
// --------------------------------------------------------------------------------

/**
 * Register a new company's infrastructure details
 * POST /api/companies/register
 * 
 * v15 Dual-Custody:
 * - Stable vaultAddress: Nonce-based deterministic address for Salary Vault (treasury deposits)
 * - Asset routing: Uses scrolls: [0] in spells for ephemeral addresses
 */
export async function registerCompany(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const db = getDb(req);

  console.log(`\n[COMPANY API:${requestId}] ===== START registerCompany =====`);
  
  try {
    validateCompanyRequest(req.body);
    
    const { employerAddress, treasuryAddress, treasuryHexDest } = req.body;

    console.log(`[COMPANY API:${requestId}] Registering: ${employerAddress.substring(0, 16)}...`);
    console.log(`[COMPANY API:${requestId}] Treasury address: ${treasuryAddress.substring(0, 20)}...`);
    console.log(`[COMPANY API:${requestId}] Treasury hex dest: ${treasuryHexDest.substring(0, 30)}...`);

    console.log(`[COMPANY API:${requestId}] Deriving stable nonce-based vault address...`);
    
    let vaultAddress: string;
    try {
      vaultAddress = await getCompanyVaultAddress(employerAddress);
      console.log(`[COMPANY API:${requestId}] Derived vault address: ${vaultAddress.substring(0, 30)}...`);
    } catch (scrollError: any) {
      console.error(`[COMPANY API:${requestId}] ❌ Failed to derive vault address:`, scrollError.message);
      throw new Error(`Cannot register company: Scroll API error - ${scrollError.message}`);
    }

    console.log(`[COMPANY API:${requestId}] 💾 Saving company configuration to database...`);
    
    await saveCompanyConfig(
      db,
      employerAddress,
      treasuryAddress,
      treasuryHexDest,
      vaultAddress
    );

    const response: CompanyResponse = {
      employerAddress,
      treasuryAddress,
      treasuryHexDest,
      vaultAddress,
      createdAt: new Date().toISOString()
    };

    console.log(`[COMPANY API:${requestId}] ✅ Company registered successfully`);
    console.log(`[COMPANY API:${requestId}]   Vault: ${vaultAddress.substring(0, 30)}... (stable nonce-based)`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(201).json({ success: true, ...response });

  } catch (error: any) {
    console.error(`[COMPANY API:${requestId}] ❌ ERROR:`, error.message);
    console.error(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    const statusCode = error.message.includes('Missing') || error.message.includes('must be') ? 400 : 500;
    return res.status(statusCode).json({ 
      success: false, 
      error: error.message,
      requestId
    });
  }
}

/**
 * Get company details by employer address
 * GET /api/companies/:employerAddress
 */
export async function getCompany(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const { employerAddress } = req.params;
  const db = getDb(req);
  
  console.log(`\n[COMPANY API:${requestId}] ===== START getCompany =====`);
  
  try {
    if (!employerAddress) {
      throw new Error('employerAddress is required');
    }
    
    console.log(`[COMPANY API:${requestId}] Fetching company: ${employerAddress.substring(0, 20)}...`);
    
    const result = await db.execute({
      sql: 'SELECT * FROM companies WHERE employerAddress = ?',
      args: [employerAddress]
    });
    
    const company = result.rows && result.rows.length > 0 ? result.rows[0] : null;
    
    if (!company) {
      console.log(`[COMPANY API:${requestId}] Company not found`);
      console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
      return res.status(404).json({
        success: false,
        error: 'Company not found',
        employerAddress
      });
    }
    
    console.log(`[COMPANY API:${requestId}] ✅ Company found`);
    console.log(`[COMPANY API:${requestId}]   Vault: ${company.vaultAddress ? company.vaultAddress.substring(0, 30) + '...' : 'not set'}`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json({
      success: true,
      data: {
        employerAddress: company.employerAddress,
        treasuryAddress: company.treasuryAddress,
        treasuryHexDest: `${company.treasuryHexDest.substring(0, 20)}...`,
        vaultAddress: company.vaultAddress || '',
        createdAt: company.createdAt,
        updatedAt: company.updatedAt
      }
    });
    
  } catch (error: any) {
    console.error(`[COMPANY API:${requestId}] ❌ ERROR:`, error.message);
    console.error(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      requestId
    });
  }
}

/**
 * Get all companies (for admin dashboard)
 * GET /api/companies
 */
export async function listCompanies(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const { limit = '50', offset = '0' } = req.query;
  const db = getDb(req);
  
  console.log(`\n[COMPANY API:${requestId}] ===== START listCompanies =====`);
  
  try {
    const result = await db.execute({
      sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, vaultAddress, createdAt, updatedAt FROM companies ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      args: [parseInt(limit as string), parseInt(offset as string)]
    });
    
    const companies = result.rows || [];
    
    console.log(`[COMPANY API:${requestId}] Found ${companies.length} companies`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    const sanitized = companies.map((c: any) => ({
      employerAddress: c.employerAddress,
      treasuryAddress: c.treasuryAddress,
      treasuryHexDest: c.treasuryHexDest,
      vaultAddress: c.vaultAddress || '',
      createdAt: c.createdAt,
      updatedAt: c.updatedAt
    }));
    
    return res.status(200).json({
      success: true,
      count: companies.length,
      data: sanitized
    });
    
  } catch (error: any) {
    console.error(`[COMPANY API:${requestId}] ❌ ERROR:`, error.message);
    console.error(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      requestId
    });
  }
}

/**
 * Delete a company (admin only - use with caution)
 * DELETE /api/companies/:employerAddress
 */
export async function deleteCompany(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const { employerAddress } = req.params;
  const db = getDb(req);
  
  console.log(`\n[COMPANY API:${requestId}] ===== START deleteCompany =====`);
  console.log(`[COMPANY API:${requestId}] Deleting: ${employerAddress?.substring(0, 20)}...`);
  
  try {
    if (!employerAddress) {
      throw new Error('employerAddress is required');
    }
    
    const existsResult = await db.execute({
      sql: 'SELECT employerAddress FROM companies WHERE employerAddress = ?',
      args: [employerAddress]
    });
    
    const exists = existsResult.rows && existsResult.rows.length > 0;
    
    if (!exists) {
      console.log(`[COMPANY API:${requestId}] Company not found`);
      console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
      return res.status(404).json({
        success: false,
        error: 'Company not found'
      });
    }
    
    await db.execute({
      sql: 'DELETE FROM companies WHERE employerAddress = ?',
      args: [employerAddress]
    });
    
    console.log(`[COMPANY API:${requestId}] ✅ Company deleted`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json({
      success: true,
      message: 'Company deleted successfully',
      employerAddress
    });
    
  } catch (error: any) {
    console.error(`[COMPANY API:${requestId}] ❌ ERROR:`, error.message);
    console.error(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      requestId
    });
  }
}

/**
 * Update company's treasury hex destination
 * PATCH /api/companies/:employerAddress/treasury
 */
export async function updateTreasuryHex(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const { employerAddress } = req.params;
  const { treasuryHexDest } = req.body;
  const db = getDb(req);
  
  console.log(`\n[COMPANY API:${requestId}] ===== START updateTreasuryHex =====`);
  
  try {
    if (!employerAddress) {
      throw new Error('employerAddress is required');
    }
    
    if (!treasuryHexDest) {
      throw new Error('treasuryHexDest is required');
    }
    
    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
      throw new Error('treasuryHexDest must be a valid hex string (even number of hex characters)');
    }
    
    const now = new Date().toISOString();
    
    await db.execute({
      sql: 'UPDATE companies SET treasuryHexDest = ?, updatedAt = ? WHERE employerAddress = ?',
      args: [treasuryHexDest, now, employerAddress]
    });
    
    console.log(`[COMPANY API:${requestId}] ✅ Treasury hex updated`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json({
      success: true,
      message: 'Treasury hex destination updated',
      employerAddress,
      treasuryHexDest: `${treasuryHexDest.substring(0, 20)}...`
    });
    
  } catch (error: any) {
    console.error(`[COMPANY API:${requestId}] ❌ ERROR:`, error.message);
    console.error(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    const statusCode = error.message.includes('required') ? 400 : 500;
    return res.status(statusCode).json({
      success: false,
      error: error.message,
      requestId
    });
  }
}