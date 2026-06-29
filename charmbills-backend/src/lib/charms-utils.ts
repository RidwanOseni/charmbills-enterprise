import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import * as constants from '@shared/constants';

// RPC Configuration
const RPC_HOST = process.env.RPC_HOST || '127.0.0.1';
const RPC_PORT = process.env.RPC_PORT || '48332';
const RPC_URL = `http://${RPC_HOST}:${RPC_PORT}`;
const RPC_AUTH = process.env.RPC_USER && process.env.RPC_PASSWORD
  ? Buffer.from(`${process.env.RPC_USER}:${process.env.RPC_PASSWORD}`).toString('base64')
  : '';

// 1. USE REQUIRE: This is the most stable way for Node to load wasm-bindgen modules
const CharmsLib = require("../charms/wasm/charms_lib");

const PROTOCOL_VERSION = 15;

let wasmBridgeInitialized = false;

export function calculateScrollFee(numInputs: number, totalSats: number): number {
    const fixed = constants.SCROLL_FIXED_COST || 895;
    const perInput = constants.SCROLL_FEE_PER_INPUT || 64;
    const basisPoints = constants.SCROLL_BASIS_POINTS || 10;

    const dynamicFee = Math.ceil((basisPoints / 10000) * totalSats);
    return fixed + (perInput * numInputs) + dynamicFee;
}

export async function initializeWasmBridge(): Promise<void> {
    if (wasmBridgeInitialized) {
        console.log("✅ Charms JS Bridge already initialized");
        return;
    }

    try {
        if (typeof CharmsLib.process_spell_template === 'function') {
            wasmBridgeInitialized = true;
            console.log("✅ Charms JS Bridge active (Auto-initialized)");
            return;
        }

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

export function processSpellTemplate(templateYaml: string, variablesJson: string): string {
    return process_spell_template(templateYaml, variablesJson);
}

export const extractAndVerifySpell = CharmsLib.extractAndVerifySpell;
export { CharmsLib };

async function rpcCall(method: string, params: any[]): Promise<any> {
    try {
        const response = await axios.post(
            RPC_URL,
            {
                jsonrpc: '1.0',
                id: 'charms-utils-' + Date.now(),
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
            throw new Error(`RPC call failed: ${error.message}`);
        }
        throw error;
    }
}

export async function scanAddressForCharms(address: string) {
    try {
        await initializeWasmBridge();

        const result = await rpcCall('scantxoutset', [
            'start',
            [`addr(${address})`]
        ]);

        if (!result || !result.unspents || !Array.isArray(result.unspents)) {
            return [];
        }

        const charmsAssets = [];

        for (const utxo of result.unspents) {
            try {
                const txHex = await rpcCall('getrawtransaction', [utxo.txid]);
                const txJson = { bitcoin: txHex };

                const spellData = extractAndVerifySpell(txJson, false);

                if (spellData && spellData.tx) {
                    const outputCharms = spellData.tx.outs[utxo.vout];
                    
                    if (outputCharms && (typeof outputCharms.size === 'number' || Object.keys(outputCharms).length > 0)) {
                        charmsAssets.push({
                            utxoId: `${utxo.txid}:${utxo.vout}`,
                            amount: Math.round(utxo.amount * 100000000),
                            spell: spellData,
                            charms: outputCharms
                        });
                    }
                }
            } catch (e: any) {
                continue;
            }
        }
        return charmsAssets;
    } catch (error) {
        console.error("Scan failed:", error);
        return [];
    }
}

export async function verifyUtxoStatus(utxoId: string): Promise<{ spent: boolean, confirmed: boolean, details: any }> {
    const [txid, voutStr] = utxoId.split(':');
    
    if (!txid || voutStr === undefined) {
        throw new Error(`Invalid UTXO ID format: ${utxoId}. Expected "txid:vout"`);
    }
    
    const vout = parseInt(voutStr, 10);
    
    try {
        console.log(`[CHARMS UTILS] Verifying UTXO ${txid.substring(0, 8)}:${vout} via Local RPC...`);
        
        const result = await rpcCall('gettxout', [txid, vout]);
        
        if (result === null) {
            console.log(`[CHARMS UTILS] UTXO ${utxoId} is spent or invalid.`);
            return { spent: true, confirmed: false, details: { error: 'UTXO not found or spent' } };
        }

        const confirmations = result.confirmations || 0;
        const isConfirmed = confirmations > 0;

        console.log(`[CHARMS UTILS] UTXO ${utxoId}: spent=false, confirmed=${isConfirmed} (${confirmations} confs)`);

        return {
            spent: false,
            confirmed: isConfirmed,
            details: result
        };

    } catch (error: any) {
        console.error(`[CHARMS UTILS] Failed to verify UTXO ${utxoId}:`, error.message);
        throw new Error(`UTXO verification failed: ${error.message}`);
    }
}

export async function getWalletStatus(address: string): Promise<{
    totalBalance: number;
    confirmedBalance: number;
    unconfirmedBalance: number;
    totalUtxos: number;
    unconfirmedUtxos: number;
}> {
    try {
        const result = await rpcCall('scantxoutset', [
            'start',
            [`addr(${address})`]
        ]);

        const utxos = result?.unspents || [];
        const confirmedUtxos = utxos.filter((u: any) => u.height && u.height > 0);
        const unconfirmedUtxos = utxos.filter((u: any) => !u.height || u.height === 0);
        
        const totalBalance = utxos.reduce((sum: number, u: any) => sum + Math.round(u.amount * 100000000), 0);
        const confirmedBalance = confirmedUtxos.reduce((sum: number, u: any) => sum + Math.round(u.amount * 100000000), 0);
        const unconfirmedBalance = unconfirmedUtxos.reduce((sum: number, u: any) => sum + Math.round(u.amount * 100000000), 0);

        return {
            totalBalance,
            confirmedBalance,
            unconfirmedBalance,
            totalUtxos: utxos.length,
            unconfirmedUtxos: unconfirmedUtxos.length
        };
    } catch (error: any) {
        console.error('Failed to get wallet status:', error);
        throw new Error(`Unable to fetch wallet status: ${error.message}`);
    }
}

export async function debugUtxos(address: string): Promise<any> {
    try {
        const result = await rpcCall('scantxoutset', [
            'start',
            [`addr(${address})`]
        ]);

        const utxos = result?.unspents || [];
        
        const detailedUtxos = await Promise.all(
            utxos.map(async (utxo: any) => {
                const utxoId = `${utxo.txid}:${utxo.vout}`;
                try {
                    const txOut = await rpcCall('gettxout', [utxo.txid, utxo.vout]);
                    
                    return {
                        txid: utxo.txid,
                        vout: utxo.vout,
                        value: Math.round(utxo.amount * 100000000),
                        utxoId,
                        spent: txOut === null,
                        status: txOut === null ? 'Spent' : 'Available',
                        height: utxo.height || 'unconfirmed'
                    };
                } catch (error) {
                    return {
                        txid: utxo.txid,
                        vout: utxo.vout,
                        value: Math.round(utxo.amount * 100000000),
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
            'Status': u.status,
            'Height': u.height
        })));
        
        return detailedUtxos;
    } catch (error) {
        console.error('Debug UTXOs failed:', error);
        return [];
    }
}