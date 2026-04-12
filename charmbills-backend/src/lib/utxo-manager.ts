import axios from 'axios';
import * as constants from '@shared/constants';
import { Database } from 'sqlite3';
import * as path from 'path';

// --------------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------------

// Use testnet4 for development, mainnet for production
const NETWORK = process.env.BITCOIN_NETWORK || 'testnet4';
const MEMPOOL_API = {
  testnet4: 'https://mempool.space/testnet4/api',
  testnet: 'https://mempool.space/testnet/api',
  mainnet: 'https://mempool.space/api'
}[NETWORK] || 'https://mempool.space/testnet4/api';

const MIN_CONFIRMATIONS = process.env.UTXO_MIN_CONFIRMATIONS 
  ? parseInt(process.env.UTXO_MIN_CONFIRMATIONS) 
  : 1;

// Retry configuration for API calls
const MAX_RETRIES = 3;
const BASE_TIMEOUT = 30000; // Increased to 30 seconds for production

// Database connection
const DB_PATH = process.env.PAYROLL_DB_PATH || path.join(process.cwd(), 'payroll.db');
const db = new Database(DB_PATH);

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

export interface Utxo {
  txid: string;
  vout: number;
  value: number; // satoshis
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface FundingUtxo {
  utxoId: string;      // Format: "txid:vout"
  value: number;       // Satoshis
  hex: string;         // Raw transaction hex for provenance
  confirmations: number;
}

export interface LockedUtxo {
  utxoId: string;
  employerAddress: string;
  lockedAt: string;
  expiresAt: string;
}

// --------------------------------------------------------------------------------
// Error Classes
// --------------------------------------------------------------------------------

class UtxoError extends Error {
  constructor(message: string) {
    super(`[UTXO Manager] ${message}`);
    this.name = 'UtxoError';
  }
}

// --------------------------------------------------------------------------------
// UTXO Lock Management (Database-Backed) [4, 5]
// --------------------------------------------------------------------------------

/**
 * Locks a UTXO to prevent double-spending across multiple transactions
 * Lock expires after 30 minutes by default
 * 
 * @param utxoId - UTXO ID in format "txid:vout"
 * @param employerAddress - Employer who is locking this UTXO
 * @param ttlMinutes - Time to live in minutes (default: 30)
 */
export async function lockUtxo(
  utxoId: string, 
  employerAddress: string,
  ttlMinutes: number = 30
): Promise<void> {
  return new Promise((resolve, reject) => {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
    
    db.run(
      `INSERT INTO locked_utxos (utxoId, employerAddress, lockedAt, expiresAt) 
       VALUES (?, ?, ?, ?)`,
      [utxoId, employerAddress, now, expiresAt],
      (err: Error | null) => {
        if (err) {
          // SQLITE_CONSTRAINT means UTXO already locked
          if (err.message.includes('UNIQUE constraint failed')) {
            reject(new UtxoError(`UTXO ${utxoId} is already locked`));
          } else {
            reject(err);
          }
        } else {
          console.log(`[UTXO Manager] 🔒 Locked UTXO: ${utxoId} for employer ${employerAddress.substring(0, 16)}... expires at ${expiresAt}`);
          resolve();
        }
      }
    );
  });
}

/**
 * Unlocks a UTXO (call after transaction is broadcast or on failure)
 * 
 * @param utxoId - UTXO ID to unlock
 */
export async function unlockUtxo(utxoId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM locked_utxos WHERE utxoId = ?',
      [utxoId],
      function(err: Error | null) {
        if (err) {
          reject(err);
        } else {
          if (this.changes > 0) {
            console.log(`[UTXO Manager] 🔓 Unlocked UTXO: ${utxoId}`);
          }
          resolve(this.changes > 0);
        }
      }
    );
  });
}

/**
 * Checks if a UTXO is currently locked
 * 
 * @param utxoId - UTXO ID to check
 */
export async function isUtxoLocked(utxoId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    db.get(
      'SELECT utxoId FROM locked_utxos WHERE utxoId = ? AND expiresAt > ?',
      [utxoId, new Date().toISOString()],
      (err: Error | null, row: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(!!row);
        }
      }
    );
  });
}

/**
 * Gets all currently locked UTXOs (not expired)
 */
export async function getLockedUtxos(): Promise<string[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT utxoId FROM locked_utxos WHERE expiresAt > ?',
      [new Date().toISOString()],
      (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(r => r.utxoId));
        }
      }
    );
  });
}

/**
 * Gets locked UTXOs for a specific employer
 * 
 * @param employerAddress - Employer address to filter by
 */
export async function getLockedUtxosForEmployer(employerAddress: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    db.all(
      'SELECT utxoId FROM locked_utxos WHERE employerAddress = ? AND expiresAt > ?',
      [employerAddress, new Date().toISOString()],
      (err: Error | null, rows: any[]) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows.map(r => r.utxoId));
        }
      }
    );
  });
}

