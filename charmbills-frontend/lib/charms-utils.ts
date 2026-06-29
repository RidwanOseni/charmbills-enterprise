import init, { extractAndVerifySpell } from "./wasm/charms_lib";
import * as constants from '../shared/constants';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
const PROTOCOL_VERSION = 15; 
const USED_UTXO_KEY = 'charm_used_utxos';
const MAX_RETRIES = constants.API_MAX_RETRIES;
const RETRY_DELAY_MS = constants.API_RETRY_DELAY_MS;
const REQUEST_TIMEOUT_MS = constants.API_REQUEST_TIMEOUT_MS;

export function calculateScrollFee(numInputs: number, totalSats: number): number {
    const fixed = constants.SCROLL_FIXED_COST || 895;
    const perInput = constants.SCROLL_FEE_PER_INPUT || 64;
    const basisPoints = constants.SCROLL_BASIS_POINTS || 10;

    const dynamicFee = Math.ceil((basisPoints / 10000) * totalSats);
    return fixed + (perInput * numInputs) + dynamicFee;
}

export function markUtxoAsUsed(utxoId: string): void {
    const used = JSON.parse(localStorage.getItem(USED_UTXO_KEY) || '[]');
    if (!used.includes(utxoId)) {
        used.push(utxoId);
        localStorage.setItem(USED_UTXO_KEY, JSON.stringify(used));
        console.log(`📝 Marked ${utxoId} as used (Optimistic Update)`);
    }
}

export function isUtxoUsed(utxoId: string): boolean {
    const used = JSON.parse(localStorage.getItem(USED_UTXO_KEY) || '[]');
    return used.includes(utxoId);
}

export function clearUsedUtxos(): void {
    localStorage.removeItem(USED_UTXO_KEY);
    console.log('🧹 Cleared local UTXO tracking');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<any> {
    console.log(`[FETCH] Starting request to: ${url}`);
    console.log(`[FETCH] Timeout: ${timeoutMs}ms`);
    const startTime = Date.now();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[FETCH] ⏰ TIMEOUT triggered after ${Date.now() - startTime}ms`);
        controller.abort();
    }, timeoutMs);
    
    try {
        console.log(`[FETCH] Sending fetch request...`);
        const response = await fetch(url, {
            signal: controller.signal,
            headers: { 'Accept': 'application/json' }
        });
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        console.log(`[FETCH] Response received in ${elapsed}ms, status: ${response.status}`);
        console.log(`[FETCH] Response headers:`, Object.fromEntries(response.headers.entries()));
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        console.log(`[FETCH] Parsing JSON response...`);
        const data = await response.json();
        console.log(`[FETCH] JSON parsed successfully, items: ${Array.isArray(data) ? data.length : 'object'}`);
        return data;
    } catch (error: any) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        console.error(`[FETCH] Error after ${elapsed}ms:`, error.message);
        console.error(`[FETCH] Error type:`, error.name);
        console.error(`[FETCH] Error cause:`, error.cause);
        console.error(`[FETCH] Full error:`, error);
        
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    }
}

async function fetchWithRetry(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS, retries: number = MAX_RETRIES): Promise<any> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`[FETCH] Retry ${attempt}/${retries} after ${delay}ms...`);
                await sleep(delay);
            }
            return await fetchWithTimeout(url, timeoutMs);
        } catch (error: any) {
            lastError = error;
            console.warn(`[FETCH] Attempt ${attempt + 1}/${retries + 1} failed: ${error.message}`);
            if (attempt === retries) {
                throw new Error(`Failed after ${retries + 1} attempts: ${error.message}`);
            }
        }
    }
    throw lastError || new Error('Fetch failed');
}

async function fetchTextWithTimeout(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS): Promise<string> {
    console.log(`[FETCH] Starting text request to: ${url}`);
    console.log(`[FETCH] Timeout: ${timeoutMs}ms`);
    const startTime = Date.now();
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[FETCH] ⏰ TIMEOUT triggered after ${Date.now() - startTime}ms`);
        controller.abort();
    }, timeoutMs);
    
    try {
        console.log(`[FETCH] Sending fetch request...`);
        const response = await fetch(url, {
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        console.log(`[FETCH] Response received in ${elapsed}ms, status: ${response.status}`);
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        console.log(`[FETCH] Reading response text...`);
        const text = await response.text();
        console.log(`[FETCH] Text received, length: ${text.length} bytes`);
        return text;
    } catch (error: any) {
        clearTimeout(timeoutId);
        const elapsed = Date.now() - startTime;
        console.error(`[FETCH] Error after ${elapsed}ms:`, error.message);
        console.error(`[FETCH] Error type:`, error.name);
        
        if (error.name === 'AbortError') {
            throw new Error(`Request timeout after ${timeoutMs}ms`);
        }
        throw error;
    }
}

async function fetchTextWithRetry(url: string, timeoutMs: number = REQUEST_TIMEOUT_MS, retries: number = MAX_RETRIES): Promise<string> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            if (attempt > 0) {
                const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
                console.log(`[FETCH] Retry ${attempt}/${retries} after ${delay}ms...`);
                await sleep(delay);
            }
            return await fetchTextWithTimeout(url, timeoutMs);
        } catch (error: any) {
            lastError = error;
            console.warn(`[FETCH] Attempt ${attempt + 1}/${retries + 1} failed: ${error.message}`);
            if (attempt === retries) {
                throw new Error(`Failed after ${retries + 1} attempts: ${error.message}`);
            }
        }
    }
    throw lastError || new Error('Fetch failed');
}

