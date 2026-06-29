import axios from 'axios';
import * as constants from '@shared/constants';

// --------------------------------------------------------------------------------
// Configuration
// --------------------------------------------------------------------------------

const MIN_CONFIRMATIONS = process.env.UTXO_MIN_CONFIRMATIONS 
  ? parseInt(process.env.UTXO_MIN_CONFIRMATIONS) 
  : 1;

const MAX_RETRIES = 3;
const BASE_TIMEOUT = 100000;

// RPC Configuration
const RPC_HOST = process.env.RPC_HOST || '127.0.0.1';
const RPC_PORT = process.env.RPC_PORT || '48332';
const RPC_URL = `http://${RPC_HOST}:${RPC_PORT}`;
const RPC_AUTH = process.env.RPC_USER && process.env.RPC_PASSWORD
  ? Buffer.from(`${process.env.RPC_USER}:${process.env.RPC_PASSWORD}`).toString('base64')
  : '';

// --------------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------------

export interface Utxo {
  txid: string;
  vout: number;
  value: number;
  status: {
    confirmed: boolean;
    block_height?: number;
    block_hash?: string;
    block_time?: number;
  };
}

export interface FundingUtxo {
  utxoId: string;
  value: number;
  hex: string;
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

export interface FeeRecommendation {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  minimumFee: number;
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
// RPC Helper
// --------------------------------------------------------------------------------

async function rpcCall(method: string, params: any[]): Promise<any> {
  try {
    const response = await axios.post(
      RPC_URL,
      {
        jsonrpc: '1.0',
        id: 'utxo-mgr-' + Date.now(),
        method,
        params
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${RPC_AUTH}`
        },
        timeout: 30000
      }
    );

    if (response.data.error) {
      throw new Error(response.data.error.message);
    }

    return response.data.result;
  } catch (error: any) {
    if (axios.isAxiosError(error)) {
      throw new UtxoError(`RPC call failed: ${error.message}`);
    }
    throw error;
  }
}

// --------------------------------------------------------------------------------
// UTXO Lock Management (Database-Backed)
// --------------------------------------------------------------------------------

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
    if (err.message && err.message.includes('UNIQUE constraint failed')) {
      throw new UtxoError(`UTXO ${utxoId} is already locked`);
    }
    throw err;
  }
}

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

export async function isUtxoLocked(db: any, utxoId: string): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE utxoId = ? AND expiresAt > ?',
    args: [utxoId, new Date().toISOString()]
  });
  
  return result.rows && result.rows.length > 0;
}

export async function getLockedUtxos(db: any): Promise<string[]> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE expiresAt > ?',
    args: [new Date().toISOString()]
  });
  
  return result.rows ? result.rows.map((r: any) => r.utxoId) : [];
}

export async function getLockedUtxosForEmployer(db: any, employerAddress: string): Promise<string[]> {
  const result = await db.execute({
    sql: 'SELECT utxoId FROM locked_utxos WHERE employerAddress = ? AND expiresAt > ?',
    args: [employerAddress, new Date().toISOString()]
  });
  
  return result.rows ? result.rows.map((r: any) => r.utxoId) : [];
}

export async function filterEligibleUtxos(
  db: any,
  utxos: Utxo[], 
  excludeIds: string[] = []
): Promise<Utxo[]> {
  const lockedIds = await getLockedUtxos(db);
  const allExcluded = [...new Set([...lockedIds, ...excludeIds])];
  
  if (allExcluded.length > 0) {
    console.log(`[UTXO Manager] Excluding ${allExcluded.length} UTXOs (${lockedIds.length} locked, ${excludeIds.length} session-excluded)`);
  }
  
  return utxos.filter(u => {
    const id = `${u.txid}:${u.vout}`;
    return !allExcluded.includes(id);
  });
}

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
// Dynamic Fee Rate Functions (Local RPC Only)
// --------------------------------------------------------------------------------

export async function getCurrentFeeRate(): Promise<FeeRecommendation> {
  try {
    console.log(`[UTXO Manager] Fetching fee rates from local RPC...`);
    
    const result = await rpcCall('estimatesmartfee', [6]);
    
    if (result?.feerate) {
      const feeRate = Math.ceil(result.feerate * 100000000 / 1000);
      
      console.log(`[UTXO Manager] Current fee rates from RPC - fastest: ${Math.ceil(feeRate * 1.5)}, halfHour: ${feeRate}, hour: ${Math.ceil(feeRate * 0.8)}, min: ${Math.ceil(feeRate * 0.5)} sats/vB`);
      
      return {
        fastestFee: Math.ceil(feeRate * 1.5),
        halfHourFee: feeRate,
        hourFee: Math.ceil(feeRate * 0.8),
        minimumFee: Math.ceil(feeRate * 0.5)
      };
    }
    
    throw new Error('Invalid response from estimatesmartfee');
    
  } catch (error: any) {
    console.warn(`[UTXO Manager] RPC fee estimation failed: ${error.message}`);
    console.warn(`[UTXO Manager] Using hardcoded fallback fees (fastest: 10, halfHour: 8, hour: 5, min: 2)`);
    
    return {
      fastestFee: 10,
      halfHourFee: 8,
      hourFee: 5,
      minimumFee: 2
    };
  }
}

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

export function estimateTransactionVSize(inputCount: number, outputCount: number): number {
  const INPUT_VBYTES = 68;
  const OUTPUT_VBYTES = 43;
  const OVERHEAD_VBYTES = 10;
  
  const estimatedSize = OVERHEAD_VBYTES + (inputCount * INPUT_VBYTES) + (outputCount * OUTPUT_VBYTES);
  
  console.log(`[UTXO Manager] Transaction size estimate: ${estimatedSize} vB (${inputCount} inputs, ${outputCount} outputs)`);
  
  return estimatedSize;
}

// --------------------------------------------------------------------------------
// Core Functions - Using Local RPC Only
// --------------------------------------------------------------------------------

export async function fetchAddressUtxos(address: string, retryCount: number = 0): Promise<Utxo[]> {
  try {
    console.log(`[UTXO Manager] Fetching UTXOs for ${address} via local RPC (Attempt ${retryCount + 1})...`);
    
    const result = await rpcCall('scantxoutset', [
      'start',
      [`addr(${address})`]
    ]);
    
    if (!result || !result.unspents || !Array.isArray(result.unspents)) {
      throw new UtxoError('Invalid response from RPC scantxoutset');
    }
    
    const utxos: Utxo[] = result.unspents.map((utxo: any) => ({
      txid: utxo.txid,
      vout: utxo.vout,
      value: Math.round(utxo.amount * 100000000),
      status: {
        confirmed: true,
        block_height: utxo.height,
        block_hash: utxo.blockhash,
        block_time: utxo.time || Math.floor(Date.now() / 1000)
      }
    }));
    
    console.log(`[UTXO Manager] Found ${utxos.length} UTXOs via scantxoutset`);
    return utxos;
    
  } catch (error: any) {
    const isTimeout = error.code === 'ECONNABORTED';
    const isServerError = error.message?.includes('RPC call failed');
    
    if ((isTimeout || isServerError) && retryCount < MAX_RETRIES) {
      const delay = Math.pow(2, retryCount) * 1000;
      console.warn(`[UTXO Manager] RPC ${isTimeout ? 'timeout' : 'error'}. Retrying in ${delay}ms...`);
      await new Promise(res => setTimeout(res, delay));
      return fetchAddressUtxos(address, retryCount + 1);
    }
    
    throw new UtxoError(`Failed to fetch UTXOs: ${error.message}`);
  }
}

export async function fetchTransactionHex(txid: string): Promise<string> {
  try {
    console.log(`[UTXO Manager] Fetching hex for tx ${txid.substring(0, 8)} via Local RPC...`);
    
    const hex = await rpcCall('getrawtransaction', [txid]);
    
    if (!hex || typeof hex !== 'string') {
      throw new UtxoError(`Invalid hex response for tx ${txid}`);
    }
    
    const cleanHex = hex.replace(/\s/g, '');
    
    if (!/^[0-9a-f]+$/i.test(cleanHex)) {
      throw new UtxoError(`Invalid hex format for tx ${txid}`);
    }
    
    console.log(`[UTXO Manager] Hex length: ${cleanHex.length} bytes`);
    return cleanHex;
    
  } catch (error: any) {
    if (error.message?.includes('No such mempool or blockchain transaction')) {
      throw new UtxoError(`Transaction ${txid} not found in local node`);
    }
    throw new UtxoError(`Failed to fetch tx hex: ${error.message}`);
  }
}

export async function verifyUtxoStatus(utxoId: string): Promise<UtxoStatus> {
  try {
    console.log(`[UTXO Manager] Verifying UTXO status: ${utxoId}`);
    
    const [txid, vout] = utxoId.split(':');
    
    if (!txid || vout === undefined) {
      throw new UtxoError(`Invalid UTXO ID format: ${utxoId}`);
    }
    
    const voutNum = parseInt(vout, 10);
    
    const txData = await rpcCall('getrawtransaction', [txid, true]);
    
    const isConfirmed = txData.confirmations && txData.confirmations > 0;
    
    let isSpent = false;
    try {
      const utxoResult = await rpcCall('gettxout', [txid, voutNum, true]);
      isSpent = !utxoResult;
    } catch (err: any) {
      if (err.message?.includes('No such mempool or blockchain transaction')) {
        isSpent = true;
      } else {
        throw err;
      }
    }
    
    console.log(`[UTXO Manager] UTXO ${utxoId}: spent=${isSpent}, confirmed=${isConfirmed}`);
    
    return {
      spent: isSpent,
      confirmed: isConfirmed,
      details: {
        transaction: txData,
        isSpent
      }
    };
    
  } catch (error: any) {
    console.error(`[UTXO Manager] Failed to verify UTXO ${utxoId}:`, error.message);
    
    return {
      spent: true,
      confirmed: false,
      details: { error: `Verification failed: ${error.message}` }
    };
  }
}

export async function selectOptimalUtxo(
  utxos: Utxo[], 
  minAmount: number, 
  excludeIds: string[] = []
): Promise<Utxo> {
  if (!utxos || utxos.length === 0) {
    throw new UtxoError('No UTXOs available');
  }
  
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
  
  const sorted = [...eligible].sort((a, b) => a.value - b.value);
  const selected = sorted[0];
  
  console.log(`[UTXO Manager] Selected UTXO:`, {
    txid: `${selected.txid}:${selected.vout}`,
    value: selected.value,
    confirmations: selected.status.confirmed ? 'confirmed' : 'pending',
    excludedCount: excludeIds.length
  });
  
  return selected;
}

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
  
  await cleanupExpiredLocks(db);
  
  try {
    const allUtxos = await fetchAddressUtxos(address);
    const eligibleUtxos = await filterEligibleUtxos(db, allUtxos, sessionExcludeIds);
    
    console.log(`[UTXO Manager:${requestId}] Eligible after filtering: ${eligibleUtxos.length} / ${allUtxos.length}`);
    
    const selected = await selectOptimalUtxo(eligibleUtxos, minAmount, sessionExcludeIds);
    
    const utxoId = `${selected.txid}:${selected.vout}`;
    await lockUtxo(db, utxoId, employerAddress);
    
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

export function estimateRequiredSats(
  workerCount: number, 
  extraBufferPercent: number = 50
): number {
  const outputsCost = (workerCount + 1) * constants.MIN_OUTPUT_SATS;
  const estimatedFee = 2000;
  const total = outputsCost + estimatedFee;
  const buffer = Math.ceil(total * (extraBufferPercent / 100));
  
  console.log(`[UTXO Manager] Estimate: base=${total}, buffer=${buffer} (${extraBufferPercent}%), total=${total + buffer}`);
  return total + buffer;
}