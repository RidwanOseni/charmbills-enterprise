import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { encode } from 'cbor-x';
import { bytesToHex } from '@noble/hashes/utils';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import { buildMintNFTJSON } from './buildMintNFT';
import { buildMintTokenJSON } from './buildMintToken';

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

// Helper: Get WASM binary as base64
function getWasmBase64(): string {
    console.log(`[PAYROLL PROVER] Loading WASM from: ${WASM_PATH}`);
    
    if (!fs.existsSync(WASM_PATH)) {
        throw new Error(`CRITICAL: WASM binary not found at ${WASM_PATH}. Run 'cargo build' in subscription-engine.`);
    }
    
    const wasmBuffer = fs.readFileSync(WASM_PATH);
    const wasmBase64 = wasmBuffer.toString('base64');
    console.log(`[PAYROLL PROVER] WASM loaded: ${wasmBuffer.length} bytes, base64 length: ${wasmBase64.length}`);
    
    return wasmBase64;
}

// Helper: Encode spell object to CBOR hex string
function encodeSpellToCborHex(spellObj: any): string {
    console.log('[PAYROLL PROVER] Encoding spell to CBOR...');
    const encoded = encode(spellObj);
    const spellHex = bytesToHex(encoded);
    console.log(`[PAYROLL PROVER] CBOR encoded: ${encoded.length} bytes, hex length: ${spellHex.length}`);
    console.log(`[PAYROLL PROVER] Spell hex prefix: ${spellHex.substring(0, 50)}...`);
    return spellHex;
}

// Helper: Convert Bitcoin address to hex-encoded script destination using Charms CLI
// This uses the official 'charms util dest' command to ensure format matches the prover
function addressToHexDest(address: string): string {
    try {
        console.log(`[PAYROLL PROVER] Converting address using charms util dest: ${address.substring(0, 20)}...`);
        const output = execSync(`charms util dest --addr ${address}`, { encoding: 'utf8' });
        const hexDest = output.trim();
        console.log(`[PAYROLL PROVER] charms util dest output: ${hexDest.substring(0, 50)}...`);
        return hexDest;
    } catch (error: any) {
        console.error(`[PAYROLL PROVER] charms util dest failed:`, error.message);
        throw new Error(`Failed to convert address using charms util dest: ${error.message}`);
    }
}