export async function scanAddressForCharms(address: string) {
  try {
      console.log("[CHARMS SCAN] Initializing WASM...");
      await init();
      console.log("[CHARMS SCAN] WASM initialized");

      console.log(`[CHARMS SCAN] Fetching UTXOs for address: ${address.substring(0, 16)}...`);
      
      let utxos = [];
      try {
          utxos = await fetchWithRetry(`${API_BASE}/api/utxos/${address}`, REQUEST_TIMEOUT_MS);
      } catch (error: any) {
          console.warn(`[CHARMS SCAN] Failed to fetch UTXOs: ${error.message}`);
          console.log('[CHARMS SCAN] Returning empty result (graceful fallback)');
          return [];
      }
      
      console.log(`[CHARMS SCAN] Found ${utxos.length} UTXOs`);

      if (utxos.length === 0) {
          console.log('[CHARMS SCAN] No UTXOs found, returning empty result');
          return [];
      }

      const payrollTokens: any[] = [];

      for (let i = 0; i < utxos.length; i++) {
          const utxo = utxos[i];
          const utxoId = `${utxo.txid}:${utxo.vout}`;
          console.log(`[CHARMS SCAN] Processing UTXO ${i}: txid=${utxo.txid.substring(0, 16)}..., vout=${utxo.vout}, value=${utxo.value}`);

          if (isUtxoUsed(utxoId)) {
              console.log(`[CHARMS SCAN]   UTXO marked as used - skipping`);
              continue;
          }

          try {
              console.log(`[CHARMS SCAN]   Fetching transaction hex from local RPC...`);
              const txHex = await fetchTextWithRetry(`${API_BASE}/api/tx/${utxo.txid}/hex`, REQUEST_TIMEOUT_MS);
              console.log(`[CHARMS SCAN]   Hex length: ${txHex.length}`);

              console.log(`[CHARMS SCAN]   Calling extractAndVerifySpell with mock=true...`);
              const spell = extractAndVerifySpell({ bitcoin: txHex }, true);
              
              if (spell && spell.tx && spell.tx.outs) {
                  console.log(`[CHARMS SCAN]   spell.tx.outs length: ${spell.tx.outs.length}`);
                  console.log(`[CHARMS SCAN]   Checking output at vout ${utxo.vout}:`, spell.tx.outs[utxo.vout]);
                  
                  const charmData = spell.tx.outs[utxo.vout];
                    if (charmData && (charmData["1"] || charmData["0"])) {
                        const amount = charmData["1"] || charmData["0"]?.remaining || 1;
                        console.log(`[CHARMS SCAN]   ✅ Found charm! ${charmData["1"] ? 'token' : 'NFT'}`);
                        payrollTokens.push({
                            utxoId,
                            spell: spell,
                            amount: amount,
                            timestamp: utxo.status?.block_time,
                            validTo: charmData["validTo"] || null
                        });
                    } else {
                        console.log(`[CHARMS SCAN]   No charm at this vout`);
                    }
              }
          } catch (e: any) {
              console.log(`[CHARMS SCAN]   Skipping UTXO ${i}: ${e.message || e}`);
              continue;
          }
      }
      
      console.log(`[CHARMS SCAN] ===== SCAN COMPLETE =====`);
      console.log(`[CHARMS SCAN] Total payroll tokens found: ${payrollTokens.length}`);
      return payrollTokens;
  } catch (error: any) {
      console.error("[CHARMS SCAN] Fatal error:", error.message || error);
      return [];
  }
}

export async function verifyUtxoStatus(utxoId: string): Promise<{ spent: boolean, details: any }> {
    if (!utxoId || utxoId === 'null' || utxoId === 'undefined' || utxoId.trim() === '') {
        console.warn("[UTXO VERIFY] Verification deferred: No valid UTXO ID provided.");
        return { spent: true, details: { error: 'Invalid UTXO ID' } };
    }
    
    const [txid, vout] = utxoId.split(':');
    
    if (!txid || vout === undefined) {
        console.warn(`[UTXO VERIFY] Invalid UTXO ID format: ${utxoId}`);
        return { spent: true, details: { error: 'Invalid UTXO ID format' } };
    }
    
    try {
        const outspendData = await fetchWithRetry(`${API_BASE}/api/utxo/${txid}/${vout}/status`, REQUEST_TIMEOUT_MS);
        const txData = await fetchWithRetry(`${API_BASE}/api/tx/${txid}`, REQUEST_TIMEOUT_MS);
        
        return {
            spent: outspendData.spent || false,
            details: { ...outspendData, txDetails: txData }
        };
    } catch (error: any) {
        console.error(`Failed to verify UTXO ${utxoId}:`, error.message);
        return { spent: true, details: { error: `Verification failed: ${error.message}` } };
    }
}

