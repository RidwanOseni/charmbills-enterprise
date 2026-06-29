import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { encode } from 'cbor-x';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import * as engine from './wasm/subscription-engine';
import { buildMintNFTVarsWithTemplate } from './buildMintNFT';
import { buildMintTokenVars } from './buildMintToken';
import { buildScrollReleaseVars } from './buildScrollRelease';
import { fetchTransactionHex } from '../lib/utxo-manager';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import * as crypto from 'crypto';

bitcoin.initEccLib(ecc);

const PROVER_URL = process.env.PROVER_API_URL || constants.PROVER_API_URL;
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const PROVER_TIMEOUT_MS = 500000;

const ENGINE_DIR = path.resolve(process.cwd(), '../subscription-engine');
const WASM_PATH = path.join(ENGINE_DIR, 'target/wasm32-wasip1/release/subscription-engine.wasm');
const SIG_PATH = path.join(ENGINE_DIR, 'target/wasm32-wasip1/release/subscription-engine.wasm.sig.yaml');
const KEY_PATH = path.join(ENGINE_DIR, '.charms/app-key.json');

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateBackoff(retryCount: number): number {
    const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
    const jitter = Math.random() * 1000;
    return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

function extractTxHexFromJson(responseData: any, index: number): string {
    try {
        console.log(`[PAYROLL PROVER] extractTxHexFromJson: response type=${typeof responseData}, isArray=${Array.isArray(responseData)}`);
        
        if (Array.isArray(responseData)) {
            const tx = responseData.length === 1 ? responseData[0] : responseData[index];
            if (!tx) {
                throw new Error(`Prover response missing transaction at index ${index}`);
            }
            if (typeof tx === 'object' && tx !== null && tx.bitcoin && typeof tx.bitcoin === 'string') {
                console.log(`[PAYROLL PROVER] extractTxHexFromJson: found bitcoin property, length=${tx.bitcoin.length}`);
                return tx.bitcoin;
            }
            if (typeof tx === 'string') {
                console.log(`[PAYROLL PROVER] extractTxHexFromJson: direct string, length=${tx.length}`);
                return tx;
            }
            if (typeof tx === 'object' && tx !== null && tx.hex && typeof tx.hex === 'string') {
                console.log(`[PAYROLL PROVER] extractTxHexFromJson: found hex property, length=${tx.hex.length}`);
                return tx.hex;
            }
            throw new Error(`Unexpected transaction shape: ${JSON.stringify(tx).substring(0, 100)}`);
        }
        
        if (typeof responseData === 'object' && responseData !== null) {
            if (responseData.bitcoin && typeof responseData.bitcoin === 'string') {
                console.log(`[PAYROLL PROVER] extractTxHexFromJson: direct object with bitcoin, length=${responseData.bitcoin.length}`);
                return responseData.bitcoin;
            }
            if (responseData.hex && typeof responseData.hex === 'string') {
                console.log(`[PAYROLL PROVER] extractTxHexFromJson: direct object with hex, length=${responseData.hex.length}`);
                return responseData.hex;
            }
        }
        
        if (typeof responseData === 'string') {
            console.log(`[PAYROLL PROVER] extractTxHexFromJson: string response, length=${responseData.length}`);
            return responseData;
        }
        
        throw new Error(`Unexpected response format: ${typeof responseData}`);
    } catch (error) {
        console.error('[PAYROLL PROVER] Failed to decode JSON response:', error);
        throw new Error(`Failed to decode prover response: ${error}`);
    }
}

function deriveAppId(utxoId: string): string {
    if (!utxoId || typeof utxoId !== 'string') {
        throw new Error('Invalid utxoId: must be non-empty string');
    }
    return crypto.createHash('sha256').update(utxoId).digest('hex');
}

function utxoTo36Bytes(utxoId: string): Uint8Array {
    const parts = utxoId.split(':');
    if (parts.length !== 2) {
        throw new Error(`Invalid UTXO ID format: ${utxoId}. Expected "txid:vout"`);
    }
    
    const txidHex = parts[0];
    const vout = parseInt(parts[1], 10);
    
    if (isNaN(vout)) {
        throw new Error(`Invalid vout in UTXO ID: ${utxoId}`);
    }
    
    const txidBytes = hexToBytes(txidHex);
    const reversedTxid = txidBytes.reverse();
    
    const voutBuffer = Buffer.allocUnsafe(4);
    voutBuffer.writeUInt32LE(vout, 0);
    const voutBytes = new Uint8Array(voutBuffer);
    
    const result = new Uint8Array(36);
    result.set(reversedTxid, 0);
    result.set(voutBytes, 32);
    
    console.log(`[PAYROLL PROVER] DEBUG - UTXO conversion: ${utxoId} -> reversed txid bytes (${reversedTxid.length}), vout bytes (${voutBytes.length})`);
    
    return result;
}

function utxoIdToHexWitness(utxoId: string): string {
    const witnessCbor = encode(utxoId);
    return bytesToHex(witnessCbor);
}

function addressToHexDest(address: string): string {
    try {
        const script = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
        return Buffer.from(script).toString('hex');
    } catch (error: any) {
        console.error(`[PAYROLL PROVER] Failed to convert address to hex: ${address}`, error.message);
        if (/^[0-9a-f]+$/i.test(address)) {
            console.log('[PAYROLL PROVER] Address appears to be already hex, using as-is');
            return address;
        }
        throw new Error(`Invalid address format: ${address}`);
    }
}

let wasmBufferCache: Buffer | null = null;

function getWasmBuffer(): Buffer {
    if (wasmBufferCache) {
        return wasmBufferCache;
    }
    
    console.log(`[PAYROLL PROVER] Loading WASM from: ${WASM_PATH}`);
    
    if (!fs.existsSync(WASM_PATH)) {
        throw new Error(`CRITICAL: WASM binary not found at ${WASM_PATH}. Run 'cargo build' in subscription-engine.`);
    }
    
    wasmBufferCache = fs.readFileSync(WASM_PATH);
    console.log(`[PAYROLL PROVER] WASM loaded: ${wasmBufferCache.length} bytes`);
    
    return wasmBufferCache;
}

function getWasmBase64(): string {
    const wasmBuffer = getWasmBuffer();
    return wasmBuffer.toString('base64');
}

function getWasmHash(): string {
    const wasmBuffer = getWasmBuffer();
    return crypto.createHash('sha256').update(wasmBuffer).digest('hex');
}

function getWasmSignature(): Record<string, any> | null {
    console.log(`[PAYROLL PROVER] Loading signature from: ${SIG_PATH}`);
    
    if (!fs.existsSync(SIG_PATH)) {
        console.warn(`[PAYROLL PROVER] WARNING: Signature file not found at ${SIG_PATH}`);
        console.warn('[PAYROLL PROVER] This is required for versioned apps in v15');
        return null;
    }
    
    try {
        const rawContent = fs.readFileSync(SIG_PATH, 'utf8').trim();
        console.log(`[PAYROLL PROVER] Raw signature content length: ${rawContent.length}`);
        
        let signatureHex: string | null = null;
        const lines = rawContent.split('\n');
        
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            
            if (trimmed.includes(':')) {
                const colonIndex = trimmed.indexOf(':');
                const value = trimmed.substring(colonIndex + 1).trim();
                if (value.length === 128 && /^[a-f0-9]+$/i.test(value)) {
                    signatureHex = value;
                    console.log(`[PAYROLL PROVER] Extracted signature hex (128 chars) from YAML`);
                    break;
                }
            }
        }
        
        if (!signatureHex) {
            const words = rawContent.split(/\s+/);
            for (const word of words) {
                if (word.length === 128 && /^[a-f0-9]+$/i.test(word)) {
                    signatureHex = word;
                    console.log(`[PAYROLL PROVER] Extracted signature hex (128 chars) from raw content`);
                    break;
                }
            }
        }
        
        if (!signatureHex) {
            console.warn(`[PAYROLL PROVER] No valid 128-char signature hex found in file`);
            return null;
        }
        
        console.log(`[PAYROLL PROVER] Signature loaded successfully, length: ${signatureHex.length} chars`);
        
        if (!fs.existsSync(KEY_PATH)) {
            console.error(`[PAYROLL PROVER] CRITICAL: app-key.json not found at ${KEY_PATH}`);
            console.error('[PAYROLL PROVER] This is required for versioned apps in v15');
            return null;
        }
        
        const keyFileContent = fs.readFileSync(KEY_PATH, 'utf8');
        const keyFile = JSON.parse(keyFileContent);
        const publicKeyHex = keyFile.public_key;
        
        if (!publicKeyHex || !/^[a-f0-9]+$/i.test(publicKeyHex)) {
            console.error(`[PAYROLL PROVER] CRITICAL: Invalid public_key in app-key.json`);
            return null;
        }
        
        console.log(`[PAYROLL PROVER] Public key loaded, length: ${publicKeyHex.length} chars`);
        
        return { 
            [APP_VK]: { 
                public_key: publicKeyHex,
                signature: signatureHex,
                version: 15 
            } 
        };
    } catch (error: any) {
        console.error(`[PAYROLL PROVER] Failed to load signature: ${error.message}`);
        return null;
    }
}

