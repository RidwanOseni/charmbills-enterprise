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
// Core Functions
// --------------------------------------------------------------------------------

/**
 * Fetches all UTXOs for a given Bitcoin address from Mempool.space
 */
export async function fetchAddressUtxos(address: string): Promise<Utxo[]> {
  try {
    console.log(`[UTXO Manager] Fetching UTXOs for ${address}...`);
    
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 10000 // 10 second timeout
    });
    
    if (!response.data || !Array.isArray(response.data)) {
      throw new UtxoError(`Invalid response from Mempool API`);
    }
    
    console.log(`[UTXO Manager] Found ${response.data.length} UTXOs`);
    return response.data;
    
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      if (error.code === 'ECONNABORTED') {
        throw new UtxoError(`Mempool API timeout`);
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
 * @param excludeIds - Array of UTXO IDs (txid:vout) to exclude from selection
 */
export function selectOptimalUtxo(
  utxos: Utxo[], 
  minAmount: number, 
  excludeIds: string[] = [] // FIX: Added exclusion list parameter
): Utxo {
  if (!utxos || utxos.length === 0) {
    throw new UtxoError('No UTXOs available');
  }
  
  // FIX: Filter for confirmed UTXOs with sufficient value AND not in exclusion list
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
 * 
 * @param address - Treasury address to check
 * @param minAmount - Minimum satoshis needed (e.g., 50000 for fees + outputs)
 * @param excludeIds - Array of UTXO IDs to exclude from selection (session exclusion list)
 * @returns FundingUtxo object with ID, value, and raw hex
 */
export async function getDynamicFundingUtxo(
  address: string, 
  minAmount: number,
  excludeIds: string[] = [] // FIX: Added exclusion list parameter
): Promise<FundingUtxo> {
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`\n[UTXO Manager:${requestId}] ===== START =====`);
  console.log(`[UTXO Manager:${requestId}] Address: ${address}`);
  console.log(`[UTXO Manager:${requestId}] Required: ${minAmount} sats`);
  console.log(`[UTXO Manager:${requestId}] Excluding: ${excludeIds.length} UTXO(s)`);
  
  if (excludeIds.length > 0) {
    console.log(`[UTXO Manager:${requestId}] Exclusion list:`, excludeIds);
  }
  
  try {
    // Step 1: Fetch all UTXOs for address
    const utxos = await fetchAddressUtxos(address);
    
    // Step 2: Select optimal UTXO (pass exclusion list)
    const selected = selectOptimalUtxo(utxos, minAmount, excludeIds);
    
    // Step 3: Fetch raw transaction hex
    const hex = await fetchTransactionHex(selected.txid);
    
    const result: FundingUtxo = {
      utxoId: `${selected.txid}:${selected.vout}`,
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