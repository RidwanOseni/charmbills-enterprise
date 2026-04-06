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

// Helper: Convert Bitcoin address to Hex Script Destination (for app_private_inputs)
// This fixes the "Invalid character 'G'" error by using hex instead of base64
// NOTE: This function is kept for potential future use, but NOT used for witness encoding
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
        
        // DEBUG: Log raw tx.outs before patching
        console.log('[PAYROLL PROVER] DEBUG - Raw tx.outs before patching:', 
            JSON.stringify(spellObj.tx?.outs, (key, value) => {
                if (value instanceof Uint8Array) return `Uint8Array(${value.length})`;
                return value;
            }, 2));
        
        // ----------------------------------------------------------------------------
        // THE MANDATORY KEY RE-PATCH USING MAP (String "0" -> Integer 0)
        // This resolves the "expected integer" error at column 895
        // Using Map ensures numeric keys are preserved through CBOR encoding
        // ----------------------------------------------------------------------------
        console.log('[PAYROLL PROVER] Patching tx.outs string keys to integer keys using Map...');
        if (spellObj.tx && Array.isArray(spellObj.tx.outs)) {
            spellObj.tx.outs = spellObj.tx.outs.map((out: any) => {
                const patchedOutMap = new Map(); // Use a Map to allow numeric keys
                for (const [key, val] of Object.entries(out)) {
                    const numericKey = parseInt(key, 10);
                    if (!isNaN(numericKey)) {
                        // Map allows the key to remain a number 0
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
        
        // DEBUG: Log tx.outs after patching to verify Map structure
        if (spellObj.tx?.outs && spellObj.tx.outs.length > 0) {
            console.log('[PAYROLL PROVER] DEBUG - First tx.outs entry after patching (Map):');
            const firstOut = spellObj.tx.outs[0];
            for (const [key, value] of firstOut.entries()) {
                console.log(`  Key: ${key} (${typeof key}), Value: ${JSON.stringify(value).substring(0, 100)}`);
            }
        }
        
        // ----------------------------------------------------------------------------
        // THE FINAL TRANSPORT CASTS
        // Patch Inputs: Bridge returns "txid:vout" strings - convert to 36-byte Uint8Array
        // The utxoTo36Bytes function now properly reverses txid bytes to Little-Endian
        // ----------------------------------------------------------------------------
        console.log('[PAYROLL PROVER] Patching tx.ins from UTXO strings to 36-byte Uint8Array...');
        if (spellObj.tx && Array.isArray(spellObj.tx.ins)) {
            spellObj.tx.ins = spellObj.tx.ins.map((utxoId: string) => {
                const result = new Uint8Array(utxoTo36Bytes(utxoId));
                console.log(`[PAYROLL PROVER] DEBUG - Converted UTXO: ${utxoId} -> ${result.length} bytes`);
                return result;
            });
            console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.ins.length} tx.ins entries`);
        }
        
        // ----------------------------------------------------------------------------
        // Patch Destinations: Bridge returns numeric Arrays (already decoded hex)
        // We only need to cast the Array to a Uint8Array for the CBOR encoder.
        // DO NOT use hexToBytes here - the bridge already decoded the hex!
        // ----------------------------------------------------------------------------
        console.log('[PAYROLL PROVER] Patching tx.coins dest from numeric arrays to Uint8Array...');
        if (spellObj.tx && Array.isArray(spellObj.tx.coins)) {
            spellObj.tx.coins = spellObj.tx.coins.map((coin: any) => ({
                ...coin,
                dest: new Uint8Array(coin.dest)
            }));
            console.log(`[PAYROLL PROVER] Patched ${spellObj.tx.coins.length} tx.coins dest entries`);
        }
        
        // ----------------------------------------------------------------------------
        // THE KEY RE-PATCH (JSON strings -> CBOR Arrays)
        // This resolves the "expected array" error at column 1177
        // JSON cannot represent arrays as keys, so we must convert after parsing
        // ----------------------------------------------------------------------------
        if (spellObj.app_public_inputs && typeof spellObj.app_public_inputs === 'object') {
            console.log('[PAYROLL PROVER] Patching app_public_inputs keys to CBOR arrays...');
            const patchedPublicInputs = new Map();
            for (const [key, value] of Object.entries(spellObj.app_public_inputs)) {
                // Split the string key "n/appId/appVk" back into components
                const parts = (key as string).split('/');
                if (parts.length === 3 && (parts[0] === 'n' || parts[0] === 't')) {
                    const [tag, idHex, vkHex] = parts;
                    // Create a CBOR-compatible Array key with actual bytes
                    const complexKey = [tag, hexToBytes(idHex), hexToBytes(vkHex)];
                    patchedPublicInputs.set(complexKey, value);
                    console.log(`[PAYROLL PROVER] Patched key: ${key} -> [${tag}, <${idHex.length} bytes>, <${vkHex.length} bytes>]`);
                } else {
                    // Fallback for any other key format (should not happen)
                    patchedPublicInputs.set(key, value);
                }
            }
            spellObj.app_public_inputs = patchedPublicInputs;
            console.log('[PAYROLL PROVER] app_public_inputs patched to Map with array keys');
        }
        
        // DEBUG: Log the final spellObj structure before CBOR encoding
        console.log('[PAYROLL PROVER] DEBUG - Final spellObj structure summary:');
        console.log(`  version: ${spellObj.version}`);
        console.log(`  tx.ins length: ${spellObj.tx?.ins?.length || 0}, type: ${spellObj.tx?.ins?.constructor?.name}`);
        console.log(`  tx.outs length: ${spellObj.tx?.outs?.length || 0}, type: ${spellObj.tx?.outs?.constructor?.name}`);
        console.log(`  tx.coins length: ${spellObj.tx?.coins?.length || 0}, type: ${spellObj.tx?.coins?.constructor?.name}`);
        console.log(`  app_public_inputs type: ${spellObj.app_public_inputs?.constructor?.name}`);
        
    } catch (error: any) {
        console.error('[PAYROLL PROVER] WASM processing failed:', error);
        throw new Error(`WASM processing failed: ${error.message}`);
    }

    // ----------------------------------------------------------------------------
    // Step 5: Wrap for Transport - CBOR Encoding
    // Convert the spell object to CBOR hex string
    // cbor-x will correctly encode Map with array keys as CBOR arrays
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
    // CRITICAL: app_private_inputs MUST be Hex (fixes 'G' character error)
    // binaries MUST stay Base64 (working payload uses base64 for WASM)
    // =========================================================================
    // UNIVERSAL AUTHORITY WITNESS FOR PHASE 1 AND PHASE 2
    // For both mint-nft and mint-token, the witness must be the Anchor UTXO
    // This matches the AppId derivation used by the protocol
    // =========================================================================
    const wasmBuffer = getWasmBuffer();
    const wasmBase64 = wasmBuffer.toString('base64');
    console.log(`[PAYROLL PROVER] WASM base64 length: ${wasmBase64.length}`);
    
    // Universal Authority: Use Anchor UTXO for both phases
    // The identity to prove is always the anchor UTXO that created the App
    let identityToProve: string;
    
    if (request.type === 'mint-nft') {
        // Phase 1: Authority is the fresh Anchor UTXO
        if (!request.anchorUtxo) {
            throw new Error('No anchorUtxo available for mint-nft witness');
        }
        identityToProve = request.anchorUtxo;
        console.log(`[PAYROLL PROVER] mint-nft: Using anchorUtxo as witness`);
    } else {
        // Phase 2: Authority is the original Anchor UTXO saved in Plan Metadata
        // The planMetadata contains the original anchorUtxo from Phase 1
        // Note: Do NOT use utxoAddress (the worker/employer address)
        identityToProve = (request as any).planMetadata?.anchorUtxo || request.anchorUtxo;
        if (!identityToProve) {
            throw new Error('No anchorUtxo available for mint-token witness. Ensure planMetadata.anchorUtxo is provided.');
        }
        console.log(`[PAYROLL PROVER] mint-token: Using planMetadata.anchorUtxo as witness`);
    }
    
    // =========================================================================
    // CRITICAL FIX: CBOR Encode the witness string FIRST, then convert to hex
    // This adds the mandatory CBOR string prefix (0x78) so the API correctly
    // identifies it as a text string rather than an integer.
    // Without this, a witness starting with '4' (ASCII 0x34) gets decoded as
    // CBOR integer -21, causing "invalid type: integer, expected str" error.
    // =========================================================================
    const witnessCbor = encode(identityToProve);
    const witnessHex = bytesToHex(witnessCbor);
    console.log(`[PAYROLL PROVER] Identity to prove: ${identityToProve}`);
    console.log(`[PAYROLL PROVER] Witness CBOR length: ${witnessCbor.length} bytes`);
    console.log(`[PAYROLL PROVER] Witness hex (CBOR-wrapped): ${witnessHex.substring(0, 50)}...`);
    console.log(`[PAYROLL PROVER] Witness hex length: ${witnessHex.length}`);

    // ----------------------------------------------------------------------------
    // Step 7: Clean prev_txs hex strings and validate lengths
    // CRITICAL: The API requires valid transaction hexes that create the input UTXOs
    // ----------------------------------------------------------------------------
    const cleanedPrevTxs = prevTxHexes.map(hex => hex.replace(/\s/g, '').toLowerCase());
    console.log(`[PAYROLL PROVER] Cleaned ${cleanedPrevTxs.length} prev_txs`);
    
    // DEBUG: Log each prev_txs length to verify they are valid transaction hexes
    cleanedPrevTxs.forEach((hex, i) => {
        console.log(`[PAYROLL PROVER] prev_txs[${i}] length: ${hex.length} characters`);
        if (hex.length < 100) {
            console.warn(`[WARNING] prev_txs[${i}] looks too short to be a valid transaction!`);
        }
        if (hex.length > 0) {
            console.log(`[PAYROLL PROVER] prev_txs[${i}] prefix: ${hex.substring(0, 50)}...`);
        }
    });

    // ----------------------------------------------------------------------------
    // Step 8: Build the final request body for Prover API
    // spell: Hex-encoded CBOR (after Rust type-marshalling and key patching)
    // app_private_inputs: CBOR-wrapped hex string (fixes integer vs string error)
    // binaries: Base64 strings (must stay base64)
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

    // Add token app_private_inputs for mint-token (authority for the token app)
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
    
    // FIX: Type assertion for Object.values to avoid TypeScript error
    const appPrivateValue = Object.values(requestBody.app_private_inputs)[0] as string;
    const binariesValue = Object.values(requestBody.binaries)[0] as string;
    
    console.log('[PAYROLL PROVER] app_private_inputs value type:', typeof appPrivateValue);
    console.log('[PAYROLL PROVER] app_private_inputs value first 50 chars:', appPrivateValue?.substring(0, 50));
    console.log('[PAYROLL PROVER] binaries value type:', typeof binariesValue);
    console.log('[PAYROLL PROVER] binaries value first 50 chars:', binariesValue?.substring(0, 50));
    console.log('[PAYROLL PROVER] prev_txs[0] type:', typeof requestBody.prev_txs[0]);
    console.log('[PAYROLL PROVER] ===== END REQUEST BODY DEBUG =====');
    
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
    const request: SpellRequest = {
        type: 'mint-token',
        authorityUtxo: planUtxo,
        anchorUtxo: planUtxo,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        outputs: [
            ...workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
            { address: employerAddress, nftMetadata: planMetadata }
        ],
        // Pass planMetadata to provide the original anchorUtxo for Phase 2 witness
        planMetadata: planMetadata,
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    } as any;

    return generateUnsignedTransactions(request, [planUtxo, fundingUtxo.utxo], treasuryHexDest, appId, utxoAddress);
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
    
    return generateUnsignedTransactions(request, [anchorUtxo, fundingUtxo.utxo], treasuryHexDest, undefined, utxoAddress);
}