function stringToBytes(str: string): number[] {
    return Array.from(Buffer.from(str, 'utf8'));
}

export async function generateUnsignedTransactions(
    request: SpellRequest,
    prevTxHexes: string[],
    treasuryHexDest: string,
    appId?: string,
    utxoAddress?: string
): Promise<ProverResult> {
    console.log('\n[PAYROLL PROVER] ===== START =====');
    console.log(`[PAYROLL PROVER] Type: ${request.type}`);
    console.log(`[PAYROLL PROVER] Outputs: ${request.outputs?.length || 0}`);
    console.log(`[PAYROLL PROVER] Multi-sig: ${request.multiSigSigners ? 'yes' : 'no'}`);
    console.log(`[PAYROLL PROVER] Treasury hex dest provided: ${!!treasuryHexDest}`);

    if (!PROVER_URL) throw new Error('PROVER_API_URL not configured');
    if (!request.fundingUtxo || !request.fundingUtxoValue) throw new Error('Funding UTXO required');
    if (!request.changeAddress) throw new Error('Change address required');
    
    if (prevTxHexes.length === 0) {
        throw new Error('[PAYROLL PROVER] Context failure: prevTxHexes cannot be empty');
    }
    
    console.log(`[PAYROLL PROVER] Processing ${prevTxHexes.length} inputs for transaction...`);
    
    if (!treasuryHexDest) {
        throw new Error('treasuryHexDest is required for NFT minting');
    }

    console.log('[PAYROLL PROVER] Using custom subscription-engine WASM');

    let variables: Record<string, any>;
    let finalAppId: string | undefined = appId;

    try {
        if (request.type === 'mint-nft') {
            const result = buildMintNFTVarsWithTemplate(request, treasuryHexDest);
            variables = result.variables;
            finalAppId = result.appId;
            console.log('[PAYROLL PROVER] Built mint-nft typed variables');
            console.log(`[PAYROLL PROVER] Variables count: ${Object.keys(variables).length}`);
            console.log('🔍 [PROVER] variables object:', JSON.stringify(variables, null, 2));
        } else if (request.type === 'mint-token') {
            if (!appId) throw new Error("appId required for mint-token");
            const result = buildMintTokenVars(request, appId, treasuryHexDest);
            variables = result.variables;
            finalAppId = appId;
            console.log('[PAYROLL PROVER] Built mint-token typed variables');
            console.log(`[PAYROLL PROVER] Variables count: ${Object.keys(variables).length}`);
            console.log('🔍 [PROVER] variables object:', JSON.stringify(variables, null, 2));
        } else if (request.type === 'scroll-release') {
            const result = buildScrollReleaseVars(request, treasuryHexDest);
            variables = result.variables;
            finalAppId = request.planMetadata?.appId;
            console.log('[PAYROLL PROVER] Built scroll-release typed variables');
            console.log(`[PAYROLL PROVER] Variables count: ${Object.keys(variables).length}`);
            console.log(`[PAYROLL PROVER] authority_utxos count: ${variables.authority_utxos?.length || 0}`);
            console.log('🔍 [PROVER] variables object:', JSON.stringify(variables, null, 2));
        } else {
            throw new Error(`Unsupported action: ${request.type}`);
        }
    } catch (error: any) {
        console.error('[PAYROLL PROVER] Template building failed:', error);
        throw new Error(`Failed to build template: ${error.message}`);
    }

    let processedSpellStr: string;
    let spellObj: any;
    let spellHex: string;
    
    try {
        console.log('[PAYROLL PROVER] STEP 1: Rust type-marshalling via WASM bridge...');
        const variablesJson = JSON.stringify(variables);
        processedSpellStr = engine.process_spell_template("", variablesJson);
        console.log(`[PAYROLL PROVER] WASM returned JSON string length: ${processedSpellStr.length}`);
        
        spellObj = JSON.parse(processedSpellStr);
        console.log('[PAYROLL PROVER] Successfully parsed WASM output to JSON object');
        
        console.log('[PAYROLL PROVER] Overriding spell.version from', spellObj.version, 'to 15');
        spellObj.version = 15;
        console.log('[PAYROLL PROVER] spell.version is now', spellObj.version);
        
        console.log(`[PAYROLL PROVER] Checking for Collapsed Model deduplication...`);
        console.log(`[PAYROLL PROVER]   request.anchorUtxo: ${request.anchorUtxo}`);
        console.log(`[PAYROLL PROVER]   request.fundingUtxo: ${request.fundingUtxo}`);
        console.log(`[PAYROLL PROVER]   Are they equal? ${request.anchorUtxo === request.fundingUtxo}`);
        console.log(`[PAYROLL PROVER]   spellObj.tx.ins length: ${spellObj.tx?.ins?.length || 0}`);
        
        if (request.anchorUtxo === request.fundingUtxo && spellObj.tx.ins && spellObj.tx.ins.length > 1) {
            console.log('[PAYROLL PROVER] 🚀 COLLAPSED MODEL: Reducing tx.ins to single unique input');
            
            const originalInsLength = spellObj.tx.ins.length;
            spellObj.tx.ins = [spellObj.tx.ins[0]];
            console.log(`[PAYROLL PROVER]   Reduced tx.ins from ${originalInsLength} to ${spellObj.tx.ins.length}`);
            
            const originalPrevTxLength = prevTxHexes.length;
            prevTxHexes = [prevTxHexes[0]];
            console.log(`[PAYROLL PROVER]   Reduced prevTxHexes from ${originalPrevTxLength} to ${prevTxHexes.length}`);
        } else {
            console.log('[PAYROLL PROVER]   No collapsed model deduplication needed');
        }
        
        if (request.type === 'mint-nft') {
            console.log('[PAYROLL PROVER] NFT PATH: Applying original patching logic...');
            
            console.log('[PAYROLL PROVER] DEBUG - Raw tx.outs before patching:', 
                JSON.stringify(spellObj.tx?.outs, (key, value) => {
                    if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
                    return value;
                }, 2));
            
            console.log('[PAYROLL PROVER] Patching tx.outs string keys to integer keys using Map...');
            if (spellObj.tx && Array.isArray(spellObj.tx.outs)) {
                spellObj.tx.outs = spellObj.tx.outs.map((out: any) => {
                    const patchedOutMap = new Map();
                    for (const [key, val] of Object.entries(out)) {
                        const numericKey = parseInt(key, 10);
                        if (!isNaN(numericKey)) {
                            patchedOutMap.set(numericKey, val);
                            console.log(`[PAYROLL PROVER] DEBUG - Mapped key: "${key}" -> ${numericKey}, value type: ${typeof val}`);
                        } else {
                            patchedOutMap.set(key, val);
                            console.log(`[PAYROLL PROVER] DEBUG - Mapped key: "${key}" (string), value type: ${typeof val}`);
                        }
                    }
                    return patchedOutMap;
                });
                console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.outs.length} tx.outs entries to Maps`);
            }
            
            console.log('[PAYROLL PROVER] Patching tx.ins from UTXO strings to 36-byte Uint8Array...');
            if (spellObj.tx && Array.isArray(spellObj.tx.ins)) {
                if (spellObj.tx.ins.length !== prevTxHexes.length) {
                    console.warn(`[PAYROLL PROVER] WARNING: tx.ins length (${spellObj.tx.ins.length}) != prevTxHexes length (${prevTxHexes.length})`);
                    console.warn(`[PAYROLL PROVER] This may cause verification issues. Truncating to match.`);
                }
                
                spellObj.tx.ins = spellObj.tx.ins.map((utxoId: string, index: number) => {
                    const currentHex = prevTxHexes[index];
                    if (!currentHex) {
                        throw new Error(`[PAYROLL PROVER] Missing parent hex for input at index ${index}`);
                    }
                    const result = new Uint8Array(utxoTo36Bytes(utxoId));
                    console.log(`[PAYROLL PROVER] DEBUG - Converted UTXO ${index}: ${utxoId} -> ${result.length} bytes`);
                    return result;
                });
                console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.ins.length} tx.ins entries`);
            }
            
            console.log('[PAYROLL PROVER] Patching tx.coins dest for v15 Scroll routing...');
            if (spellObj.tx && Array.isArray(spellObj.tx.coins)) {
                spellObj.tx.coins = spellObj.tx.coins.map((coin: any) => {
                    if (coin.dest === "" || coin.dest === null || coin.dest === undefined) {
                        console.log(`[PAYROLL PROVER] Coin with empty dest - Scroll will fill address`);
                        return { ...coin, dest: new Uint8Array(0) };
                    }
                    if (typeof coin.dest === 'string') {
                        console.log(`[PAYROLL PROVER] Decoding hex destination: ${coin.dest.substring(0, 30)}...`);
                        return { ...coin, dest: hexToBytes(coin.dest) };
                    }
                    return { ...coin, dest: new Uint8Array(coin.dest) };
                });
                console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.coins.length} tx.coins dest entries`);
            }
            
            if (spellObj.app_public_inputs && typeof spellObj.app_public_inputs === 'object') {
                console.log('[PAYROLL PROVER] Patching app_public_inputs keys to CBOR arrays...');
                const patchedPublicInputs = new Map();
                for (const [key, value] of Object.entries(spellObj.app_public_inputs)) {
                    const parts = (key as string).split('/');
                    if (parts.length === 3 && (parts[0] === 'n' || parts[0] === 't')) {
                        const [tag, idHex, vkHex] = parts;
                        const complexKey = [tag, hexToBytes(idHex), hexToBytes(vkHex)];
                        patchedPublicInputs.set(complexKey, null);
                        console.log(`[PAYROLL PROVER] Patched key: ${key} -> [${tag}, ${idHex.substring(0, 16)}..., ${vkHex.substring(0, 16)}...]`);
                    } else {
                        patchedPublicInputs.set(key, value);
                    }
                }
                spellObj.app_public_inputs = patchedPublicInputs;
                console.log(`[PAYROLL PROVER] app_public_inputs patched to Map with ${patchedPublicInputs.size} entries`);

                console.log('[PAYROLL PROVER] 🔍 app_public_inputs Map contents:', Array.from(patchedPublicInputs.entries()).map(([key, val]: [any, any]) => {
                    return {
                        key: key.map((k: any) => {
                            if (k instanceof Uint8Array) {
                                return `Uint8Array(${k.length})`;
                            }
                            return k;
                        }),
                        value: val
                    };
                }));
            }
            
        } else if (request.type === 'mint-token') {
            console.log('[PAYROLL PROVER] TOKEN PATH: Restoring Binary Parity...');
            
            console.log('[PAYROLL PROVER] Converting tx.ins to 36-byte Uint8Arrays...');
            if (!request.authorityUtxo || !request.fundingUtxo) {
                throw new Error('Missing authorityUtxo or fundingUtxo for tx.ins');
            }
            spellObj.tx.ins = [
                utxoTo36Bytes(request.authorityUtxo),
                utxoTo36Bytes(request.fundingUtxo)
            ];
            console.log(`[PAYROLL PROVER] tx.ins converted to Uint8Arrays (${spellObj.tx.ins[0].length} bytes each)`);
            
            console.log('[PAYROLL PROVER] Converting tx.outs to Map with integer keys...');
            if (spellObj.tx && Array.isArray(spellObj.tx.outs)) {
                spellObj.tx.outs = spellObj.tx.outs.map((out: any) => {
                    const outMap = new Map();
                    Object.entries(out).forEach(([key, val]) => {
                        const numericKey = parseInt(key, 10);
                        if (!isNaN(numericKey)) {
                            outMap.set(numericKey, val);
                            console.log(`[PAYROLL PROVER] Mapped key: "${key}" -> ${numericKey}`);
                        } else {
                            outMap.set(key, val);
                            console.log(`[PAYROLL PROVER] Kept key as string: "${key}"`);
                        }
                    });
                    return outMap;
                });
                console.log(`[PAYROLL PROVER] Converted ${spellObj.tx.outs.length} tx.outs entries to Maps with integer keys`);
            }
            
            console.log('[PAYROLL PROVER] Reconstructing tx.coins with Uint8Array dest...');
            if (request.outputs && request.outputs.length > 0) {
                const newCoins = [];
                for (let i = 0; i < request.outputs.length; i++) {
                    const out = request.outputs[i];
                    const destHex = addressToHexDest(out.address);
                    const destUint8 = new Uint8Array(Buffer.from(destHex, 'hex'));
                    console.log(`[PAYROLL PROVER] Mapping Coin ${i} to: ${out.address.substring(0, 20)}... (dest length: ${destUint8.length})`);
                    newCoins.push({
                        amount: constants.MIN_OUTPUT_SATS,
                        dest: destUint8
                    });
                }
                spellObj.tx.coins = newCoins;
                console.log(`[PAYROLL PROVER] Reconstructed tx.coins array with ${spellObj.tx.coins.length} entries`);
            }
            
            console.log('[PAYROLL PROVER] Converting app_public_inputs to Map...');
            const appIdHex = finalAppId!;
            const appVkHex = APP_VK;
            const publicInputsMap = new Map();
            publicInputsMap.set(["n", hexToBytes(appIdHex), hexToBytes(appVkHex)], null);
            publicInputsMap.set(["t", hexToBytes(appIdHex), hexToBytes(appVkHex)], null);
            spellObj.app_public_inputs = publicInputsMap;
            console.log(`[PAYROLL PROVER] app_public_inputs converted to Map with ${publicInputsMap.size} entries`);
            
        } else if (request.type === 'scroll-release') {
            console.log('[PAYROLL PROVER] SCROLL-RELEASE PATH: Restoring Binary Parity...');
            
            const authorityUtxos = request.authorityUtxos || (request.authorityUtxo ? [request.authorityUtxo] : []);
            console.log(`[PAYROLL PROVER] Authority UTXOs count: ${authorityUtxos.length}`);
            
            const authorityInputs = authorityUtxos.map((utxoId: string) => new Uint8Array(utxoTo36Bytes(utxoId)));
            const fundingInput = new Uint8Array(utxoTo36Bytes(request.fundingUtxo));
            const salaryInput = new Uint8Array(utxoTo36Bytes(request.salaryUtxo!));
            
            spellObj.tx.ins = [...authorityInputs, fundingInput, salaryInput];
            console.log(`[PAYROLL PROVER] tx.ins built: ${authorityInputs.length} token inputs + 1 funding + 1 salary = ${spellObj.tx.ins.length} total`);
            
            console.log('[PAYROLL PROVER] Converting tx.outs to Map with integer keys...');
            if (spellObj.tx && Array.isArray(spellObj.tx.outs)) {
                spellObj.tx.outs = spellObj.tx.outs.map((out: any) => {
                    const outMap = new Map();
                    Object.entries(out).forEach(([key, val]) => {
                        const numericKey = parseInt(key, 10);
                        if (!isNaN(numericKey)) {
                            outMap.set(numericKey, val);
                            console.log(`[PAYROLL PROVER] Mapped key: "${key}" -> ${numericKey}`);
                        } else {
                            outMap.set(key, val);
                            console.log(`[PAYROLL PROVER] Kept key as string: "${key}"`);
                        }
                    });
                    return outMap;
                });
                console.log(`[PAYROLL PROVER] Converted ${spellObj.tx.outs.length} tx.outs entries to Maps with integer keys`);
            }
            
            console.log('[PAYROLL PROVER] Converting tx.coins dest for v15 Scroll routing...');
            if (spellObj.tx && Array.isArray(spellObj.tx.coins) && request.outputs) {
                const rebuiltCoins = [];
                for (let i = 0; i < request.outputs.length; i++) {
                    const output = request.outputs[i];
                    let destUint8: Uint8Array;
                    
                    if (output.address === "" || output.address === null || output.address === undefined) {
                        console.log(`[PAYROLL PROVER] Coin ${i} has empty address - Scroll will fill`);
                        destUint8 = new Uint8Array(0);
                    } else {
                        const destHex = addressToHexDest(output.address);
                        destUint8 = new Uint8Array(Buffer.from(destHex, 'hex'));
                        console.log(`[PAYROLL PROVER] Coin ${i}: ${output.address} -> hex ${destHex.substring(0, 30)}...`);
                    }
                    rebuiltCoins.push({
                        amount: output.sats || 0,
                        dest: destUint8
                    });
                }
                spellObj.tx.coins = rebuiltCoins;
                console.log(`[PAYROLL PROVER] Rebuilt ${spellObj.tx.coins.length} tx.coins entries with hex scripts`);
            }
            
            console.log('[PAYROLL PROVER] Converting app_public_inputs to Map...');
            if (spellObj.app_public_inputs && typeof spellObj.app_public_inputs === 'object') {
                const patchedPublicInputs = new Map();
                for (const [key, value] of Object.entries(spellObj.app_public_inputs)) {
                    const parts = (key as string).split('/');
                    if (parts.length === 3 && (parts[0] === 'n' || parts[0] === 't')) {
                        const [tag, idHex, vkHex] = parts;
                        const complexKey = [tag, hexToBytes(idHex), hexToBytes(vkHex)];
                        patchedPublicInputs.set(complexKey, null);
                        console.log(`[PAYROLL PROVER] Patched key: ${key} -> [${tag}, ${idHex.substring(0, 16)}..., ${vkHex.substring(0, 16)}...]`);
                    } else {
                        patchedPublicInputs.set(key, value);
                    }
                }
                spellObj.app_public_inputs = patchedPublicInputs;
                console.log(`[PAYROLL PROVER] app_public_inputs patched to Map with ${patchedPublicInputs.size} entries`);
            }
        }
        
        if (request.scrolls && Array.isArray(request.scrolls) && request.scrolls.length > 0) {
            if (!spellObj.tx) {
                spellObj.tx = {};
            }
            spellObj.tx.scrolls = request.scrolls;
            console.log(`[PAYROLL PROVER] Added scrolls array to tx: [${request.scrolls.join(', ')}]`);
        } else if (spellObj.tx && spellObj.tx.scrolls) {
            console.log(`[PAYROLL PROVER] scrolls already present in spellObj: ${JSON.stringify(spellObj.tx.scrolls)}`);
        }
        
        const wasmHash = getWasmHash();
        const versionedAppsMap = new Map();
        const vkBytes = hexToBytes(APP_VK);
        const wasmHashBytes = hexToBytes(wasmHash);
        versionedAppsMap.set(vkBytes, {
            version: 15,
            wasm_hash: wasmHashBytes
        });
        spellObj.versioned_apps = versionedAppsMap;
        console.log(`[PAYROLL PROVER] Added versioned_apps with wasm_hash: ${wasmHash.substring(0, 16)}...`);
        
        console.log('[PAYROLL PROVER] DEBUG - Final spellObj structure summary:');
        console.log(`  version: ${spellObj.version}`);
        console.log(`  tx.ins length: ${spellObj.tx?.ins?.length || 0}, type: ${spellObj.tx?.ins?.constructor?.name}`);
        if (spellObj.tx?.ins && spellObj.tx.ins.length > 0) {
            console.log(`  tx.ins[0] type: ${spellObj.tx.ins[0] instanceof Uint8Array ? 'Uint8Array' : typeof spellObj.tx.ins[0]}, isArray: ${Array.isArray(spellObj.tx.ins[0])}`);
        }
        console.log(`  tx.outs length: ${spellObj.tx?.outs?.length || 0}, type: ${spellObj.tx?.outs?.constructor?.name}`);
        console.log(`  tx.coins length: ${spellObj.tx?.coins?.length || 0}, type: ${spellObj.tx?.coins?.constructor?.name}`);
        if (spellObj.tx?.coins && spellObj.tx.coins.length > 0) {
            console.log(`  tx.coins[0].dest type: ${spellObj.tx.coins[0]?.dest instanceof Uint8Array ? 'Uint8Array' : typeof spellObj.tx.coins[0]?.dest}, isArray: ${Array.isArray(spellObj.tx.coins[0]?.dest)}`);
        }
        console.log(`  tx.scrolls: ${spellObj.tx?.scrolls ? JSON.stringify(spellObj.tx.scrolls) : 'undefined'}`);
        console.log(`  app_public_inputs type: ${spellObj.app_public_inputs?.constructor?.name}`);
        if (spellObj.app_public_inputs instanceof Map) {
            console.log(`  app_public_inputs size: ${spellObj.app_public_inputs.size}`);
        }
        console.log(`  versioned_apps: ${JSON.stringify(spellObj.versioned_apps)}`);
        
    } catch (error: any) {
        console.error('[PAYROLL PROVER] WASM processing failed:', error);
        throw new Error(`WASM processing failed: ${error.message}`);
    }

    try {
        console.log('[PAYROLL PROVER] STEP 2: CBOR encoding for transport...');
        const cborEncoded = encode(spellObj);
        spellHex = bytesToHex(cborEncoded);
        console.log(`[PAYROLL PROVER] CBOR encoded length: ${cborEncoded.length} bytes`);
        console.log(`[PAYROLL PROVER] Spell hex length: ${spellHex.length} chars`);
        console.log(`[PAYROLL PROVER] Spell hex prefix: ${spellHex.substring(0, 50)}...`);
        console.log(`[PAYROLL PROVER] Spell hex suffix: ...${spellHex.substring(spellHex.length - 50)}`);
    } catch (error: any) {
        console.error('[PAYROLL PROVER] CBOR encoding failed:', error);
        throw new Error(`CBOR encoding failed: ${error.message}`);
    }

    const wasmBase64 = getWasmBase64();
    console.log(`[PAYROLL PROVER] WASM base64 length: ${wasmBase64.length}`);
    
    const signature = getWasmSignature();
    if (signature) {
        console.log(`[PAYROLL PROVER] Signature loaded, VK: ${Object.keys(signature).join(', ')}`);
        if (signature[APP_VK] && signature[APP_VK].public_key) {
            console.log(`[PAYROLL PROVER] Public key included, length: ${signature[APP_VK].public_key.length} chars`);
        }
    } else {
        console.warn('[PAYROLL PROVER] No signature found - this may cause validation errors for versioned apps');
    }
    
    let identityToProve: string;
    
    if (request.type === 'mint-nft') {
        if (!request.anchorUtxo) {
            throw new Error('No anchorUtxo available for mint-nft witness');
        }
        identityToProve = request.anchorUtxo;
        console.log(`[PAYROLL PROVER] mint-nft: Using anchorUtxo as witness`);
    } else if (request.type === 'mint-token') {
        identityToProve = (request as any).planMetadata?.anchorUtxo || request.anchorUtxo;
        if (!identityToProve) {
            throw new Error('No anchorUtxo available for mint-token witness. Ensure planMetadata.anchorUtxo is provided.');
        }
        console.log(`[PAYROLL PROVER] mint-token: Using planMetadata.anchorUtxo as witness`);
    } else if (request.type === 'scroll-release') {
        identityToProve = (request as any).planMetadata?.anchorUtxo;
        if (!identityToProve) {
            throw new Error('No anchorUtxo found in planMetadata for scroll-release witness');
        }
        console.log(`[PAYROLL PROVER] scroll-release: Using anchorUtxo from planMetadata as witness: ${identityToProve}`);
    } else {
        throw new Error(`Unsupported request type for witness: ${request.type}`);
    }
    
    const witnessHex = utxoIdToHexWitness(identityToProve);
    console.log(`[PAYROLL PROVER] Identity to prove: ${identityToProve}`);
    console.log(`[PAYROLL PROVER] Witness hex (CBOR-wrapped): ${witnessHex.substring(0, 50)}...`);

    const cleanedPrevTxs = prevTxHexes.map(hex => hex.replace(/\s/g, '').toLowerCase());
    console.log(`[PAYROLL PROVER] Cleaned ${cleanedPrevTxs.length} prev_txs`);
    
    cleanedPrevTxs.forEach((hex, i) => {
        console.log(`[PAYROLL PROVER] prev_txs[${i}] length: ${hex.length} characters`);
        if (hex.length > 0) {
            console.log(`[PAYROLL PROVER] prev_txs[${i}] prefix: ${hex.substring(0, 50)}...`);
        }
    });

    const wasmHash = getWasmHash();

    const requestBody: any = {
        spell: spellHex,
        app_private_inputs: {
            [`n/${finalAppId}/${APP_VK}`]: witnessHex
        },
        binaries: {
            [wasmHash]: wasmBase64
        },
        prev_txs: cleanedPrevTxs.map(hex => ({ bitcoin: hex })),
        change_address: request.changeAddress,
        fee_rate: request.feeRate || 2.0,
        chain: "bitcoin"
    };

    if (signature) {
        requestBody.app_signatures = signature;
        console.log('[PAYROLL PROVER] Added app_signatures to request body');
    } else {
        console.warn('[PAYROLL PROVER] No app_signatures added - versioned apps require this');
    }

    if (request.type === 'mint-token') {
        requestBody.app_private_inputs[`t/${finalAppId}/${APP_VK}`] = witnessHex;
        console.log(`[PAYROLL PROVER] Added token app_private_inputs for mint-token`);
    }

    console.log('[PAYROLL PROVER] prev_txs format:', JSON.stringify(requestBody.prev_txs).substring(0, 200));

    const jsonString = JSON.stringify(requestBody);
    console.log('[PAYROLL PROVER] ACTUAL JSON being sent (first 1200 chars):', jsonString.substring(0, 1200));
    console.log('[PAYROLL PROVER] ACTUAL JSON at column 1130-1150:', jsonString.substring(1130, 1150));

    console.log('[PAYROLL PROVER] ===== FINAL REQUEST BODY DEBUG =====');
    console.log('[PAYROLL PROVER] requestBody keys:', Object.keys(requestBody));
    console.log('[PAYROLL PROVER] spell type:', typeof requestBody.spell);
    console.log('[PAYROLL PROVER] spell length:', requestBody.spell?.length);
    console.log('[PAYROLL PROVER] spell prefix:', requestBody.spell?.substring(0, 50));
    console.log('[PAYROLL PROVER] app_private_inputs keys:', Object.keys(requestBody.app_private_inputs));
    console.log('[PAYROLL PROVER] binaries keys:', Object.keys(requestBody.binaries));
    console.log('[PAYROLL PROVER] app_signatures present:', !!requestBody.app_signatures);
    if (requestBody.app_signatures) {
        console.log('[PAYROLL PROVER] app_signatures keys:', Object.keys(requestBody.app_signatures));
    }
    console.log('[PAYROLL PROVER] prev_txs length:', requestBody.prev_txs?.length);
    console.log('[PAYROLL PROVER] change_address:', requestBody.change_address);
    console.log('[PAYROLL PROVER] fee_rate:', requestBody.fee_rate);
    console.log('[PAYROLL PROVER] chain:', requestBody.chain);
    
    const requestBodySize = JSON.stringify(requestBody).length;
    console.log(`[PAYROLL PROVER] Request body JSON size: ${requestBodySize} bytes`);

    console.log('[PAYROLL PROVER] 🔍 RAW REQUEST BEING SENT:');
    console.log('  spell type:', typeof requestBody.spell);
    console.log('  spell is string?', typeof requestBody.spell === 'string');
    console.log('  spell first 200 chars:', requestBody.spell?.substring(0, 200));
    console.log('  spell last 100 chars:', requestBody.spell?.substring(requestBody.spell.length - 100));
    console.log('  app_private_inputs first key type:', typeof Object.keys(requestBody.app_private_inputs)[0]);
    console.log('  binaries first key type:', typeof Object.keys(requestBody.binaries)[0]);
    console.log('  app_signatures first key type:', requestBody.app_signatures ? typeof Object.keys(requestBody.app_signatures)[0] : 'undefined');
    console.log('  prev_txs[0] type:', typeof requestBody.prev_txs[0]);
    console.log('  prev_txs[0] is object?', typeof requestBody.prev_txs[0] === 'object');
    console.log('  prev_txs[0].bitcoin type:', typeof requestBody.prev_txs[0]?.bitcoin);
    console.log('  Full requestBody (first 500 chars):', JSON.stringify(requestBody).substring(0, 500));

    const fsModule = require('fs');
    const payloadPath = '/tmp/prover-payload-batch.json';
    fsModule.writeFileSync(payloadPath, JSON.stringify(requestBody, null, 2));
    console.log(`[PAYROLL PROVER] ✅ Saved batch payload to ${payloadPath}`);
    console.log(`[PAYROLL PROVER] Payload size: ${JSON.stringify(requestBody).length} bytes`);

    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
            console.log(`\n[PAYROLL PROVER] Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);
            console.log(`[PAYROLL PROVER] Relaying to Prover API: ${PROVER_URL}`);

            const startTime = Date.now();
            const response = await axios.post(PROVER_URL, requestBody, {
                headers: { 'Content-Type': 'application/json' },
                timeout: PROVER_TIMEOUT_MS
            });
            const elapsed = Date.now() - startTime;
            
            console.log('[PAYROLL PROVER] ✅ Response received:', {
                status: response.status,
                statusText: response.statusText,
                elapsedSec: (elapsed/1000).toFixed(1),
                responseLength: Array.isArray(response.data) ? response.data.length : 'not array'
            });
            
            const responsePreview = JSON.stringify(response.data).substring(0, 200);
            console.log(`[PAYROLL PROVER] Response preview: ${responsePreview}...`);
            
            const resultData = response.data;
            let finalCommitTxHex: string;
            let finalSpellTxHex: string;
            let finalIsSingleMode: boolean;
            
            if (Array.isArray(resultData)) {
                if (resultData.length === 1) {
                    const combined = extractTxHexFromJson(resultData, 0);
                    finalCommitTxHex = combined;
                    finalSpellTxHex = combined;
                    finalIsSingleMode = true;
                    console.log('[PAYROLL PROVER] Response: Single transaction mode');
                } else if (resultData.length >= 2) {
                    finalCommitTxHex = extractTxHexFromJson(resultData, 0);
                    finalSpellTxHex = extractTxHexFromJson(resultData, 1);
                    finalIsSingleMode = false;
                    console.log('[PAYROLL PROVER] Response: Two transaction mode');
                } else {
                    throw new Error(`Unexpected response array length: ${resultData.length}`);
                }
            } else {
                finalCommitTxHex = extractTxHexFromJson(resultData, 0);
                finalSpellTxHex = finalCommitTxHex;
                finalIsSingleMode = true;
                console.log('[PAYROLL PROVER] Response: Single transaction mode (object response)');
            }

            if (finalSpellTxHex) {
                fsModule.writeFileSync('/tmp/full-tx.hex', finalSpellTxHex);
                console.log('[PAYROLL PROVER] Saved full transaction hex to /tmp/full-tx.hex');
            }
    
            console.log('[PAYROLL PROVER] Successfully extracted hexes:', {
                commit: finalCommitTxHex ? finalCommitTxHex.substring(0, 10) + '...' : 'undefined',
                spell: finalSpellTxHex ? finalSpellTxHex.substring(0, 10) + '...' : 'undefined',
                isSingle: finalIsSingleMode,
                commitLength: finalCommitTxHex?.length || 0,
                spellLength: finalSpellTxHex?.length || 0
            });
    
            console.log('[PAYROLL PROVER] ===== SUCCESS =====\n');
    
            return { 
                commitTxHex: finalCommitTxHex, 
                spellTxHex: finalSpellTxHex,
                isSingle: finalIsSingleMode,
                dualUtxoContext: {
                    anchor: { 
                        utxoId: request.anchorUtxo || request.authorityUtxo || '', 
                        hex: prevTxHexes[0], 
                        value: request.anchorValue || 0 
                    },
                    fee: { 
                        utxoId: request.fundingUtxo, 
                        value: request.fundingUtxoValue || 0 
                    }
                }
            };
            
        } catch (error: any) {
            lastError = error;
            
            console.error(`\n[PAYROLL PROVER] ❌ Attempt ${attempt + 1} failed:`);
            
            if (error.response) {
                console.error(`  Status: ${error.response.status}`);
                console.error(`  Status Text: ${error.response.statusText}`);
                console.error(`  Response Data:`, JSON.stringify(error.response.data, null, 2));
                
                console.error(`  ===== PROVER ERROR DETAILS =====`);
                console.error(`  Response type: ${typeof error.response.data}`);
                
                if (typeof error.response.data === 'string') {
                    console.error(`  RAW STRING RESPONSE: ${error.response.data}`);
                }
                
                if (error.response.data && typeof error.response.data === 'object') {
                    console.error(`  RESPONSE KEYS: ${Object.keys(error.response.data).join(', ')}`);
                    if (error.response.data.error) console.error(`  error field:`, error.response.data.error);
                    if (error.response.data.message) console.error(`  message field:`, error.response.data.message);
                    if (error.response.data.details) console.error(`  details field:`, error.response.data.details);
                    if (error.response.data.reason) console.error(`  reason field:`, error.response.data.reason);
                    if (error.response.data.cause) console.error(`  cause field:`, error.response.data.cause);
                    if (error.response.data.validation) console.error(`  validation field:`, error.response.data.validation);
                }
                console.error(`  ===== END PROVER ERROR DETAILS =====`);
                
            } else if (error.request) {
                console.error(`  No response received: ${error.message}`);
            } else {
                console.error(`  Request setup error: ${error.message}`);
            }
            
            if (error.response?.status >= 400 && error.response?.status < 500) {
                console.error(`[PAYROLL PROVER] Client error (${error.response.status}), not retrying`);
                break;
            }
            
            if (attempt < MAX_RETRIES) {
                const delay = calculateBackoff(attempt);
                console.log(`Retrying in ${Math.round(delay/1000)}s...`);
                await sleep(delay);
            }
        }
    }
    
    throw lastError || new Error('All retries failed');
}

