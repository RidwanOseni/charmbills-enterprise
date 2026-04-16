// src/api/companies.ts
import { Request, Response } from 'express';
import * as crypto from 'crypto';

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

interface RegisterCompanyRequest {
  employerAddress: string;   // HR manager's wallet address (primary key)
  treasuryAddress: string;   // Wallet used for gas sponsorship
  treasuryHexDest: string;   // Derived Taproot script hex (from wallet)
}

interface CompanyResponse {
  employerAddress: string;
  treasuryAddress: string;
  treasuryHexDest: string;
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
  
  // Validate Bech32 address format (testnet or mainnet)
  const addressRegex = /^(tb1|bc1)[a-zA-HJ-NP-Z0-9]{25,90}$/;
  if (!addressRegex.test(body.employerAddress)) {
    throw new Error('employerAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  if (!addressRegex.test(body.treasuryAddress)) {
    throw new Error('treasuryAddress must be a valid Bech32 address (tb1... or bc1...)');
  }
  
  // Validate hex destination (should be hex string, even length, no 't' characters)
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(body.treasuryHexDest) || body.treasuryHexDest.length % 2 !== 0) {
    throw new Error('treasuryHexDest must be a valid hex string (even number of hex characters)');
  }
  
  // Taproot scriptPubKey should start with '5120' (P2TR)
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
 */
export async function registerCompany(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  const db = getDb(req);
  
  console.log(`\n[COMPANY API:${requestId}] ===== START registerCompany =====`);
  
  try {
    // Validate request body
    validateCompanyRequest(req.body);
    
    const { employerAddress, treasuryAddress, treasuryHexDest } = req.body;
    
    console.log(`[COMPANY API:${requestId}] Registering company:`, {
      employerAddress: `${employerAddress.substring(0, 20)}...`,
      treasuryAddress: `${treasuryAddress.substring(0, 20)}...`,
      treasuryHexDest: `${treasuryHexDest.substring(0, 30)}...`
    });
    
    // Check if company already exists
    const existingResult = await db.execute({
      sql: 'SELECT employerAddress FROM companies WHERE employerAddress = ?',
      args: [employerAddress]
    });
    
    const exists = existingResult.rows && existingResult.rows.length > 0;
    
    const now = new Date().toISOString();
    
    // Insert or replace company record
    await db.execute({
      sql: `
        INSERT OR REPLACE INTO companies 
        (employerAddress, treasuryAddress, treasuryHexDest, createdAt, updatedAt) 
        VALUES (?, ?, ?, ?, ?)
      `,
      args: [employerAddress, treasuryAddress, treasuryHexDest, now, now]
    });
    
    console.log(`[COMPANY API:${requestId}] ✅ Company registered successfully`);
    if (exists) {
      console.log(`[COMPANY API:${requestId}] Updated existing company record`);
    }
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json({
      success: true,
      message: exists ? 'Company infrastructure updated' : 'Company infrastructure registered',
      data: {
        employerAddress,
        treasuryAddress,
        treasuryHexDest: `${treasuryHexDest.substring(0, 20)}...`,
        createdAt: now
      }
    });
    
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
      sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt FROM companies WHERE employerAddress = ?',
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
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    return res.status(200).json({
      success: true,
      data: {
        employerAddress: company.employerAddress,
        treasuryAddress: company.treasuryAddress,
        treasuryHexDest: `${company.treasuryHexDest.substring(0, 20)}...`, // Truncate for response
        createdAt: company.createdAt
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
      sql: 'SELECT employerAddress, treasuryAddress, treasuryHexDest, createdAt FROM companies ORDER BY createdAt DESC LIMIT ? OFFSET ?',
      args: [parseInt(limit as string), parseInt(offset as string)]
    });
    
    const companies = result.rows || [];
    
    console.log(`[COMPANY API:${requestId}] Found ${companies.length} companies`);
    console.log(`[COMPANY API:${requestId}] ===== END =====\n`);
    
    // Truncate hex destinations for response
    const sanitized = companies.map((c: any) => ({
      employerAddress: c.employerAddress,
      treasuryAddress: c.treasuryAddress,
      treasuryHexDest: `${c.treasuryHexDest.substring(0, 20)}...`,
      createdAt: c.createdAt
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
    
    // Check if company exists
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
    
    // Delete company
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
    
    // Validate hex
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