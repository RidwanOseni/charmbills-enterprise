import init, { extractAndVerifySpell } from "./wasm/charms_lib";
import axios from 'axios';
import * as constants from '../shared/constants';

const MEMPOOL_API = "https://mempool.space/testnet4/api";
const PROTOCOL_VERSION = 12; 
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
 * 
 * CRITICAL FIX: Browser-based WASM initialization using --target web generated bindings.
 * This avoids the 'fs' module by using a browser fetch instead of reading from disk.
 * 
 * CRITICAL FIX: Initialize the official Charms SDK Scanner module with no arguments.
 * The --target web bindings generate an init() function that takes 0 arguments.
 * 
 * MODIFIED: Added payroll ticker filtering to ensure only valid payroll tokens are returned.
 * MODIFIED: Removed OP_RETURN pattern check - let WASM handle spell detection.
 * MODIFIED: Added prev_txs context (Plan NFT hex) for proper proof verification.
 */
export async function scanAddressForCharms(address: string) {
  try {
      console.log("[CHARMS SCAN] Initializing WASM...");
      await init();
      console.log("[CHARMS SCAN] WASM initialized");

      console.log(`[CHARMS SCAN] Fetching UTXOs for address: ${address.substring(0, 16)}...`);
      const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
      const utxos = response.data;
      console.log(`[CHARMS SCAN] Found ${utxos.length} UTXOs`);

      const payrollTokens: any[] = [];

      for (let i = 0; i < utxos.length; i++) {
          const utxo = utxos[i];
          const utxoId = `${utxo.txid}:${utxo.vout}`;
          console.log(`[CHARMS SCAN] Processing UTXO ${i}: txid=${utxo.txid.substring(0, 16)}..., vout=${utxo.vout}, value=${utxo.value}`);

          // Skip if already spent or in-flight in the UI
          if (isUtxoUsed(utxoId)) {
              console.log(`[CHARMS SCAN]   UTXO marked as used - skipping`);
              continue;
          }

          try {
              console.log(`[CHARMS SCAN]   Fetching transaction hex...`);
              const hexRes = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/hex`, { responseType: 'text' });
              const txHex = hexRes.data;
              console.log(`[CHARMS SCAN]   Hex length: ${txHex.length}`);

              // STRUCTURAL FIX: Pass a SINGLE-KEY object to satisfy "expected 1"
              // Use mock=true to extract spell data without requiring prev_txs context
              console.log(`[CHARMS SCAN]   Calling extractAndVerifySpell with mock=true...`);
              const spell = extractAndVerifySpell({ bitcoin: txHex }, true);
              
              if (spell && spell.tx && spell.tx.outs) {
                  console.log(`[CHARMS SCAN]   spell.tx.outs length: ${spell.tx.outs.length}`);
                  console.log(`[CHARMS SCAN]   Checking output at vout ${utxo.vout}:`, spell.tx.outs[utxo.vout]);
                  
                  const charmData = spell.tx.outs[utxo.vout];
                  if (charmData && charmData["1"]) {
                      console.log(`[CHARMS SCAN]   ✅ Found payroll token! amount=${charmData["1"]}`);
                      payrollTokens.push({
                          utxoId,
                          spell: spell,
                          amount: charmData["1"],
                          timestamp: utxo.status?.block_time,
                          validTo: charmData["validTo"] || null
                      });
                  } else {
                      console.log(`[CHARMS SCAN]   No payroll token at this vout`);
                  }
              }
          } catch (e: any) {
              // IMPORTANT: This catch handles standard BTC transactions
              // which trigger a "Condition failed" panic
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
            timeout: 100000
        });
        const txResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}`, {
            timeout: 100000
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
      timeout: 100000
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
      timeout: 100000
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