export async function batchPayroll(
    planUtxo: string,
    workers: Array<{ address: string; amount: number }>,
    fundingUtxo: { utxo: string; value: number },
    changeAddress: string,
    appId: string,
    employerAddress: string,
    planMetadata: any,
    treasuryHexDest: string,
    utxoAddress?: string,
    multiSigSigners?: string[]
): Promise<ProverResult> {
    const [planTxid] = planUtxo.split(':');
    const [fundingTxid] = fundingUtxo.utxo.split(':');

    console.log('[PAYROLL PROVER] Fetching required hexes for Provenance...');
    console.log(`[PAYROLL PROVER] Plan TXID: ${planTxid}`);
    console.log(`[PAYROLL PROVER] Funding TXID: ${fundingTxid}`);
    
    const planHex = await fetchTransactionHex(planTxid);
    const fundingHex = await fetchTransactionHex(fundingTxid);
    
    console.log(`[PAYROLL PROVER] Plan hex length: ${planHex.length} chars`);
    console.log(`[PAYROLL PROVER] Funding hex length: ${fundingHex.length} chars`);

    const anchorUtxoFromMetadata = planMetadata?.anchorUtxo;
    
    if (!anchorUtxoFromMetadata) {
        console.error('[PAYROLL PROVER] ❌ planMetadata.anchorUtxo is missing!');
        console.error('[PAYROLL PROVER] planMetadata keys:', Object.keys(planMetadata || {}));
        throw new Error('planMetadata.anchorUtxo is required for mint-token witness. Ensure the plan record contains the original anchorUtxo from Phase 1.');
    }
    
    console.log(`[PAYROLL PROVER] ✅ Using anchorUtxo from planMetadata: ${anchorUtxoFromMetadata}`);

    const request: SpellRequest = {
        type: 'mint-token',
        authorityUtxo: planUtxo,
        anchorUtxo: anchorUtxoFromMetadata,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        outputs: [
            ...workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
            { address: employerAddress, nftMetadata: planMetadata }
        ],
        planMetadata: planMetadata,
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    } as any;

    return generateUnsignedTransactions(request, [planHex, fundingHex], treasuryHexDest, appId, utxoAddress);
}