export async function getWalletStatus(address: string): Promise<{
  totalBalance: number;
  confirmedBalance: number;
  unconfirmedBalance: number;
  totalUtxos: number;
  freshUtxos: number;
  usedUtxos: number;
  unconfirmedUtxos: number;
}> {
  if (!address || address === 'null' || address === 'undefined' || address.trim() === '') {
    console.warn("[WALLET] Scanner deferred: No valid address provided.");
    return {
      totalBalance: 0,
      confirmedBalance: 0,
      unconfirmedBalance: 0,
      totalUtxos: 0,
      freshUtxos: 0,
      usedUtxos: 0,
      unconfirmedUtxos: 0
    };
  }
  
  try {
    console.log(`[WALLET] Fetching UTXOs from local RPC for address: ${address.substring(0, 16)}...`);
    const utxos = await fetchWithRetry(`${API_BASE}/api/utxos/${address}`, REQUEST_TIMEOUT_MS);
    console.log(`[WALLET] Found ${utxos.length} UTXOs`);
    
    const usedUtxos = JSON.parse(localStorage.getItem(USED_UTXO_KEY) || '[]');
    const freshUtxos = utxos.filter((u: any) => !usedUtxos.includes(`${u.txid}:${u.vout}`));
    
    return {
      totalBalance: utxos.reduce((sum: number, u: any) => sum + u.value, 0),
      confirmedBalance: utxos.filter((u: any) => u.status?.confirmed !== false).reduce((sum: number, u: any) => sum + u.value, 0),
      unconfirmedBalance: utxos.filter((u: any) => u.status?.confirmed === false).reduce((sum: number, u: any) => sum + u.value, 0),
      totalUtxos: utxos.length,
      freshUtxos: freshUtxos.length,
      usedUtxos: usedUtxos.length,
      unconfirmedUtxos: utxos.filter((u: any) => u.status?.confirmed === false).length
    };
  } catch (error: any) {
    console.error('[WALLET] Failed to get wallet status:', error);
    return {
      totalBalance: 0,
      confirmedBalance: 0,
      unconfirmedBalance: 0,
      totalUtxos: 0,
      freshUtxos: 0,
      usedUtxos: 0,
      unconfirmedUtxos: 0
    };
  }
}

export async function debugUtxos(address: string): Promise<any> {
  if (!address || address === 'null' || address === 'undefined' || address.trim() === '') {
    console.warn("[DEBUG UTXO] Debug deferred: No valid address provided.");
    return [];
  }
  
  try {
    const utxos = await fetchWithRetry(`${API_BASE}/api/utxos/${address}`, REQUEST_TIMEOUT_MS);
    
    const detailedUtxos = await Promise.all(
      utxos.map(async (utxo: any) => {
        const utxoId = `${utxo.txid}:${utxo.vout}`;
        try {
          const outspend = await fetchWithRetry(`${API_BASE}/api/utxo/${utxo.txid}/${utxo.vout}/status`, REQUEST_TIMEOUT_MS);
          const isUsed = isUtxoUsed(utxoId);
          
          let status = '✅ OK';
          if (isUsed && !outspend.spent) {
            status = '⚠️ POTENTIAL ISSUE';
          } else if (!outspend.spent && isUsed) {
            status = '📝 Tracked but not spent';
          } else if (outspend.spent && !isUsed) {
            status = '🔴 Spent but not tracked';
          }
          
          return {
            ...utxo,
            utxoId,
            spent: outspend.spent || false,
            spentByTxid: outspend.txid,
            locallyTracked: isUsed,
            status: status,
            timestamp: utxo.status?.block_time
          };
        } catch (error) {
          return {
            ...utxo,
            utxoId,
            spent: 'unknown',
            locallyTracked: isUtxoUsed(utxoId),
            status: '❌ Verification failed',
            timestamp: utxo.status?.block_time
          };
        }
      })
    );
    
    console.table(detailedUtxos.map((u: any) => ({
      'UTXO ID': u.utxoId,
      'Value (sats)': u.value,
      'Spent?': u.spent,
      'Spent By TXID': u.spentByTxid?.substring(0, 16) + '...' || 'N/A',
      'Locally Tracked': u.locallyTracked,
      'Timestamp': u.timestamp ? new Date(u.timestamp * 1000).toLocaleDateString() : 'N/A',
      'Status': u.status
    })));
    
    return detailedUtxos;
  } catch (error) {
    console.error('Debug UTXOs failed:', error);
    return [];
  }
}