/**
 * Filters UTXOs by removing locked ones
 * 
 * @param utxos - Array of UTXOs to filter
 * @param excludeIds - Additional UTXO IDs to exclude (for session-level exclusion)
 */
export async function filterEligibleUtxos(
  utxos: Utxo[], 
  excludeIds: string[] = []
): Promise<Utxo[]> {
  // Get all locked UTXOs from database
  const lockedIds = await getLockedUtxos();
  
  // Combine locked IDs with session-level exclusion list
  const allExcluded = [...new Set([...lockedIds, ...excludeIds])];
  
  if (allExcluded.length > 0) {
    console.log(`[UTXO Manager] Excluding ${allExcluded.length} UTXOs (${lockedIds.length} locked, ${excludeIds.length} session-excluded)`);
  }
  
  // Filter out excluded UTXOs
  return utxos.filter(u => {
    const id = `${u.txid}:${u.vout}`;
    return !allExcluded.includes(id);
  });
}

/**
 * Cleans up expired locks (should be called periodically or on startup)
 */
export async function cleanupExpiredLocks(): Promise<number> {
  return new Promise((resolve, reject) => {
    db.run(
      'DELETE FROM locked_utxos WHERE expiresAt <= ?',
      [new Date().toISOString()],
      function(err: Error | null) {
        if (err) {
          reject(err);
        } else {
          if (this.changes > 0) {
            console.log(`[UTXO Manager] 🧹 Cleaned up ${this.changes} expired UTXO locks`);
          }
          resolve(this.changes);
        }
      }
    );
  });
}

// --------------------------------------------------------------------------------
// Core Functions
// --------------------------------------------------------------------------------

/**
 * Fetches all UTXOs for a given Bitcoin address from Mempool.space
 * Includes retry mechanism with exponential backoff for production reliability
 * 
 * @param address - Bitcoin address to fetch UTXOs for
 * @param retryCount - Current retry attempt (used internally for recursion)
 * @returns Array of UTXOs
 */