export async function createEmploymentPlan(
    planDetails: {
        ticker: string;
        compensationSats: number;
        payPeriodSeconds: number;
        metadataHash: string;
        scrollPolicy: number;
    },
    anchorUtxo: string,
    fundingUtxo: { utxo: string; value: number },
    changeAddress: string,
    treasuryHexDest: string,
    utxoAddress?: string,
    multiSigSigners?: string[]
): Promise<ProverResult> {
    const [anchorTxid] = anchorUtxo.split(':');
    const [fundingTxid] = fundingUtxo.utxo.split(':');

    console.log('[PAYROLL PROVER] Fetching required hexes for createEmploymentPlan...');
    console.log(`[PAYROLL PROVER] Anchor TXID: ${anchorTxid}`);
    console.log(`[PAYROLL PROVER] Funding TXID: ${fundingTxid}`);
    
    const anchorHex = await fetchTransactionHex(anchorTxid);
    const fundingHex = await fetchTransactionHex(fundingTxid);
    
    console.log(`[PAYROLL PROVER] Anchor hex length: ${anchorHex.length} chars`);
    console.log(`[PAYROLL PROVER] Funding hex length: ${fundingHex.length} chars`);

    const request: SpellRequest = {
        type: 'mint-nft',
        anchorUtxo: anchorUtxo,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        outputs: [{
            address: changeAddress,
            nftMetadata: {
                ticker: planDetails.ticker,
                remaining: 1,
                metadataHash: planDetails.metadataHash,
                scrollPolicy: planDetails.scrollPolicy,
                payPeriodSeconds: planDetails.payPeriodSeconds,
                compensationSats: planDetails.compensationSats
            }
        }],
        scrolls: [0],
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    };
    
    return generateUnsignedTransactions(request, [anchorHex, fundingHex], treasuryHexDest, undefined, utxoAddress);
}