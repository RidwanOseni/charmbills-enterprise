import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { encode } from 'cbor-x';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import { initializeWasmBridge, process_spell_template } from '../lib/charms-utils';
import { buildMintNFTVarsWithTemplate } from './buildMintNFT';
import { buildMintTokenVars } from './buildMintToken';
import { fetchTransactionHex } from '../lib/utxo-manager';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
bitcoin.initEccLib(ecc);

// --------------------------------------------------------------------------------
// Configuration & Constants
// --------------------------------------------------------------------------------
const PROVER_URL = process.env.PROVER_API_URL || constants.PROVER_API_URL;
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const PROVER_TIMEOUT_MS = 180000;

// CRITICAL: Path to the compiled WASM file for the app contract
const ENGINE_DIR = path.resolve(process.cwd(), '../subscription-engine');
const WASM_PATH = path.join(ENGINE_DIR, 'target/wasm32-wasip1/release/subscription-engine.wasm');

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

// Helper: Derive App ID from UTXO (for fallback)
function deriveAppId(utxoId: string): string {
    if (!utxoId || typeof utxoId !== 'string') {
        throw new Error('Invalid utxoId: must be non-empty string');
    }
    const crypto = require('crypto');
    return crypto.createHash('sha256').update(utxoId).digest('hex');
}

// Helper: Convert "txid:vout" string to 36-byte binary (32-byte txid + 4-byte little-endian vout)
// CRITICAL FIX: Reverse txid bytes to convert from Big-Endian (string) to Little-Endian (internal)
// This resolves the "prev_txs MUST contain transactions creating input UTXOs" error
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
    
    // Convert txid from hex to bytes (32 bytes) - these are in Big-Endian order (string order)
    const txidBytes = hexToBytes(txidHex);
    
    // CRITICAL: Reverse the bytes (Big-Endian string -> Little-Endian internal)
    // The Prover API expects txid bytes in Little-Endian order to match the hashed prev_txs
    const reversedTxid = txidBytes.reverse();
    
    // Convert vout to 4-byte little-endian
    const voutBuffer = Buffer.allocUnsafe(4);
    voutBuffer.writeUInt32LE(vout, 0);
    const voutBytes = new Uint8Array(voutBuffer);
    
    // Combine: 32 bytes reversed txid + 4 bytes vout = 36 bytes total
    const result = new Uint8Array(36);
    result.set(reversedTxid, 0);
    result.set(voutBytes, 32);
    
    console.log(`[PAYROLL PROVER] DEBUG - UTXO conversion: ${utxoId} -> reversed txid bytes (${reversedTxid.length}), vout bytes (${voutBytes.length})`);
    
    return result;
}

// Helper: Convert UTXO ID to CBOR-wrapped hex witness
function utxoIdToHexWitness(utxoId: string): string {
    const witnessCbor = encode(utxoId);
    return bytesToHex(witnessCbor);
}

// Helper: Convert Bitcoin address to Hex Script Destination (for app_private_inputs)
// This fixes the "Invalid character 'G'" error by using hex instead of base64
function addressToHexDest(address: string): string {
    // Converts a standard address into the hex script format required for witnesses
    try {
        // Use testnet network for tb1 addresses
        const script = bitcoin.address.toOutputScript(address, bitcoin.networks.testnet);
        return Buffer.from(script).toString('hex');
    } catch (error: any) {
        console.error(`[PAYROLL PROVER] Failed to convert address to hex: ${address}`, error.message);
        // Fallback: return the original address if it's already a hex string
        if (/^[0-9a-f]+$/i.test(address)) {
            console.log('[PAYROLL PROVER] Address appears to be already hex, using as-is');
            return address;
        }
        throw new Error(`Invalid address format: ${address}`);
    }
}

// Helper: Get WASM binary as Buffer
function getWasmBuffer(): Buffer {
    console.log(`[PAYROLL PROVER] Loading WASM from: ${WASM_PATH}`);
    
    if (!fs.existsSync(WASM_PATH)) {
        throw new Error(`CRITICAL: WASM binary not found at ${WASM_PATH}. Run 'cargo build' in subscription-engine.`);
    }
    
    const wasmBuffer = fs.readFileSync(WASM_PATH);
    console.log(`[PAYROLL PROVER] WASM loaded: ${wasmBuffer.length} bytes`);
    
    return wasmBuffer;
}

// Helper: Get WASM binary as Base64
function getWasmBase64(): string {
    const wasmBuffer = getWasmBuffer();
    return wasmBuffer.toString('base64');
}

// Helper: Convert string to numeric byte array for witness
function stringToBytes(str: string): number[] {
    return Array.from(Buffer.from(str, 'utf8'));
}

