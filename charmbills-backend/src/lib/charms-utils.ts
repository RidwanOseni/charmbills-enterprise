import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import * as constants from '@shared/constants';

// 1. USE REQUIRE: This is the most stable way for Node to load wasm-bindgen modules
// Avoids import collision issues between default and named exports
const CharmsLib = require("../charms/wasm/charms_lib");

const MEMPOOL_API = "https://mempool.space/testnet4/api";
const PROTOCOL_VERSION = 11;

// Flag to track WASM bridge initialization status
let wasmBridgeInitialized = false;

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
 * Robust initialization for the WASM bridge.
 * Node.js 'target nodejs' builds initialize automatically on require.
 * Fallback for 'bundler' target builds that need manual initialization.
 * 
 * @returns Promise<void>
 */
export async function initializeWasmBridge(): Promise<void> {
    if (wasmBridgeInitialized) {
        console.log("✅ Charms JS Bridge already initialized");
        return;
    }

    try {
        // 2. Node.js 'target nodejs' builds initialize automatically on require.
        // We simply verify the required function exists on the export object.
        if (typeof CharmsLib.process_spell_template === 'function') {
            wasmBridgeInitialized = true;
            console.log("✅ Charms JS Bridge active (Auto-initialized)");
            return;
        }

        // 3. FALLBACK: If using a 'bundler' target build
        if (typeof CharmsLib.default === 'function') {
            const wasmPath = path.resolve(process.cwd(), 'src/charms/wasm/charms_lib_bg.wasm');
            
            if (!fs.existsSync(wasmPath)) {
                throw new Error(`WASM file not found at: ${wasmPath}`);
            }
            
            const wasmBuffer = fs.readFileSync(wasmPath);
            await CharmsLib.default(wasmBuffer);
            wasmBridgeInitialized = true;
            console.log("✅ Charms JS Bridge initialized manually with buffer");
            return;
        }

        throw new Error("process_spell_template not found in exports. Ensure WASM was built with --features wasm-bridge.");
    } catch (error: any) {
        console.error("❌ Charms JS Bridge initialization failed:", error.message);
        throw error;
    }
}

/**
 * DYNAMIC WRAPPER: Resolves the "Captured Undefined" bug
 * This function looks up the Rust symbol on the namespace AT CALL TIME,
 * ensuring it isn't undefined even if called after initialization.
 * 
 * @param templateYaml - The YAML template string
 * @param variablesJson - JSON string of variables to substitute
 * @returns The processed spell result
 */
export function process_spell_template(templateYaml: string, variablesJson: string): string {
    if (!wasmBridgeInitialized) {
        throw new Error("WASM Bridge not initialized. Call initializeWasmBridge() first.");
    }
    
    const fn = CharmsLib.process_spell_template;
    if (typeof fn !== 'function') {
        throw new Error("process_spell_template not found on CharmsLib namespace after initialization.");
    }
    
    return fn(templateYaml, variablesJson);
}

/**
 * Process a spell template with variables using the WASM bridge.
 * This is an alias for process_spell_template for backward compatibility.
 * 
 * @param templateYaml - The YAML template string
 * @param variablesJson - JSON string of variables to substitute
 * @returns The processed spell result
 */
export function processSpellTemplate(templateYaml: string, variablesJson: string): string {
    return process_spell_template(templateYaml, variablesJson);
}

// Re-export extractAndVerifySpell for the scanner from the same WASM module
export const extractAndVerifySpell = CharmsLib.extractAndVerifySpell;

// Export the bridge namespace for advanced use cases
export { CharmsLib };

/**
 * MODIFICATION: Scans addresses for Charms using v12 WASM initialization.
 * Focuses purely on trustless verification of existing tokens.
 * Uses the same WASM module (no separate import needed)
 */
export async function scanAddressForCharms(address: string) {
    try {
        // Ensure WASM bridge is initialized (extractAndVerifySpell may need it)
        await initializeWasmBridge();

        const utxoResponse = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`);
        const utxos = utxoResponse.data;
        const charmsAssets = [];

        for (const utxo of utxos) {
            try {
                const txHexResponse = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/hex`);
                const txJson = { bitcoin: txHexResponse.data };

                // Extract spell data from the transaction hex
                const spellData = extractAndVerifySpell(txJson, false);

                if (spellData && spellData.tx) {
                    const outputCharms = spellData.tx.outs[utxo.vout];
                    
                    // Check for valid Charms maps or objects
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
                // Ignore non-charm UTXOs to minimize console noise
                continue;
            }
        }
        return charmsAssets;
    } catch (error) {
        console.error("Scan failed:", error);
        return [];
    }
}

// REMOVED: markUtxoAsUsed, isUtxoUsed, getFundingUtxo, clearUsedUtxos, 
// getWalletStatus, debugUtxos - Use utxo-manager.ts for backend selection logic

/**
 * Manual verification of UTXO status using mempool.space API
 * FIX: Throws error on API failure instead of returning false positive
 * 
 * @param utxoId - UTXO ID in format "txid:vout"
 * @returns Object containing spent status and transaction details
 * @throws Error if API request fails
 */
export async function verifyUtxoStatus(utxoId: string): Promise<{ spent: boolean, details: any }> {
  const [txid, vout] = utxoId.split(':');
  
  if (!txid || vout === undefined) {
    throw new Error(`Invalid UTXO ID format: ${utxoId}. Expected "txid:vout"`);
  }
  
  try {
    // Try the outspend endpoint first (most accurate)
    const outspendResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}/outspend/${vout}`, {
      timeout: 30000 // 10 second timeout
    });
    const spentStatus = outspendResponse.data;
    
    // Also get the full transaction to see confirmations
    const txResponse = await axios.get(`${MEMPOOL_API}/tx/${txid}`, {
      timeout: 30000
    });
    const txDetails = txResponse.data;
    
    const isSpent = spentStatus.spent === true;
    const isConfirmed = txDetails.status?.confirmed === true;
    
    console.log(`🔍 UTXO ${utxoId} verification:`, {
      spent: isSpent,
      spentBy: spentStatus.txid || 'Not spent yet',
      confirmed: isConfirmed,
      blockHeight: txDetails.status?.block_height,
      confirmations: txDetails.status?.confirmations || 0
    });
    
    return {
      spent: isSpent,
      details: { ...spentStatus, txDetails }
    };
    
  } catch (error: any) {
    console.error(`Failed to verify UTXO ${utxoId}:`, error.message);
    
    // Throw error instead of returning false positive
    if (axios.isAxiosError(error)) {
      if (error.response?.status === 404) {
        throw new Error(`UTXO ${utxoId} not found on chain`);
      }
      if (error.code === 'ECONNABORTED') {
        throw new Error(`UTXO verification timeout for ${utxoId}`);
      }
      throw new Error(`UTXO verification failed: ${error.message}`);
    }
    
    throw error;
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
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 30000
    });
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
    const response = await axios.get(`${MEMPOOL_API}/address/${address}/utxo`, {
      timeout: 30000
    });
    const utxos = response.data;
    
    const detailedUtxos = await Promise.all(
      utxos.map(async (utxo: any) => {
        const utxoId = `${utxo.txid}:${utxo.vout}`;
        try {
          const outspend = await axios.get(`${MEMPOOL_API}/tx/${utxo.txid}/outspend/${utxo.vout}`, {
            timeout: 5000
          });
          
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