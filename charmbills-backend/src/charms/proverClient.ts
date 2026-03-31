import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import { buildMintNFT } from './buildMintNFT';
import { buildMintToken } from './buildMintToken';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';
import * as crypto from 'crypto';

bitcoin.initEccLib(ecc);
dotenv.config();

const execAsync = promisify(exec);

// --------------------------------------------------------------------------------
// Configuration & Constants
// --------------------------------------------------------------------------------
const PROVER_URL = process.env.PROVER_API_URL || constants.PROVER_API_URL;
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const PROVER_TIMEOUT_MS = 180000;

// CRITICAL: Use absolute path to the charms binary to avoid PATH issues
const CHARMS_BIN = process.env.CHARMS_BIN_PATH || '/home/ubuntu/.cargo/bin/charms';
const ENGINE_DIR = path.resolve(process.cwd(), '../subscription-engine');

// CRITICAL: Path to the compiled WASM file for the app contract
const WASM_PATH = process.env.WASM_PATH || path.join(ENGINE_DIR, 'target/wasm32-wasip1/release/prover-engine.wasm');

// Helper: Derive App ID from UTXO
function deriveAppId(utxoId: string): string {
    if (!utxoId || typeof utxoId !== 'string') {
        throw new Error('Invalid utxoId: must be non-empty string');
    }
    return crypto.createHash('sha256').update(utxoId).digest('hex');
}

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
        // Handle array response
        if (Array.isArray(responseData)) {
            const tx = responseData.length === 1 ? responseData[0] : responseData[index];
            if (!tx) {
                throw new Error(`Prover response missing transaction at index ${index}`);
            }
            // If the item is an object with bitcoin property
            if (typeof tx === 'object' && tx !== null && tx.bitcoin && typeof tx.bitcoin === 'string') {
                return tx.bitcoin;
            }
            // If the item is a string directly
            if (typeof tx === 'string') {
                return tx;
            }
            // If the item is an object with hex property
            if (typeof tx === 'object' && tx !== null && tx.hex && typeof tx.hex === 'string') {
                return tx.hex;
            }
            throw new Error(`Unexpected transaction shape: ${JSON.stringify(tx).substring(0, 100)}`);
        }
        
        // Handle direct object response
        if (typeof responseData === 'object' && responseData !== null) {
            if (responseData.bitcoin && typeof responseData.bitcoin === 'string') {
                return responseData.bitcoin;
            }
            if (responseData.hex && typeof responseData.hex === 'string') {
                return responseData.hex;
            }
        }
        
        // Handle string response
        if (typeof responseData === 'string') {
            return responseData;
        }
        
        throw new Error(`Unexpected response format: ${typeof responseData}`);
    } catch (error) {
        console.error('[PAYROLL PROVER] Failed to decode JSON response:', error);
        throw new Error(`Failed to decode prover response: ${error}`);
    }
}

// --------------------------------------------------------------------------------
// Main Prover Function - Direct Binary Execution with Pipeline
// --------------------------------------------------------------------------------