// --------------------------------------------------------------------------------
// Main Prover Function - Clean Relay with Strict Type-Marshalling (Production)
// --------------------------------------------------------------------------------

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

    // ----------------------------------------------------------------------------
    // Step 1: Validate inputs
    // ----------------------------------------------------------------------------
    if (!PROVER_URL) throw new Error('PROVER_API_URL not configured');
    if (!request.fundingUtxo || !request.fundingUtxoValue) throw new Error('Funding UTXO required');
    if (!request.changeAddress) throw new Error('Change address required');
    if (prevTxHexes.length !== 2) throw new Error(`v0.12 requires exactly 2 prev_txs, got ${prevTxHexes.length}`);
    
    if (!treasuryHexDest) {
        throw new Error('treasuryHexDest is required for NFT minting');
    }

    // ----------------------------------------------------------------------------
    // Step 2: Initialize WASM Bridge (Ensure Rust SDK is loaded)
    // ----------------------------------------------------------------------------
    await initializeWasmBridge();
    console.log('[PAYROLL PROVER] WASM Bridge initialized');

    // ----------------------------------------------------------------------------
    // Step 3: Build typed variables based on request type
    // The Rust bridge will perform strict type-marshalling
    // ----------------------------------------------------------------------------
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
        } else {
            throw new Error(`Unsupported action: ${request.type}`);
        }
    } catch (error: any) {
        console.error('[PAYROLL PROVER] Template building failed:', error);
        throw new Error(`Failed to build template: ${error.message}`);
    }

    // ----------------------------------------------------------------------------
    // Step 4: Let Rust perform strict type-marshalling
    // The Rust bridge converts strings to proper binary types (UtxoId, bytes, parsed integers)
    // ----------------------------------------------------------------------------
    let processedSpellStr: string;
    let spellObj: any;
    let spellHex: string;
    
    try {
        console.log('[PAYROLL PROVER] STEP 1: Rust type-marshalling via WASM bridge...');
        const variablesJson = JSON.stringify(variables);
        processedSpellStr = process_spell_template("", variablesJson);
        console.log(`[PAYROLL PROVER] WASM returned JSON string length: ${processedSpellStr.length}`);
        
        // Parse the JSON string to get the spell object
        spellObj = JSON.parse(processedSpellStr);
        console.log('[PAYROLL PROVER] Successfully parsed WASM output to JSON object');
        
        // =========================================================================
        // MANDATORY VERSION OVERRIDE
        // This resolves the "spell.version == CURRENT_VERSION" error in prove-log.txt
        // The local v12 prover requires version 12, but the bridge returns version 11
        // =========================================================================
        console.log('[PAYROLL PROVER] Overriding spell.version from', spellObj.version, 'to 12');
        spellObj.version = 12;
        console.log('[PAYROLL PROVER] spell.version is now', spellObj.version);
        
        // =========================================================================
        // BRANCH LOGIC: mint-nft vs mint-token
        // For mint-nft: Keep ALL original patching logic (tx.outs Map, tx.ins conversion, etc.)
        // For mint-token: Restore Binary Patching (Uint8Arrays for binary data)
        // =========================================================================
        
        if (request.type === 'mint-nft') {
            // =========================================================================
            // NFT MINTING PATH - Keep ALL original patching logic
            // =========================================================================
            console.log('[PAYROLL PROVER] NFT PATH: Applying original patching logic...');
            
            // DEBUG: Log raw tx.outs before patching
            console.log('[PAYROLL PROVER] DEBUG - Raw tx.outs before patching:', 
                JSON.stringify(spellObj.tx?.outs, (key, value) => {
                    if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
                    return value;
                }, 2));
            
            // Patching tx.outs string keys to integer keys using Map
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
            
            // Patch Inputs: Bridge returns "txid:vout" strings - convert to 36-byte Uint8Array
            console.log('[PAYROLL PROVER] Patching tx.ins from UTXO strings to 36-byte Uint8Array...');
            if (spellObj.tx && Array.isArray(spellObj.tx.ins)) {
                spellObj.tx.ins = spellObj.tx.ins.map((utxoId: string) => {
                    const result = new Uint8Array(utxoTo36Bytes(utxoId));
                    console.log(`[PAYROLL PROVER] DEBUG - Converted UTXO: ${utxoId} -> ${result.length} bytes`);
                    return result;
                });
                console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.ins.length} tx.ins entries`);
            }
            
            // Patch Destinations: Bridge returns numeric Arrays (already decoded hex)
            console.log('[PAYROLL PROVER] Patching tx.coins dest from numeric arrays to Uint8Array...');
            if (spellObj.tx && Array.isArray(spellObj.tx.coins)) {
                spellObj.tx.coins = spellObj.tx.coins.map((coin: any) => ({
                    ...coin,
                    dest: new Uint8Array(coin.dest)
                }));
                console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.coins.length} tx.coins dest entries`);
            }
            
            // Key re-patch for app_public_inputs
            if (spellObj.app_public_inputs && typeof spellObj.app_public_inputs === 'object') {
                console.log('[PAYROLL PROVER] Patching app_public_inputs keys to CBOR arrays...');
                const patchedPublicInputs = new Map();
                for (const [key, value] of Object.entries(spellObj.app_public_inputs)) {
                    const parts = (key as string).split('/');
                    if (parts.length === 3 && (parts[0] === 'n' || parts[0] === 't')) {
                        const [tag, idHex, vkHex] = parts;
                        const complexKey = [tag, hexToBytes(idHex), hexToBytes(vkHex)];
                        patchedPublicInputs.set(complexKey, value);
                        console.log(`[PAYROLL PROVER] Patched key: ${key} -> [${tag}, <${idHex.length} bytes>, <${vkHex.length} bytes>]`);
                    } else {
                        patchedPublicInputs.set(key, value);
                    }
                }
                spellObj.app_public_inputs = patchedPublicInputs;
                console.log('[PAYROLL PROVER] app_public_inputs patched to Map with array keys');
            }
            
        } else if (request.type === 'mint-token') {
            // =========================================================================
            // TOKEN MINTING PATH - Restore Binary Patching
            // tx.ins: MUST be 36-byte Uint8Arrays (Byte Strings)
            // tx.outs: MUST be a Map with INTEGER keys
            // tx.coins.dest: MUST be Uint8Arrays (Byte Strings)
            // app_public_inputs: MUST be Map with Uint8Array keys
            // =========================================================================
            console.log('[PAYROLL PROVER] TOKEN PATH: Restoring Binary Parity...');
            
            // 1. tx.ins: MUST be 36-byte Uint8Arrays (Byte Strings)
            // Use your existing utxoTo36Bytes helper [Source 789]
            console.log('[PAYROLL PROVER] Converting tx.ins to 36-byte Uint8Arrays...');
            if (!request.authorityUtxo || !request.fundingUtxo) {
                throw new Error('Missing authorityUtxo or fundingUtxo for tx.ins');
            }
            spellObj.tx.ins = [
                utxoTo36Bytes(request.authorityUtxo),
                utxoTo36Bytes(request.fundingUtxo)
            ];
            console.log(`[PAYROLL PROVER] tx.ins converted to Uint8Arrays (${spellObj.tx.ins[0].length} bytes each)`);
            
            // 2. tx.outs: MUST be a Map with INTEGER keys [Source 110]
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
            
            // 3. tx.coins.dest: MUST be Uint8Arrays (Byte Strings)
            // Reconstruct with Parallel Coin Mapping using Uint8Array
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
            
            // 4. app_public_inputs: MUST be Map with Uint8Array keys [Source 110]
            console.log('[PAYROLL PROVER] Converting app_public_inputs to Map with Uint8Array keys...');
            const appIdBytes = new Uint8Array(Buffer.from(finalAppId!, 'hex'));
            const appVkBytes = new Uint8Array(Buffer.from(APP_VK, 'hex'));
            const publicInputsMap = new Map();
            
            // Format: ["tag", identity_bytes, vk_bytes]
            publicInputsMap.set(["n", appIdBytes, appVkBytes], null);
            publicInputsMap.set(["t", appIdBytes, appVkBytes], null);
            spellObj.app_public_inputs = publicInputsMap;
            console.log('[PAYROLL PROVER] app_public_inputs converted to Map with Uint8Array keys');
        }
        
        // DEBUG: Log the final spellObj structure before CBOR encoding
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
        console.log(`  app_public_inputs type: ${spellObj.app_public_inputs?.constructor?.name}`);
        
    } catch (error: any) {
        console.error('[PAYROLL PROVER] WASM processing failed:', error);
        throw new Error(`WASM processing failed: ${error.message}`);
    }

    // ----------------------------------------------------------------------------
    // Step 5: Wrap for Transport - CBOR Encoding
    // Convert the spell object to CBOR hex string
    // ----------------------------------------------------------------------------
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

    // ----------------------------------------------------------------------------
    // Step 6: Prepare Asset Encoding
    // =========================================================================
    // UNIVERSAL AUTHORITY WITNESS FOR PHASE 1 AND PHASE 2
    // =========================================================================
    const wasmBase64 = getWasmBase64();
    console.log(`[PAYROLL PROVER] WASM base64 length: ${wasmBase64.length}`);
    
    // Universal Authority: Use Anchor UTXO for both phases
    let identityToProve: string;
    
    if (request.type === 'mint-nft') {
        if (!request.anchorUtxo) {
            throw new Error('No anchorUtxo available for mint-nft witness');
        }
        identityToProve = request.anchorUtxo;
        console.log(`[PAYROLL PROVER] mint-nft: Using anchorUtxo as witness`);
    } else {
        identityToProve = (request as any).planMetadata?.anchorUtxo || request.anchorUtxo;
        if (!identityToProve) {
            throw new Error('No anchorUtxo available for mint-token witness. Ensure planMetadata.anchorUtxo is provided.');
        }
        console.log(`[PAYROLL PROVER] mint-token: Using planMetadata.anchorUtxo as witness`);
    }
    
    const witnessHex = utxoIdToHexWitness(identityToProve);
    console.log(`[PAYROLL PROVER] Identity to prove: ${identityToProve}`);
    console.log(`[PAYROLL PROVER] Witness hex (CBOR-wrapped): ${witnessHex.substring(0, 50)}...`);

    // ----------------------------------------------------------------------------
    // Step 7: Clean prev_txs hex strings
    // ----------------------------------------------------------------------------
    const cleanedPrevTxs = prevTxHexes.map(hex => hex.replace(/\s/g, '').toLowerCase());
    console.log(`[PAYROLL PROVER] Cleaned ${cleanedPrevTxs.length} prev_txs`);
    
    cleanedPrevTxs.forEach((hex, i) => {
        console.log(`[PAYROLL PROVER] prev_txs[${i}] length: ${hex.length} characters`);
        if (hex.length > 0) {
            console.log(`[PAYROLL PROVER] prev_txs[${i}] prefix: ${hex.substring(0, 50)}...`);
        }
    });

    // ----------------------------------------------------------------------------
    // Step 8: Build the final request body for Prover API
    // ----------------------------------------------------------------------------
    const requestBody: any = {
        spell: spellHex,
        app_private_inputs: {
            [`n/${finalAppId}/${APP_VK}`]: witnessHex
        },
        binaries: {
            [APP_VK]: wasmBase64
        },
        prev_txs: cleanedPrevTxs.map(hex => ({ bitcoin: hex })),
        change_address: request.changeAddress,
        fee_rate: request.feeRate || 2.0,
        chain: "bitcoin"
    };

    // Add token app_private_inputs for mint-token
    if (request.type === 'mint-token') {
        requestBody.app_private_inputs[`t/${finalAppId}/${APP_VK}`] = witnessHex;
        console.log(`[PAYROLL PROVER] Added token app_private_inputs for mint-token`);
    }

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
    console.log('[PAYROLL PROVER] prev_txs length:', requestBody.prev_txs?.length);
    console.log('[PAYROLL PROVER] change_address:', requestBody.change_address);
    console.log('[PAYROLL PROVER] fee_rate:', requestBody.fee_rate);
    console.log('[PAYROLL PROVER] chain:', requestBody.chain);
    
    const requestBodySize = JSON.stringify(requestBody).length;
    console.log(`[PAYROLL PROVER] Request body JSON size: ${requestBodySize} bytes`);

    // ----------------------------------------------------------------------------
    // Step 9: Send to Prover API with retries
    // ----------------------------------------------------------------------------
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

            const fsModule = require('fs');
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

