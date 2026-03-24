import initWasm, { extractAndVerifySpell } from "@wasm/charms_lib";
import axios from 'axios';
import * as constants from '@shared/constants';

const MEMPOOL_API = "https://mempool.space/testnet4/api";
const PROTOCOL_VERSION = 11; 

/**
 * ADDITION: Calculates required fees for Scroll-enabled transactions.
 * Formula: fixed_cost + (fee_per_input * num_inputs) + (basis_points/10000 * total_sats) [3]
 */
export function calculateScrollFee(numInputs: number, totalSats: number): number {
    const fixed = constants.SCROLL_FIXED_COST || 895;
    const perInput = constants.SCROLL_FEE_PER_INPUT || 64;
    const basisPoints = constants.SCROLL_BASIS_POINTS || 10; // 0.1%

    const dynamicFee = Math.ceil((basisPoints / 10000) * totalSats);
    return fixed + (perInput * numInputs) + dynamicFee;
}

/**
 * MODIFICATION: Scans addresses for Charms using v12 WASM initialization.
 * Focuses purely on trustless verification of existing tokens.
 */
export async function scanAddressForCharms(address: string) {
    try {
        // Initialize WASM module for extraction 
        await initWasm();

        const utxoResponse = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
        const utxos = utxoResponse.data;
        const charmsAssets = [];

        for (const utxo of utxos) {
            try {
                const txHexResponse = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/hex`);
                const txJson = { bitcoin: txHexResponse.data };

                // Extract spell data from the transaction hex [7, 8]
                const spellData = extractAndVerifySpell(txJson, false);

                if (spellData && spellData.tx) {
                    const outputCharms = spellData.tx.outs[utxo.vout];
                    
                    // Check for valid Charms maps or objects [9]
                    if (outputCharms && (typeof outputCharms.size === 'number' || Object.keys(outputCharms).length > 0)) {
                        charmsAssets.push({
                            utxoId: `${utxo.txid}:${utxo.vout}`,
                            amount: utxo.value,
                            spell: spellData,
                            charms: outputCharms
                        });
                    }
                }
            } catch (e: any) {
                // Ignore non-charm UTXOs to minimize console noise [10]
                continue;
            }
        }
        return charmsAssets;
    } catch (error) {
        console.error("Scan failed:", error);
        return [];
    }
}

// REMOVED: markUtxoAsUsed, isUtxoUsed, getFundingUtxo, clearUsedUtxos, verifyUtxoStatus, 
// getWalletStatus, debugUtxos - Use utxo-manager.ts for backend selection logic

/**
 * Manual verification of UTXO status using mempool.space API
 * Useful for debugging - KEPT for frontend debugging purposes
 */
export async function verifyUtxoStatus(utxoId: string): Promise<{ spent: boolean, details: any }> {
  const [txid, vout] = utxoId.split(':');
  try {
    // Try the outspend endpoint first (most accurate)
    const outspendResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/outspend/${vout}`);
    const spentStatus = outspendResponse.data;
    
    // Also get the full transaction to see confirmations
    const txResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}`);
    const txDetails = txResponse.data;
    
    console.log(`🔍 UTXO ${utxoId} verification:`, {
      spent: spentStatus.spent,
      spentBy: spentStatus.txid || 'Not spent yet',
      confirmed: txDetails.status?.confirmed || false,
      blockHeight: txDetails.status?.block_height,
      confirmations: txDetails.status?.confirmations || 0
    });
    
    return {
      spent: spentStatus.spent,
      details: { ...spentStatus, txDetails }
    };
  } catch (error) {
    console.error(`Failed to verify UTXO ${utxoId}:`, error);
    return { spent: true, details: { error: 'Verification failed' } };
  }
}

/**
 * Helper function to provide user-friendly wallet status - KEPT for frontend use
 */
export async function getWalletStatus(address: string): Promise<{
  totalBalance: number;
  confirmedBalance: number;
  unconfirmedBalance: number;
  totalUtxos: number;
  unconfirmedUtxos: number;
}> {
  try {
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
    const utxos = response.data;
    
    return {
      totalBalance: utxos.reduce((sum: number, u: any) => sum + u.value, 0),
      confirmedBalance: utxos.filter((u: any) => u.status?.confirmed).reduce((sum: number, u: any) => sum + u.value, 0),
      unconfirmedBalance: utxos.filter((u: any) => !u.status?.confirmed).reduce((sum: number, u: any) => sum + u.value, 0),
      totalUtxos: utxos.length,
      unconfirmedUtxos: utxos.filter((u: any) => !u.status?.confirmed).length
    };
  } catch (error: any) {
    console.error('Failed to get wallet status:', error);
    throw new Error(`Unable to fetch wallet status: ${error.message}`);
  }
}

/**
 * DEBUG: Check all UTXOs for an address with spent status - KEPT for frontend debugging
 */
export async function debugUtxos(address: string): Promise<any> {
  try {
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
    const utxos = response.data;
    
    const detailedUtxos = await Promise.all(
      utxos.map(async (utxo: any) => {
        const utxoId = `${utxo.txid}:${utxo.vout}`;
        try {
          const outspend = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/outspend/${utxo.vout}`);
          
          return {
            ...utxo,
            utxoId,
            spent: outspend.data.spent,
            spentByTxid: outspend.data.txid,
            status: outspend.data.spent ? 'Spent' : 'Available'
          };
        } catch (error) {
          return {
            ...utxo,
            utxoId,
            spent: 'unknown',
            status: 'Verification failed'
          };
        }
      })
    );
    
    console.table(detailedUtxos.map((u: any) => ({
      'UTXO ID': u.utxoId,
      'Value (sats)': u.value,
      'Spent?': u.spent,
      'Spent By TXID': u.spentByTxid?.substring(0, 16) + '...' || 'N/A',
      'Status': u.status
    })));
    
    return detailedUtxos;
  } catch (error) {
    console.error('Debug UTXOs failed:', error);
    return [];
  }
}

// REMOVED: clearUsedUtxos function - Use utxo-manager.ts instead