// --------------------------------------------------------------------------------
// Main Prover Function - Direct API Relay Model (Production)
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

    // Use passed parameter or fallback to request.utxoAddress
    const addressToUse = utxoAddress || request.utxoAddress;
    if (!addressToUse) {
        throw new Error('utxoAddress is required for app_private_inputs conversion. This should be the address associated with the anchor/authority UTXO.');
    }

    // ----------------------------------------------------------------------------
    // Step 2: Build spell JSON based on request type
    // ----------------------------------------------------------------------------
    let spellObj: any;
    let finalAppId: string | undefined = appId;

    try {
        if (request.type === 'mint-nft') {
            const result = buildMintNFTJSON(request, treasuryHexDest);
            spellObj = result.spell;
            finalAppId = result.appId;
            console.log('[PAYROLL PROVER] Built mint-nft spell JSON');
            console.log(`[PAYROLL PROVER] Spell JSON version: ${spellObj.version}`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.ins: ${spellObj.tx.ins.length} inputs`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.outs: ${spellObj.tx.outs.length} outputs`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.coins: ${spellObj.tx.coins.length} coins`);
        } else if (request.type === 'mint-token') {
            if (!appId) throw new Error("appId required for mint-token");
            spellObj = buildMintTokenJSON(request, appId, treasuryHexDest);
            finalAppId = appId;
            console.log('[PAYROLL PROVER] Built mint-token spell JSON');
            console.log(`[PAYROLL PROVER] Spell JSON version: ${spellObj.version}`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.ins: ${spellObj.tx.ins.length} inputs`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.outs: ${spellObj.tx.outs.length} outputs`);
            console.log(`[PAYROLL PROVER] Spell JSON tx.coins: ${spellObj.tx.coins.length} coins`);
        } else {
            throw new Error(`Unsupported action: ${request.type}`);
        }
    } catch (error: any) {
        console.error('[PAYROLL PROVER] Spell building failed:', error);
        throw new Error(`Failed to build spell: ${error.message}`);
    }
    
    // 👇 ADD THIS LOG HERE 👇
    console.log('[PAYROLL PROVER] ===== spellObj STRUCTURE =====');
    console.log(JSON.stringify(spellObj, null, 2));
    console.log('[PAYROLL PROVER] ===== END spellObj STRUCTURE =====');

    // ----------------------------------------------------------------------------
    // Step 3: Clean prev_txs hex strings and wrap in chain-tagged objects
    // ----------------------------------------------------------------------------
    const cleanedPrevTxs = prevTxHexes.map(hex => hex.replace(/\s/g, '').toLowerCase());
    console.log(`[PAYROLL PROVER] Cleaned ${cleanedPrevTxs.length} prev_txs`);
    
    const chainTaggedPrevTxs = cleanedPrevTxs.map(hex => ({ 
        bitcoin: hex 
    }));
    console.log(`[PAYROLL PROVER] Chain-tagged prev_txs: ${chainTaggedPrevTxs.length} items`);
    chainTaggedPrevTxs.forEach((tx, idx) => {
        console.log(`  prev_txs[${idx}]: bitcoin length=${tx.bitcoin.length}`);
    });

    // ----------------------------------------------------------------------------
    // Step 4: Build app_private_inputs with hex-encoded script destinations
    // CRITICAL: Uses charms util dest to get the correct format (matches working script)
    // ----------------------------------------------------------------------------
    const appPrivateInputs: Record<string, string> = {};

    // Convert the UTXO address to hex destination using charms util dest
    const hexDest = addressToHexDest(addressToUse);
    
    // Add n/ path
    const appPath = `n/${finalAppId}/${APP_VK}`;
    appPrivateInputs[appPath] = hexDest;
    console.log(`[PAYROLL PROVER] Added private input for ${appPath}: ${hexDest.substring(0, 50)}...`);
    
    // For mint-token, also add the t/ path with the same hex destination
    if (request.type === 'mint-token') {
        const tokenAppPath = `t/${finalAppId}/${APP_VK}`;
        appPrivateInputs[tokenAppPath] = hexDest;
        console.log(`[PAYROLL PROVER] Added private input for ${tokenAppPath}: ${hexDest.substring(0, 50)}...`);
    }

    console.log('[PAYROLL PROVER] app_private_inputs keys:', Object.keys(appPrivateInputs));

    // ----------------------------------------------------------------------------
    // Step 5: Get WASM binary and build binaries object
    // ----------------------------------------------------------------------------
    const wasmBase64 = getWasmBase64();
    
    const binaries = {
        [APP_VK]: wasmBase64
    };
    console.log(`[PAYROLL PROVER] binaries key: ${APP_VK.substring(0, 16)}..., value length: ${wasmBase64.length}`);

    // ----------------------------------------------------------------------------
    // Step 6: Encode spell to CBOR hex string
    // CRITICAL: The Prover API expects 'spell' to be a CBOR-encoded hex string
    // ----------------------------------------------------------------------------
    const spellHexString = encodeSpellToCborHex(spellObj);

    // ----------------------------------------------------------------------------
    // Step 7: Build the request body for Prover API
    // ----------------------------------------------------------------------------
    const requestBody = {
        spell: spellHexString,
        app_private_inputs: appPrivateInputs,
        binaries: binaries,
        prev_txs: chainTaggedPrevTxs,
        change_address: request.changeAddress,
        fee_rate: request.feeRate || 2.0,
        chain: "bitcoin"
    };

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
    console.log('[PAYROLL PROVER] app_private_inputs value type:', typeof Object.values(requestBody.app_private_inputs)[0]);
    console.log('[PAYROLL PROVER] app_private_inputs value first 50 chars:', Object.values(requestBody.app_private_inputs)[0]?.substring(0, 50));
    console.log('[PAYROLL PROVER] binaries value type:', typeof Object.values(requestBody.binaries)[0]);
    console.log('[PAYROLL PROVER] prev_txs[0] type:', typeof requestBody.prev_txs[0]);
    console.log('[PAYROLL PROVER] ===== END REQUEST BODY DEBUG =====');
    
    const requestBodySize = JSON.stringify(requestBody).length;
    console.log(`[PAYROLL PROVER] Request body JSON size: ${requestBodySize} bytes`);

    // ----------------------------------------------------------------------------
    // Step 8: Send to Prover API with retries
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
    utxoAddress: string,
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
        utxoAddress: utxoAddress,
        outputs: [
            ...workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
            { address: employerAddress, nftMetadata: planMetadata }
        ],
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    };

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
    utxoAddress: string,
    multiSigSigners?: string[]
): Promise<ProverResult> {
    const request: SpellRequest = {
        type: 'mint-nft',
        anchorUtxo: anchorUtxo,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        utxoAddress: utxoAddress,
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