export async function fetchAddressUtxos(address: string, retryCount: number = 0): Promise<Utxo[]> {
  try {
    console.log(`[UTXO Manager] Fetching UTXOs for ${address} (Attempt ${retryCount + 1})...`);
    
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, { 
      timeout: BASE_TIMEOUT 
    });
    
    if (!response.data || !Array.isArray(response.data)) {
      throw new UtxoError(`Invalid response from Mempool API`);
    }
    
    console.log(`[UTXO Manager] Found ${response.data.length} UTXOs`);
    return response.data;
    
  } catch (error: any) {
    // PROFESSIONAL FIX: Implement exponential backoff for timeouts and server errors [Source 113]
    const isTimeout = error.code === 'ECONNABORTED';
    const isServerError = error.response?.status >= 500 && error.response?.status < 600;
    
    if ((isTimeout || isServerError) && retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount) * 1000;
      console.warn(`[UTXO Manager] API ${isTimeout ? 'timeout' : 'error'} (${error.response?.status || error.code}). Retrying in ${delay}ms...`);
      await new Promise(res => setTimeout(res, delay));
      return fetchAddressUtxos(address, retryCount + 1);
    }
    
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new UtxoError(`Mempool API timeout after ${MAX_RETRIES} retries`);
      }
      if (error.response?.status === 404) {
        throw new UtxoError(`Address ${address} not found or has no transactions`);
      }
      throw new UtxoError(`Mempool API error: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Fetches raw transaction hex from Mempool.space
 */
export async function fetchTransactionHex(txid: string): Promise<string> {
  try {
    console.log(`[UTXO Manager] Fetching hex for tx ${txid.substring(0, 8)}...`);
    
    const response = await axios.get(`${MEMPOOL_API}/tx/${txid}/hex`, {
      timeout: 10000,
      responseType: 'text'
    });
    
    if (!response.data || typeof response.data !== 'string') {
      throw new UtxoError(`Invalid hex response for tx ${txid}`);
    }
    
    // Clean hex (remove whitespace)
    const cleanHex = response.data.replace(/\s/g, '');
    
    if (!/^[0-9a-f]+$/i.test(cleanHex)) {
      throw new UtxoError(`Invalid hex format for tx ${txid}`);
    }
    
    console.log(`[UTXO Manager] Hex length: ${cleanHex.length} bytes`);
    return cleanHex;
    
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new UtxoError(`Transaction ${txid} not found`);
      }
      throw new UtxoError(`Failed to fetch tx hex: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Selects the optimal UTXO using "Smallest Sufficient" strategy
 * 
 * Why smallest sufficient?
 * 1. Preserves larger UTXOs for future high-value transactions
 * 2. Prevents treasury fragmentation (dusting)
 * 3. Minimizes change outputs
 * 
 * @param utxos - Array of UTXOs to select from
 * @param minAmount - Minimum satoshis required
 * @param excludeIds - Additional UTXO IDs to exclude (session-level exclusion)
 */
export async function selectOptimalUtxo(
  utxos: Utxo[], 
  minAmount: number, 
  excludeIds: string[] = []
): Promise<Utxo> {
  if (!utxos || utxos.length === 0) {
    throw new UtxoError('No UTXOs available');
  }
  
  // Filter for confirmed UTXOs with sufficient value AND not excluded
  const eligible = utxos.filter(u => {
    const id = `${u.txid}:${u.vout}`;
    return u.status.confirmed && u.value >= minAmount && !excludeIds.includes(id);
  });
  
  if (eligible.length === 0) {
    const confirmedCount = utxos.filter(u => u.status.confirmed).length;
    const excludedCount = excludeIds.length;
    
    let message = `No confirmed UTXOs with ≥${minAmount} sats`;
    if (excludedCount > 0) {
      message += ` after excluding ${excludedCount} UTXO(s)`;
    }
    message += `. Found ${confirmedCount} confirmed UTXOs total.`;
    
    throw new UtxoError(message);
  }
  
  // Smallest sufficient strategy: sort by value ascending
  const sorted = [...eligible].sort((a, b) => a.value - b.value);
  const selected = sorted[0];
  
  console.log(`[UTXO Manager] Selected UTXO:`, {
    txid: `${selected.txid}:${selected.vout}`,
    value: selected.value,
    confirmations: selected.status.block_height ? 'confirmed' : 'pending',
    excludedCount: excludeIds.length
  });
  
  return selected;
}

/**
 * Main function: Dynamically selects the smallest UTXO that covers the required amount
 * Uses database-backed locking to prevent double-spending
 * 
 * @param address - Treasury address to check
 * @param minAmount - Minimum satoshis needed (e.g., 50000 for fees + outputs)
 * @param employerAddress - Employer address for lock ownership (required)
 * @param sessionExcludeIds - Additional UTXO IDs to exclude (session-level exclusion)
 * @returns FundingUtxo object with ID, value, and raw hex
 */
export async function getDynamicFundingUtxo(
  address: string, 
  minAmount: number,
  employerAddress: string,
  sessionExcludeIds: string[] = []
): Promise<FundingUtxo> {
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`\n[UTXO Manager:${requestId}] ===== START =====`);
  console.log(`[UTXO Manager:${requestId}] Address: ${address}`);
  console.log(`[UTXO Manager:${requestId}] Required: ${minAmount} sats`);
  console.log(`[UTXO Manager:${requestId}] Employer: ${employerAddress.substring(0, 16)}...`);
  console.log(`[UTXO Manager:${requestId}] Session excludes: ${sessionExcludeIds.length} UTXO(s)`);
  
  // Clean up expired locks on each request
  await cleanupExpiredLocks();
  
  try {
    // Step 1: Fetch all UTXOs for address (with retries)
    const allUtxos = await fetchAddressUtxos(address);
    
    // Step 2: Filter out locked UTXOs and session-excluded UTXOs
    const eligibleUtxos = await filterEligibleUtxos(allUtxos, sessionExcludeIds);
    
    console.log(`[UTXO Manager:${requestId}] Eligible after filtering: ${eligibleUtxos.length} / ${allUtxos.length}`);
    
    // Step 3: Select optimal UTXO from eligible ones
    const selected = await selectOptimalUtxo(eligibleUtxos, minAmount, sessionExcludeIds);
    
    // Step 4: Lock the selected UTXO in database
    const utxoId = `${selected.txid}:${selected.vout}`;
    await lockUtxo(utxoId, employerAddress);
    
    // Step 5: Fetch raw transaction hex
    const hex = await fetchTransactionHex(selected.txid);
    
    const result: FundingUtxo = {
      utxoId,
      value: selected.value,
      hex,
      confirmations: selected.status.confirmed ? 1 : 0
    };
    
    console.log(`[UTXO Manager:${requestId}] ✅ Success:`, {
      utxoId: result.utxoId,
      value: result.value,
      hexLength: result.hex.length
    });
    console.log(`[UTXO Manager:${requestId}] ===== END =====\n`);
    
    return result;
    
  } catch (error: any) {
    console.error(`[UTXO Manager:${requestId}] ❌ Failed:`, error.message);
    console.error(`[UTXO Manager:${requestId}] ===== END =====\n`);
    throw error;
  }
}

/**
 * Estimates required satoshis for a batch transaction
 * 
 * @param workerCount - Number of workers being paid
 * @param extraBuffer - Optional buffer for fee spikes
 * @returns Minimum satoshis needed
 */
export function estimateRequiredSats(
  workerCount: number, 
  extraBuffer: number = 10000
): number {
  // Base: 1000 sats per output (dust limit)
  const outputsCost = (workerCount + 1) * constants.MIN_OUTPUT_SATS;
  
  // Estimated fee: ~10 sats/vbyte * 200 vbytes = 2000 sats
  const estimatedFee = 2000;
  
  // Total + buffer
  return outputsCost + estimatedFee + extraBuffer;
}

// --------------------------------------------------------------------------------
// Export database for external cleanup if needed
// --------------------------------------------------------------------------------

export { db };