export async function generateUnsignedTransactions(
    request: SpellRequest,
    prevTxHexes: string[],
    treasuryHexDest: string,
    appId?: string
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

    // Check if charms binary exists
    if (!fs.existsSync(CHARMS_BIN)) {
        throw new Error(`Charms binary not found at: ${CHARMS_BIN}`);
    }

    // Check if WASM file exists
    if (!fs.existsSync(WASM_PATH)) {
        throw new Error(`WASM file not found at: ${WASM_PATH}`);
    }

    // Check if engine directory exists
    if (!fs.existsSync(ENGINE_DIR)) {
        throw new Error(`Engine directory not found at: ${ENGINE_DIR}`);
    }

    // ----------------------------------------------------------------------------
    // Step 2: Build spell and capture template variables from builders
    // ----------------------------------------------------------------------------
    let builtAppId: string | undefined;
    let spellVars: Record<string, string> = {};

    try {
        if (request.type === 'mint-nft') {
            const result = buildMintNFT(request, treasuryHexDest);
            builtAppId = result.appId;
            spellVars = result.spellVars;
            console.log('[PAYROLL PROVER] Built mint-nft spell');
            console.log(`[PAYROLL PROVER] Captured ${Object.keys(spellVars).length} template variables from mint-nft`);
        } else if (request.type === 'mint-token') {
            if (!appId) throw new Error("appId required for mint-token");
            
            if (!request.anchorUtxo) {
                throw new Error("anchorUtxo required for mint-token spell building");
            }
            
            spellVars = buildMintToken(
                request, 
                appId, 
                request.anchorUtxo, 
                treasuryHexDest
            );
            builtAppId = appId;
            console.log('[PAYROLL PROVER] Built mint-token spell');
            console.log(`[PAYROLL PROVER] Captured ${Object.keys(spellVars).length} template variables from mint-token`);
        } else {
            throw new Error(`Unsupported action: ${request.type}`);
        }
    } catch (error: any) {
        console.error('[PAYROLL PROVER] Spell building failed:', error);
        throw new Error(`Failed to build spell: ${error.message}`);
    }

    // ----------------------------------------------------------------------------
    // Step 3: Clean prev_txs hex strings
    // ----------------------------------------------------------------------------
    const cleanedPrevTxs = prevTxHexes.map(hex => hex.replace(/\s/g, '').toLowerCase());
    console.log(`[PAYROLL PROVER] Cleaned ${cleanedPrevTxs.length} prev_txs`);

    // ----------------------------------------------------------------------------
    // Step 4: Determine spell template path
    // ----------------------------------------------------------------------------
    let spellPath: string;
    let privateTemplatePath: string | undefined;

    if (request.type === 'mint-nft') {
        spellPath = path.join(ENGINE_DIR, 'spells/mint-nft.yaml');
        privateTemplatePath = path.join(ENGINE_DIR, 'spells/mint-nft-private.yaml');
    } else if (request.type === 'mint-token') {
        spellPath = path.join(ENGINE_DIR, 'spells/mint-token.yaml');
        privateTemplatePath = path.join(ENGINE_DIR, 'spells/mint-nft-private.yaml');
    } else {
        spellPath = path.join(ENGINE_DIR, 'spells/send.yaml');
        privateTemplatePath = path.join(ENGINE_DIR, 'spells/mint-nft-private.yaml');
    }

    if (!fs.existsSync(spellPath)) {
        throw new Error(`Spell template not found at: ${spellPath}`);
    }
    
    console.log(`[PAYROLL PROVER] Template path: ${spellPath}`);

    // ----------------------------------------------------------------------------
    // Step 5: Derive/Set App ID and VK
    // ----------------------------------------------------------------------------
    const finalAppId = builtAppId || appId || deriveAppId(request.anchorUtxo || '');
    const appVk = APP_VK;

    console.log(`[PAYROLL PROVER] App ID: ${finalAppId.substring(0, 32)}...`);
    console.log(`[PAYROLL PROVER] App VK: ${appVk.substring(0, 32)}...`);

    // ----------------------------------------------------------------------------
    // Step 6: Create private inputs file with proper substitution
    // ----------------------------------------------------------------------------
    let tempPrivatePath: string | null = null;
    
    if (privateTemplatePath && fs.existsSync(privateTemplatePath)) {
        try {
            let privateContent = fs.readFileSync(privateTemplatePath, 'utf8');
            
            console.log(`[PAYROLL PROVER] Original private template content:\n${privateContent}`);
            
            privateContent = privateContent
                .replace(/\$\{app_id\}/g, finalAppId)
                .replace(/\$\{app_vk\}/g, appVk)
                .replace(/\$\{anchor_utxo\}/g, request.anchorUtxo || '');
            
            console.log(`[PAYROLL PROVER] Substituted private template content:\n${privateContent}`);
            
            tempPrivatePath = `/tmp/charms-private-${Date.now()}.yaml`;
            fs.writeFileSync(tempPrivatePath, privateContent, 'utf8');
            
            console.log(`[PAYROLL PROVER] Physically wrote substituted private inputs to: ${tempPrivatePath}`);
            console.log(`[PAYROLL PROVER] Private file size: ${privateContent.length} bytes`);
        } catch (err: any) {
            console.error('[PAYROLL PROVER] Failed to create private inputs file:', err.message);
        }
    }

    // ----------------------------------------------------------------------------
    // Step 7: Prepare variables for environment injection
    // CRITICAL: Use camelCase to match Rust #[serde(rename_all = "camelCase")]
    // The YAML template uses placeholders like ${metadataHash}, ${compensationSats}
    // ----------------------------------------------------------------------------
    const variables: Record<string, string> = {
        // App identifiers
        app_id: finalAppId,
        app_vk: appVk,
        
        // UTXO inputs
        anchor_utxo: request.anchorUtxo || '',
        funding_utxo: request.fundingUtxo || '',
        in_utxo_0: request.anchorUtxo || '',
        
        // Change address
        change_address: request.changeAddress,
        
        // Treasury destination
        treasury_hex_dest: treasuryHexDest,
        dest_0: treasuryHexDest,
        
        // Compensation - MUST be pure numeric string and >= 1000
        compensationSats: "1000",
        
        // Spread all spellVars (these will override defaults)
        ...spellVars
    };

    // Remove any undefined values
    Object.keys(variables).forEach(key => {
        if (variables[key] === undefined || variables[key] === '') {
            delete variables[key];
        }
    });

    console.log(`[PAYROLL PROVER] Prepared ${Object.keys(variables).length} variables for environment`);
    
    // Log important variables
    const importantVars = ['app_id', 'anchor_utxo', 'funding_utxo', 'ticker', 'remaining', 'compensationSats', 'worker_count'];
    importantVars.forEach(key => {
        if (variables[key]) {
            const value = variables[key].length > 60 ? variables[key].substring(0, 60) + '...' : variables[key];
            console.log(`  ${key}: ${value}`);
        }
    });

    // ----------------------------------------------------------------------------
    // Step 8: DEBUG - Log the substituted YAML before sending to prover
    // ----------------------------------------------------------------------------
    try {
        const { stdout: substitutedPublicYaml } = await execAsync(`cat ${spellPath} | envsubst`, {
            env: { ...process.env, ...variables }
        });
        console.log('[PAYROLL PROVER] [DEBUG] Substituted Public YAML:\n', substitutedPublicYaml);
    } catch (err: any) {
        console.warn('[PAYROLL PROVER] [DEBUG] Failed to preview substituted YAML:', err.message);
    }

    if (tempPrivatePath && fs.existsSync(tempPrivatePath)) {
        const substitutedPrivateYaml = fs.readFileSync(tempPrivatePath, 'utf8');
        console.log('[PAYROLL PROVER] [DEBUG] Substituted Private YAML:\n', substitutedPrivateYaml);
    }

    // ----------------------------------------------------------------------------
    // Step 9: Build the prev_txs arguments
    // ----------------------------------------------------------------------------
    const prevTxsArgs = cleanedPrevTxs.map(hex => `--prev-txs=${hex}`).join(' ');

    // ----------------------------------------------------------------------------
    // Step 10: Build the command with pipeline
    // CRITICAL: Must include --app-bins flag pointing to the WASM file
    // The pipeline: cat template | envsubst | charms spell prove --payload --app-bins=... --prev-txs=... --private-inputs=... --change-address=...
    // ----------------------------------------------------------------------------
    const privateInputsArg = (tempPrivatePath && fs.existsSync(tempPrivatePath)) 
        ? ` --private-inputs="${tempPrivatePath}"` 
        : "";

    const command = `cat ${spellPath} | envsubst | ${CHARMS_BIN} spell prove --payload --app-bins=${WASM_PATH} ${prevTxsArgs}${privateInputsArg} --change-address=${request.changeAddress}`;
    
    console.log(`[PAYROLL PROVER] 🚀 Executing Direct Prover Call`);
    console.log(`[PAYROLL PROVER] Command: ${command.substring(0, 200)}...`);
    console.log(`[PAYROLL PROVER] WASM Path: ${WASM_PATH}`);
    
    try {
        // Execute the command with variables as environment
        const { stdout, stderr } = await execAsync(command, {
            env: { ...process.env, ...variables },
            timeout: 60000,
            maxBuffer: 10 * 1024 * 1024,
            shell: '/bin/bash'
        });
        
        if (stderr) {
            console.warn('[PAYROLL PROVER] Stderr:', stderr);
        }
        
        // CRITICAL FIX: Parse stdout into cliPayload
        const cliPayload = JSON.parse(stdout);
        
        console.log('[PAYROLL PROVER] ✅ Successfully generated API payload');
        console.log(`[PAYROLL PROVER] Payload has spell field: ${!!cliPayload.spell}`);
        console.log(`[PAYROLL PROVER] Spell hex length: ${cliPayload.spell?.length || 0}`);
        console.log(`[PAYROLL PROVER] Spell prefix: ${cliPayload.spell?.substring(0, 4) || 'none'}`);
        
        // ----------------------------------------------------------------------------
        // Step 11: Build final request body for Prover API
        // CRITICAL: Use snake_case for top-level keys to match API requirements
        // ----------------------------------------------------------------------------
        const requestBody = {
            spell: cliPayload.spell,
            app_private_inputs: cliPayload.app_private_inputs || {},
            binaries: cliPayload.binaries || {},
            prev_txs: prevTxHexes.map(hex => ({ 
                bitcoin: hex.replace(/\s/g, '').toLowerCase() 
            })),
            change_address: request.changeAddress,  // snake_case
            fee_rate: request.feeRate || 2.0,       // snake_case
            chain: "bitcoin"                         // snake_case
        };

        console.log('[PAYROLL PROVER] ===== FINAL REQUEST BODY DEBUG =====');
        console.log('[PAYROLL PROVER] spell type:', typeof requestBody.spell);
        console.log('[PAYROLL PROVER] spell length:', requestBody.spell?.length);
        console.log('[PAYROLL PROVER] spell preview (first 100 chars):', requestBody.spell?.substring(0, 100));

        console.log('[PAYROLL PROVER] app_private_inputs type:', typeof requestBody.app_private_inputs);
        console.log('[PAYROLL PROVER] app_private_inputs keys:', Object.keys(requestBody.app_private_inputs || {}));

        console.log('[PAYROLL PROVER] binaries type:', typeof requestBody.binaries);
        console.log('[PAYROLL PROVER] binaries keys:', Object.keys(requestBody.binaries || {}));

        console.log('[PAYROLL PROVER] prev_txs type:', typeof requestBody.prev_txs);
        console.log('[PAYROLL PROVER] prev_txs is array:', Array.isArray(requestBody.prev_txs));
        console.log('[PAYROLL PROVER] prev_txs length:', requestBody.prev_txs?.length);
        console.log('[PAYROLL PROVER] prev_txs[0] preview:', JSON.stringify(requestBody.prev_txs?.[0] || {}).substring(0, 100));
        console.log('[PAYROLL PROVER] prev_txs[1] preview:', JSON.stringify(requestBody.prev_txs?.[1] || {}).substring(0, 100));

        console.log('[PAYROLL PROVER] change_address:', requestBody.change_address);
        console.log('[PAYROLL PROVER] fee_rate:', requestBody.fee_rate);
        console.log('[PAYROLL PROVER] chain:', requestBody.chain);
        console.log('[PAYROLL PROVER] ===== END REQUEST BODY DEBUG =====');
        
        console.log('[PAYROLL PROVER] Request body constructed:', {
            spellHexLength: requestBody.spell.length,
            spellPrefix: requestBody.spell.substring(0, 4),
            appPrivateInputsKeys: Object.keys(requestBody.app_private_inputs),
            binariesCount: Object.keys(requestBody.binaries).length,
            prevTxsCount: requestBody.prev_txs.length,
            change_address: requestBody.change_address,
            fee_rate: requestBody.fee_rate,
            chain: requestBody.chain
        });
        
        // ----------------------------------------------------------------------------
        // Step 12: Send to Prover API with retries
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
                    elapsedSec: (elapsed/1000).toFixed(1),
                    responseLength: Array.isArray(response.data) ? response.data.length : 'not array'
                });
                
                // ----------------------------------------------------------------------------
                // CRITICAL: Extract transactions from the Prover response with isSingle flag
                // ----------------------------------------------------------------------------
                const resultData = response.data;
                let finalCommitTxHex: string;
                let finalSpellTxHex: string;
                let finalIsSingleMode: boolean;
                
                if (Array.isArray(resultData)) {
                    if (resultData.length === 1) {
                        // Single transaction mode - both commit and spell are combined
                        const combined = extractTxHexFromJson(resultData, 0);
                        finalCommitTxHex = combined;
                        finalSpellTxHex = combined;
                        finalIsSingleMode = true;
                        console.log('[PAYROLL PROVER] Response: Single transaction mode - using same hex for both');
                    } else if (resultData.length >= 2) {
                        // Two transaction mode - separate commit and spell
                        finalCommitTxHex = extractTxHexFromJson(resultData, 0);
                        finalSpellTxHex = extractTxHexFromJson(resultData, 1);
                        finalIsSingleMode = false;
                        console.log('[PAYROLL PROVER] Response: Two transaction mode - separate commit and spell');
                    } else {
                        throw new Error(`Unexpected response array length: ${resultData.length}`);
                    }
                } else {
                    // Direct object response
                    finalCommitTxHex = extractTxHexFromJson(resultData, 0);
                    finalSpellTxHex = finalCommitTxHex;
                    finalIsSingleMode = true;
                    console.log('[PAYROLL PROVER] Response: Single transaction mode (object response)');
                }
        
                console.log('[PAYROLL PROVER] Successfully extracted hexes:', {
                    commit: finalCommitTxHex.substring(0, 10) + '...',
                    spell: finalSpellTxHex.substring(0, 10) + '...',
                    isSingle: finalIsSingleMode,
                    commitLength: finalCommitTxHex.length,
                    spellLength: finalSpellTxHex.length
                });
        
                console.log('[PAYROLL PROVER] ===== SUCCESS =====\n');
        
                return { 
                    commitTxHex: finalCommitTxHex, 
                    spellTxHex: finalSpellTxHex,
                    isSingle: finalIsSingleMode,
                    dualUtxoContext: {
                        anchor: { 
                            utxoId: request.anchorUtxo!, 
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
                
                if (error.response) {
                    console.error(`\n[PAYROLL PROVER] ❌ Attempt ${attempt + 1} failed:`);
                    console.error(`  Status: ${error.response.status}`);
                    console.error(`  Status Text: ${error.response.statusText}`);
                    console.error(`  Response Data:`, JSON.stringify(error.response.data, null, 2));
                } else {
                    console.error(`\n[PAYROLL PROVER] ❌ Attempt ${attempt + 1} failed:`, error.message);
                }
                
                if (error.response?.status >= 400 && error.response?.status < 500) break;
                
                if (attempt < MAX_RETRIES) {
                    const delay = calculateBackoff(attempt);
                    console.log(`Retrying in ${Math.round(delay/1000)}s...`);
                    await sleep(delay);
                }
            }
        }
        
        throw lastError || new Error('All retries failed');
        
    } catch (error: any) {
        console.error('[PAYROLL PROVER] ❌ Command execution failed:', error.message);
        if (error.stderr) {
            console.error('[PAYROLL PROVER] Stderr:', error.stderr);
        }
        throw new Error(`Failed to execute charms command: ${error.message}`);
    } finally {
        // Cleanup temp private inputs file
        if (tempPrivatePath && fs.existsSync(tempPrivatePath)) {
            try {
                fs.unlinkSync(tempPrivatePath);
                console.log(`[PAYROLL PROVER] Cleaned up private inputs file: ${tempPrivatePath}`);
            } catch (err: any) {
                console.warn(`[PAYROLL PROVER] Failed to cleanup temp file: ${err.message}`);
            }
        }
    }
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
    employerAddress: string,  // ✅ Added: Employer address for NFT return
    planMetadata: any,         // ✅ Added: Plan NFT metadata for return output
    treasuryHexDest: string,   // ✅ Added: Treasury hex destination
    multiSigSigners?: string[]
): Promise<ProverResult> {
    const request: SpellRequest = {
        type: 'mint-token',
        authorityUtxo: planUtxo,
        anchorUtxo: process.env.PAYROLL_ANCHOR_UTXO,
        fundingUtxo: fundingUtxo.utxo,
        fundingUtxoValue: fundingUtxo.value,
        changeAddress: changeAddress,
        feeRate: constants.DEFAULT_FEE_RATE,
        outputs: [
            // 1. Worker tokens (M employees)
            ...workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
            // 2. NFT return to employer (Authority return) ✅
            { address: employerAddress, nftMetadata: planMetadata }
        ],
        ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
    };

    // v0.12 requires the Plan NFT (authority) and Funding UTXO in prev_txs
    return generateUnsignedTransactions(request, [planUtxo, fundingUtxo.utxo], treasuryHexDest, appId);
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
    
    return generateUnsignedTransactions(request, [anchorUtxo, fundingUtxo.utxo], treasuryHexDest);
}