// --------------------------------------------------------------------------------
// Helper Functions
// --------------------------------------------------------------------------------

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
    // =========================================================================
    // CRITICAL FIX: Extract TXIDs and fetch raw transaction hexes
    // =========================================================================
    
    // Extract TXIDs from the "txid:vout" strings
    const [planTxid] = planUtxo.split(':');
    const [fundingTxid] = fundingUtxo.utxo.split(':');

    console.log('[PAYROLL PROVER] Fetching required hexes for Provenance...');
    console.log(`[PAYROLL PROVER] Plan TXID: ${planTxid}`);
    console.log(`[PAYROLL PROVER] Funding TXID: ${fundingTxid}`);
    
    const planHex = await fetchTransactionHex(planTxid);
    const fundingHex = await fetchTransactionHex(fundingTxid);
    
    console.log(`[PAYROLL PROVER] Plan hex length: ${planHex.length} chars`);
    console.log(`[PAYROLL PROVER] Funding hex length: ${fundingHex.length} chars`);

    // =========================================================================
    // CRITICAL FIX: Populate anchorUtxo from planMetadata for authority witness
    // The anchorUtxo must be the original UTXO that created the appId (from Phase 1)
    // planMetadata contains anchorUtxo from the plans DB lookup
    // =========================================================================
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
        // CRITICAL: Pull the original creation anchor from DB metadata
        anchorUtxo: anchorUtxoFromMetadata,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        outputs: [
            ...workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
            { address: employerAddress, nftMetadata: planMetadata }
        ],
        // Ensure planMetadata is passed for internal use (witness fallback)
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
    // Extract TXIDs from the "txid:vout" strings
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
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    };
    
    return generateUnsignedTransactions(request, [anchorHex, fundingHex], treasuryHexDest, undefined, utxoAddress);
}