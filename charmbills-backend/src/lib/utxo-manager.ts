import axios from 'axios';
import * as constants from '@shared/constants';

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

export interface UtxoStatus {
  spent: boolean;
  confirmed: boolean;
  details?: any;
}

// --------------------------------------------------------------------------------
// Fee Rate Interface
// --------------------------------------------------------------------------------

export interface FeeRecommendation {
  fastestFee: number;   // For immediate confirmation (next block)
  halfHourFee: number;  // For confirmation within 30 minutes
  hourFee: number;      // For confirmation within 1 hour
  minimumFee: number;   // Minimum fee rate
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
 * @param db - Database connection (Turso client)
 * @param utxoId - UTXO ID in format "txid:vout"
 * @param employerAddress - Employer who is locking this UTXO
 * @param ttlMinutes - Time to live in minutes (default: 30)
 */
export async function lockUtxo(
  db: any,
  utxoId: string, 
  employerAddress: string,
  ttlMinutes: number = 30
): Promise<void> {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  
  try {
    await db.execute({
      sql: `INSERT INTO locked_utxos (utxoId, employerAddress, lockedAt, expiresAt) 
            VALUES (?, ?, ?, ?)`,
      args: [utxoId, employerAddress, now, expiresAt]
    });
    console.log(`[UTXO Manager] 🔒 Locked UTXO: ${utxoId} for employer ${employerAddress.substring(0, 16)}... expires at ${expiresAt}`);
  } catch (err: any) {
    // SQLITE_CONSTRAINT means UTXO already locked
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      throw new UtxoError(`UTXO ${utxoId} is already locked`);
    }
    throw err;
  }
}

/**
 * Unlocks a UTXO (call after transaction is broadcast or on failure)
 * 
 * @param db - Database connection (Turso client)
 * @param utxoId - UTXO ID to unlock
 */
export async function unlockUtxo(db: any, utxoId: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'DELETE FROM locked_utxos WHERE utxoId = ?',
    args: [utxoId]
  });
  
  const changes = result.rowsAffected || 0;
  if (changes > 0) {
    console.log(`[UTXO Manager] 🔓 Unlocked UTXO: ${utxoId}`);
  }
  return changes > 0;
}

/**
 * Checks if a UTXO is currently locked
 * 
 * @param db - Database connection (Turso client)
 * @param utxoId - UTXO ID to check
 */
export async function isUtxoLocked(db: any, utxoId: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE utxoId = ? AND expiresAt > ?',
    args: [utxoId, new Date().toISOString()]
  });
  
  return result.rows && result.rows.length > 0;
}

/**
 * Gets all currently locked UTXOs (not expired)
 * 
 * @param db - Database connection (Turso client)
 */
export async function getLockedUtxos(db: any): Promise<string[]> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE expiresAt > ?',
    args: [new Date().toISOString()]
  });
  
  return result.rows ? result.rows.map((r: any) => r.utxoId) : [];
}

/**
 * Gets locked UTXOs for a specific employer
 * 
 * @param db - Database connection (Turso client)
 * @param employerAddress - Employer address to filter by
 */
export async function getLockedUtxosForEmployer(db: any, employerAddress: string): Promise<string[]> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE employerAddress = ? AND expiresAt > ?',
    args: [employerAddress, new Date().toISOString()]
  });
  
  return result.rows ? result.rows.map((r: any) => r.utxoId) : [];
}

/**
 * Filters UTXOs by removing locked ones
 * 
 * @param db - Database connection (Turso client)
 * @param utxos - Array of UTXOs to filter
 * @param excludeIds - Additional UTXO IDs to exclude (for session-level exclusion)
 */
