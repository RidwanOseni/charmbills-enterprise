import initWasm, { extractAndVerifySpell } from "./wasm/charms_lib";
import axios from 'axios';
import * as constants from '../shared/constants';

const MEMPOOL_API = "https://mempool.space/testnet4/api";
const PROTOCOL_VERSION = 8; 
const USED_UTXO_KEY = 'charm_used_utxos';

/**
 * ADDITION: Calculates required fees for Scroll-enabled transactions.
 * Essential for providing "Transaction Fee Information" in the worker dashboard [3].
 */
export function calculateScrollFee(numInputs: number, totalSats: number): number {
    const fixed = constants.SCROLL_FIXED_COST || 895;
    const perInput = constants.SCROLL_FEE_PER_INPUT || 64;
    const basisPoints = constants.SCROLL_BASIS_POINTS || 10; // 0.1%

    const dynamicFee = Math.ceil((basisPoints / 10000) * totalSats);
    return fixed + (perInput * numInputs) + dynamicFee;
}

/**
 * KEPT FOR FRONTEND: Marks a UTXO as used in localStorage.
 * Enables Optimistic UI so worker tokens don't appear "spendable" during block latency [1, 2].
 */
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

/**
 * MODIFIED: Scans addresses for "Proof of Hire" tokens and includes on-chain timestamps.
 * Uses trustless verification to provide worker sovereignty [8, 9].
 */
export async function scanAddressForCharms(address: string) {
    try {
        // PROFESSIONAL FIX: Initialize the v12 WASM module correctly [6, 7]
        await initWasm();

        // FIX: Validate address before API call [19]
        if (!address || address === 'null' || address === 'undefined' || address.trim() === '') {
            console.warn("[CHARMS SCAN] Scanner deferred: No valid address provided.");
            return [];
        }

        const utxoResponse = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
        const utxos = utxoResponse.data;
        const charmsAssets = [];

        for (const utxo of utxos) {
            const utxoId = `${utxo.txid}:${utxo.vout}`;
            
            // Skip if already spent or in-flight in the UI
            if (isUtxoUsed(utxoId)) continue;

            try {
                const txHexResponse = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/hex`);
                const txJson = { bitcoin: txHexResponse.data };

                // Extract spell data from the transaction hex using v12 WASM [9]
                const spellData = extractAndVerifySpell(txJson, false);

                if (spellData && spellData.tx) {
                    const outputCharms = spellData.tx.outs[utxo.vout];
                    
                    // Robust check for Maps or Objects (CHIP-420 support) [10]
                    if (outputCharms && (typeof outputCharms.size === 'number' || Object.keys(outputCharms).length > 0)) {
                        charmsAssets.push({
                            utxoId,
                            amount: utxo.value,
                            spell: spellData,
                            charms: outputCharms,
                            // PRODUCTION FIX: Capture the block_time (Unix seconds) [1]
                            timestamp: utxo.status?.block_time 
                        });
                    }
                }
            } catch (e: any) {
                // Ignore non-charm UTXOs to keep the console clean
                continue;
            }
        }
        return charmsAssets;
    } catch (error) {
        console.error("Trustless scan failed:", error);
        return [];
    }
}

/**
 * Manual verification of UTXO status - Kept for debugging worker claims.
 * FIX: Added address validation and proper error handling [19]
 */
export async function verifyUtxoStatus(utxoId: string): Promise<{ spent: boolean, details: any }> {
    // FIX: Validate UTXO ID before API call [19]
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
        const outspendResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/outspend/${vout}`, {
            timeout: 10000
        });
        const txResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}`, {
            timeout: 10000
        });
        
        return {
            spent: outspendResponse.data.spent,
            details: { ...outspendResponse.data, txDetails: txResponse.data }
        };
    } catch (error: any) {
        console.error(`Failed to verify UTXO ${utxoId}:`, error.message);
        return { spent: true, details: { error: `Verification failed: ${error.message}` } };
    }
}

/**
 * Helper function to provide user-friendly wallet status - Kept for frontend dashboard
 * FIX: Added address validation to prevent invalid API calls [19]
 */
export async function getWalletStatus(address: string): Promise<{
  totalBalance: number;
  confirmedBalance: number;
  unconfirmedBalance: number;
  totalUtxos: number;
  freshUtxos: number;
  usedUtxos: number;
  unconfirmedUtxos: number;
}> {
  // FIX: Validate address before API call - prevents Axios 400 errors [19]
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
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 10000
    });
    const utxos = response.data;
    
    const usedUtxos = JSON.parse(localStorage.getItem(USED_UTXO_KEY) || '[]');
    const freshUtxos = utxos.filter((u: any) => !usedUtxos.includes(`${u.txid}:${u.vout}`));
    
    return {
      totalBalance: utxos.reduce((sum: number, u: any) => sum + u.value, 0),
      confirmedBalance: utxos.filter((u: any) => u.status?.confirmed).reduce((sum: number, u: any) => sum + u.value, 0),
      unconfirmedBalance: utxos.filter((u: any) => !u.status?.confirmed).reduce((sum: number, u: any) => sum + u.value, 0),
      totalUtxos: utxos.length,
      freshUtxos: freshUtxos.length,
      usedUtxos: usedUtxos.length,
      unconfirmedUtxos: utxos.filter((u: any) => !u.status?.confirmed).length
    };
  } catch (error: any) {
    console.error('Failed to get wallet status:', error);
    // Return zeroed stats instead of throwing to prevent UI crashes
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

/**
 * DEBUG: Check all UTXOs for an address with spent status - Kept for frontend debugging
 * FIX: Added address validation [19]
 */
export async function debugUtxos(address: string): Promise<any> {
  // FIX: Validate address before API call [19]
  if (!address || address === 'null' || address === 'undefined' || address.trim() === '') {
    console.warn("[DEBUG UTXO] Debug deferred: No valid address provided.");
    return [];
  }
  
  try {
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 10000
    });
    const utxos = response.data;
    
    const detailedUtxos = await Promise.all(
      utxos.map(async (utxo: any) => {
        const utxoId = `${utxo.txid}:${utxo.vout}`;
        try {
          const outspend = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/outspend/${utxo.vout}`, {
            timeout: 5000
          });
          const isUsed = isUtxoUsed(utxoId);
          
          // Determine status based on conditions
          let status = '✅ OK';
          if (isUsed && !outspend.data.spent) {
            status = '⚠️ POTENTIAL ISSUE';
          } else if (!outspend.data.spent && isUsed) {
            status = '📝 Tracked but not spent';
          } else if (outspend.data.spent && !isUsed) {
            status = '🔴 Spent but not tracked';
          }
          
          return {
            ...utxo,
            utxoId,
            spent: outspend.data.spent,
            spentByTxid: outspend.data.txid,
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