export async function filterEligibleUtxos(
  db: any,
  utxos: Utxo[], 
  excludeIds: string[] = []
): Promise<Utxo[]> {
  // Get all locked UTXOs from database
  const lockedIds = await getLockedUtxos(db);
  
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
 * 
 * @param db - Database connection (Turso client)
 */
export async function cleanupExpiredLocks(db: any): Promise<number> {
  const result = await db.execute({
    sql: 'DELETE FROM locked_utxos WHERE expiresAt <= ?',
    args: [new Date().toISOString()]
  });
  
  const changes = result.rowsAffected || 0;
  if (changes > 0) {
    console.log(`[UTXO Manager] 🧹 Cleaned up ${changes} expired UTXO locks`);
  }
  return changes;
}

// --------------------------------------------------------------------------------
// Dynamic Fee Rate Functions
// --------------------------------------------------------------------------------

/**
 * Fetches current fee recommendations from Mempool.space API
 * Used for dynamic network fee calculation in production
 * 
 * @returns FeeRecommendation object with rates in sats per virtual byte
 */
export async function getCurrentFeeRate(): Promise<FeeRecommendation> {
  try {
    console.log(`[UTXO Manager] Fetching current fee rates from Mempool API...`);
    
    const response = await axios.get(`${MEMPOOL_API}/v1/fees/recommended`, {
      timeout: 5000
    });
    
    if (!response.data) {
      throw new UtxoError('Invalid response from fee API');
    }
    
    const feeRate: FeeRecommendation = {
      fastestFee: response.data.fastestFee || 10,
      halfHourFee: response.data.halfHourFee || 8,
      hourFee: response.data.hourFee || 5,
      minimumFee: response.data.minimumFee || 2
    };
    
    console.log(`[UTXO Manager] Current fee rates - fastest: ${feeRate.fastestFee}, halfHour: ${feeRate.halfHourFee}, hour: ${feeRate.hourFee}, min: ${feeRate.minimumFee} sats/vB`);
    
    return feeRate;
    
  } catch (error: any) {
    console.warn(`[UTXO Manager] Failed to fetch fee rates: ${error.message}`);
    console.warn(`[UTXO Manager] Using fallback fee rates (fastest: 10, halfHour: 8, hour: 5, min: 2)`);
    
    // Return fallback values if API fails
    return {
      fastestFee: 10,
      halfHourFee: 8,
      hourFee: 5,
      minimumFee: 2
    };
  }
}

/**
 * Calculates estimated network fee for a transaction
 * Based on current fee rates from Mempool API
 * 
 * @param estimatedVSize - Estimated virtual size of transaction in vBytes
 * @param feePriority - Priority level: 'fastest', 'halfHour', 'hour', 'minimum'
 * @returns Estimated network fee in satoshis
 */
export async function calculateNetworkFee(
  estimatedVSize: number,
  feePriority: 'fastest' | 'halfHour' | 'hour' | 'minimum' = 'halfHour'
): Promise<number> {
  const feeRates = await getCurrentFeeRate();
  
  let feeRate: number;
  switch (feePriority) {
    case 'fastest':
      feeRate = feeRates.fastestFee;
      break;
    case 'halfHour':
      feeRate = feeRates.halfHourFee;
      break;
    case 'hour':
      feeRate = feeRates.hourFee;
      break;
    case 'minimum':
      feeRate = feeRates.minimumFee;
      break;
    default:
      feeRate = feeRates.halfHourFee;
  }
  
  const estimatedFee = feeRate * estimatedVSize;
  console.log(`[UTXO Manager] Network fee calculation: ${feeRate} sats/vB × ${estimatedVSize} vB = ${estimatedFee} sats (priority: ${feePriority})`);
  
  return estimatedFee;
}

/**
 * Estimates transaction virtual size based on number of inputs and outputs
 * 
 * @param inputCount - Number of transaction inputs
 * @param outputCount - Number of transaction outputs
 * @returns Estimated virtual size in vBytes
 */
export function estimateTransactionVSize(inputCount: number, outputCount: number): number {
  // Base sizes: 
  // - Each input: ~68 vBytes (for Taproot)
  // - Each output: ~43 vBytes (for Taproot)
  // - Fixed overhead: ~10 vBytes
  const INPUT_VBYTES = 68;
  const OUTPUT_VBYTES = 43;
  const OVERHEAD_VBYTES = 10;
  
  const estimatedSize = OVERHEAD_VBYTES + (inputCount * INPUT_VBYTES) + (outputCount * OUTPUT_VBYTES);
  
  console.log(`[UTXO Manager] Transaction size estimate: ${estimatedSize} vB (${inputCount} inputs, ${outputCount} outputs)`);
  
  return estimatedSize;
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
 * Verifies the current status of a UTXO (spent status and confirmation)
 * Used by the automated release agent to ensure token hasn't been spent or reorged
 * 
 * @param utxoId - UTXO ID in format "txid:vout"
 * @returns UtxoStatus object with spent status and confirmation status
 */
export async function verifyUtxoStatus(utxoId: string): Promise<UtxoStatus> {
  try {
    console.log(`[UTXO Manager] Verifying UTXO status: ${utxoId}`);
    
    const [txid, vout] = utxoId.split(':');
    
    if (!txid || vout === undefined) {
      throw new UtxoError(`Invalid UTXO ID format: ${utxoId}`);
    }
    
    // Check if UTXO is spent using outspend endpoint
    const outspendResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/outspend/${vout}`, {
      timeout: 10000
    });
    
    // Fetch transaction details to check confirmation status
    const txResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}`, {
      timeout: 10000
    });
    
    const isSpent = outspendResponse.data.spent === true;
    const isConfirmed = txResponse.data.status?.confirmed === true;
    
    console.log(`[UTXO Manager] UTXO ${utxoId}: spent=${isSpent}, confirmed=${isConfirmed}`);
    
    return {
      spent: isSpent,
      confirmed: isConfirmed,
      details: {
        outspend: outspendResponse.data,
        transaction: txResponse.data
      }
    };
    
  } catch (error: any) {
    console.error(`[UTXO Manager] Failed to verify UTXO ${utxoId}:`, error.message);
    
    // Return conservative defaults for safety
    return {
      spent: true,
      confirmed: false,
      details: { error: `Verification failed: ${error.message}` }
    };
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
 * @param db - Database connection (Turso client)
 * @param address - Treasury address to check
 * @param minAmount - Minimum satoshis needed (e.g., 50000 for fees + outputs)
 * @param employerAddress - Employer address for lock ownership (required)
 * @param sessionExcludeIds - Additional UTXO IDs to exclude (session-level exclusion)
 * @returns FundingUtxo object with ID, value, and raw hex
 */
export async function getDynamicFundingUtxo(
  db: any,
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
  await cleanupExpiredLocks(db);
  
  try {
    // Step 1: Fetch all UTXOs for address (with retries)
    const allUtxos = await fetchAddressUtxos(address);
    
    // Step 2: Filter out locked UTXOs and session-excluded UTXOs
    const eligibleUtxos = await filterEligibleUtxos(db, allUtxos, sessionExcludeIds);
    
    console.log(`[UTXO Manager:${requestId}] Eligible after filtering: ${eligibleUtxos.length} / ${allUtxos.length}`);
    
    // Step 3: Select optimal UTXO from eligible ones
    const selected = await selectOptimalUtxo(eligibleUtxos, minAmount, sessionExcludeIds);
    
    // Step 4: Lock the selected UTXO in database
    const utxoId = `${selected.txid}:${selected.vout}`;
    await lockUtxo(db, utxoId, employerAddress);
    
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
 * @param extraBufferPercent - Optional buffer for fee spikes (default: 50)
 * @returns Minimum satoshis needed
 */
export function estimateRequiredSats(
  workerCount: number, 
  extraBufferPercent: number = 50  // 50% buffer instead of fixed 50000
): number {
  const outputsCost = (workerCount + 1) * constants.MIN_OUTPUT_SATS;
  const estimatedFee = 2000;
  const total = outputsCost + estimatedFee;
  const buffer = Math.ceil(total * (extraBufferPercent / 100));
  
  console.log(`[UTXO Manager] Estimate: base=${total}, buffer=${buffer} (${extraBufferPercent}%), total=${total + buffer}`);
  return total + buffer;
}