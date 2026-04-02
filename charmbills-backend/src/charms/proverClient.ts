import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { execSync } from 'child_process';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import { buildMintNFT } from './buildMintNFT';
import { buildMintToken } from './buildMintToken';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from 'tiny-secp256k1';

bitcoin.initEccLib(ecc);
dotenv.config();

// --------------------------------------------------------------------------------
// Configuration & Constants
// --------------------------------------------------------------------------------
const PROVER_URL = process.env.PROVER_API_URL || constants.PROVER_API_URL;
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const PROVER_TIMEOUT_MS = 180000;

const CHARMS_EXECUTABLE = path.join(process.env.HOME || '/home/ubuntu', '.cargo/bin/charms');
const WASM_PATH = path.resolve(process.cwd(), 'src/charms/wasm/subscription-engine.wasm');
const SPELL_TEMPLATES_DIR = path.resolve(process.cwd(), '../subscription-engine/spells');

const TEMP_PREV_TXS_FILE = path.join(process.env.HOME || '/home/ubuntu', 'charms-prev-txs.txt');
const TEMP_SCRIPT_FILE = path.join(process.env.HOME || '/home/ubuntu', 'charms-run-spell.sh');

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateBackoff(retryCount: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

function formatMultiSigInputs(request: SpellRequest): Record<string, any> | undefined {
  if (!request.multiSigSigners || request.multiSigSigners.length === 0) {
    return undefined;
  }
  return {
    public_inputs: {
      "$00": {
        signers: request.multiSigSigners,
        threshold: request.multiSigThreshold || 2
      }
    }
  };
}

function extractTxHexFromJson(responseData: any, index: number): string {
  try {
    console.log(`[DEBUG] Parsing index ${index}. Data type: ${typeof responseData}. Array length: ${Array.isArray(responseData) ? responseData.length : 'not array'}`);
    
    if (!Array.isArray(responseData)) {
      throw new Error('Prover API returned invalid response: expected array');
    }

    const tx = responseData.length === 1 ? responseData[0] : responseData[index];
    
    if (!tx) {
      throw new Error(`Prover response missing transaction at index ${index}`);
    }

    console.log(`[DEBUG] tx type: ${typeof tx}, has bitcoin property: ${typeof tx === 'object' && 'bitcoin' in tx}`);

    if (typeof tx === 'object' && tx !== null && tx.bitcoin && typeof tx.bitcoin === 'string') {
      return tx.bitcoin;
    }
    
    if (typeof tx === 'string') {
      return tx;
    }
    
    throw new Error(`Unexpected transaction shape: ${JSON.stringify(tx).substring(0, 100)}`);
  } catch (error) {
    console.error('[PAYROLL PROVER] Failed to decode JSON response:', error);
    throw new Error(`Failed to decode prover response: ${error}`);
  }
}

// --------------------------------------------------------------------------------
// Main Prover Function
// --------------------------------------------------------------------------------

export async function generateUnsignedTransactions(
  request: SpellRequest,
  prevTxHexes: string[],
  appId?: string
): Promise<ProverResult> {
  console.log('\n[PAYROLL PROVER] ===== START =====');
  console.log(`[PAYROLL PROVER] Type: ${request.type}`);
  console.log(`[PAYROLL PROVER] Outputs: ${request.outputs?.length || 0}`);
  console.log(`[PAYROLL PROVER] Multi-sig: ${request.multiSigSigners ? 'yes' : 'no'}`);

  // ----------------------------------------------------------------------------
  // Step 1: Validate inputs
  // ----------------------------------------------------------------------------
  if (!PROVER_URL) throw new Error('PROVER_API_URL not configured');
  if (!request.fundingUtxo || !request.fundingUtxoValue) throw new Error('Funding UTXO required');
  if (!request.changeAddress) throw new Error('Change address required');
  if (prevTxHexes.length !== 2) throw new Error(`v0.12 requires exactly 2 prev_txs, got ${prevTxHexes.length}`);

  // ----------------------------------------------------------------------------
  // Step 2: Build spell and capture template variables from builders
  // ----------------------------------------------------------------------------
  let builtAppId: string | undefined;
  let spellVars: Record<string, string> = {};

  try {
    if (request.type === 'mint-nft') {
      const result = buildMintNFT(request);
      builtAppId = result.appId;
      spellVars = result.spellVars;
      console.log('[PAYROLL PROVER] Built mint-nft spell');
      console.log(`[PAYROLL PROVER] Captured ${Object.keys(spellVars).length} template variables from mint-nft`);
    } else if (request.type === 'mint-token') {
      if (!appId) throw new Error("appId required for mint-token");
      spellVars = buildMintToken(request, appId);
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
  // Step 4: Determine spell template paths
  // ----------------------------------------------------------------------------
  let spellTemplatePath: string;
  let privateTemplatePath: string | undefined;

  if (request.type === 'mint-nft') {
    spellTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'mint-nft.yaml');
    privateTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'mint-nft-private.yaml');
  } else if (request.type === 'mint-token') {
    spellTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'mint-token.yaml');
    privateTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'mint-nft-private.yaml');
  } else {
    spellTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'send.yaml');
    privateTemplatePath = path.join(SPELL_TEMPLATES_DIR, 'mint-nft-private.yaml');
  }

  console.log(`[PAYROLL PROVER] Template path: ${spellTemplatePath}`);
  
  if (!fs.existsSync(spellTemplatePath)) {
    throw new Error(`Spell template not found at: ${spellTemplatePath}`);
  }

  // ----------------------------------------------------------------------------
  // Step 5: Extract metadata and calculate values (fallback only)
  // ----------------------------------------------------------------------------
  const metadata = request.outputs?.[0]?.nftMetadata;
  
  const ticker = metadata?.ticker || constants.PAYROLL_NFT_TICKER;
  const metadataHash = metadata?.metadataHash || '';
  const scrollPolicy = (metadata?.scrollPolicy ?? 0).toString();
  const payPeriodSeconds = (metadata?.payPeriodSeconds ?? 0).toString();
  const compensationSats = (metadata?.compensationSats ?? 0).toString();
  
  let remaining = '100';
  let currentSupply = '100';
  let newRemaining = '97';
  
  if (request.type === 'mint-nft') {
    remaining = (metadata?.remaining ?? 100).toString();
  } else if (request.type === 'mint-token') {
    currentSupply = (metadata?.remaining ?? 100).toString();
    const totalTokensToMint = request.outputs?.filter(o => o.tokenAmount).reduce((sum, o) => sum + (o.tokenAmount || 0), 0) || 0;
    newRemaining = (parseInt(currentSupply) - totalTokensToMint).toString();
  }

  // ----------------------------------------------------------------------------
  // Step 6: VERIFY CHARMS EXECUTABLE AND WASM EXIST
  // ----------------------------------------------------------------------------
  if (!fs.existsSync(CHARMS_EXECUTABLE)) {
    console.error(`[PAYROLL PROVER] ❌ Charms executable not found at: ${CHARMS_EXECUTABLE}`);
    throw new Error(`Charms executable not found at ${CHARMS_EXECUTABLE}`);
  }

  if (!fs.existsSync(WASM_PATH)) {
    console.error(`[PAYROLL PROVER] ❌ WASM file not found at: ${WASM_PATH}`);
    throw new Error(`WASM file not found at ${WASM_PATH}`);
  }

  // ----------------------------------------------------------------------------
  // Step 7: DYNAMIC EXPORTS & SCRIPT EXECUTION
  // ----------------------------------------------------------------------------

  try {
    const vars: Record<string, string> = {
      // 1. FALLBACK VALUES (place these FIRST)
      ticker: ticker,
      metadataHash: metadataHash,
      scrollPolicy: scrollPolicy,
      payPeriodSeconds: payPeriodSeconds,
      compensationSats: compensationSats,
      remaining: remaining,
      current_supply: currentSupply,
      new_remaining: newRemaining,
      
      // 2. BUILDER RESULTS (place these SECOND to overwrite defaults)
      ...spellVars,

      // 3. Core Identity (always overwrite with request values)
      app_id: builtAppId || appId || '',
      app_vk: APP_VK,
      
      // 4. Authority Witnesses
      anchor_utxo: request.anchorUtxo || '', 
      in_utxo_0: request.anchorUtxo || '',   

      // 5. Input UTXOs
      plan_utxo: request.authorityUtxo || '',
      funding_utxo: request.fundingUtxo,
      in_utxo_token: request.authorityUtxo || '',

      // 6. Bitcoin Networking
      change_address: request.changeAddress
    };

    if (request.type === 'mint-token' && !spellVars.worker_address_1 && !spellVars.worker_hex_dest_1) {
      const workerOutputs = request.outputs?.filter(o => o.tokenAmount) || [];
      if (workerOutputs.length > 0) vars.worker_address_1 = workerOutputs[0].address;
      if (workerOutputs.length > 1) vars.worker_address_2 = workerOutputs[1].address;
      if (workerOutputs.length > 2) vars.worker_address_3 = workerOutputs[2].address;
      console.log(`[PAYROLL PROVER] Adding ${workerOutputs.length} workers via fallback`);
    }

    if (process.env.NODE_ENV !== 'production') {
      console.log('[PAYROLL PROVER] Environment variables prepared:');
      const varKeys = Object.keys(vars);
      console.log(`  Total variables: ${varKeys.length}`);
      
      const importantVars = ['app_id', 'anchor_utxo', 'plan_utxo', 'funding_utxo', 'worker_count', 'change_amount', 'treasury_hex_dest', 'current_supply', 'new_remaining'];
      importantVars.forEach(key => {
        if (vars[key]) {
          const value = vars[key].length > 50 ? vars[key].substring(0, 50) + '...' : vars[key];
          console.log(`  ${key}: ${value}`);
        }
      });
    }

    const exportCommands = Object.entries(vars)
      .map(([k, v]) => `export ${k}="${v.replace(/"/g, '\\"')}"`)
      .join('\n');

    fs.writeFileSync(TEMP_PREV_TXS_FILE, cleanedPrevTxs.join('\n'));

    const appBinsArg = `--app-bins=${WASM_PATH}`;
    
    let privateInputsArg = '';
    if (privateTemplatePath && fs.existsSync(privateTemplatePath)) {
      const privateTemplateContent = fs.readFileSync(privateTemplatePath, 'utf8');
      let substitutedPrivate = privateTemplateContent;
      Object.entries(vars).forEach(([k, v]) => {
        const placeholder = `\${${k}}`;
        substitutedPrivate = substitutedPrivate.replace(new RegExp(placeholder.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), v);
      });
      const tempPrivateFile = path.join(process.env.HOME || '/home/ubuntu', `charms-private-${Date.now()}.yaml`);
      fs.writeFileSync(tempPrivateFile, substitutedPrivate);
      privateInputsArg = `--private-inputs="${tempPrivateFile}"`;
      setTimeout(() => {
        try { fs.unlinkSync(tempPrivateFile); } catch(e) {}
      }, 10000);
    }
    
    const scriptContent = `#!/bin/bash
set -e
${exportCommands}
cat "${spellTemplatePath}" | envsubst | "${CHARMS_EXECUTABLE}" spell prove --payload -o json \\
  ${appBinsArg} \\
  $(cat "${TEMP_PREV_TXS_FILE}" | xargs -I {} echo --prev-txs={}) \\
  ${privateInputsArg} \\
  --change-address="${request.changeAddress}"`;

    fs.writeFileSync(TEMP_SCRIPT_FILE, scriptContent);
    fs.chmodSync(TEMP_SCRIPT_FILE, '755');

    console.log(`[PAYROLL PROVER] 🚀 Executing Script Proxy: ${TEMP_SCRIPT_FILE}`);
    console.log(`[PAYROLL PROVER] Script contains ${Object.keys(vars).length} environment variables`);

    const stdout = execSync(TEMP_SCRIPT_FILE, { encoding: 'utf8', shell: '/bin/bash' });
    const requestBody = JSON.parse(stdout);

    console.log('[PAYROLL PROVER] ✅ Successfully generated API payload.');

    // ABSOLUTE SOURCE OF TRUTH - Log structure only (no large binaries)
    console.log('\n[PAYROLL PROVER] ===== ABSOLUTE SOURCE OF TRUTH (STRUCTURE ONLY) =====');
    console.log('[PAYROLL PROVER] spell type:', typeof requestBody.spell);
    console.log('[PAYROLL PROVER] spell is string?', typeof requestBody.spell === 'string');
    console.log('[PAYROLL PROVER] spell length:', requestBody.spell?.length);
    console.log('[PAYROLL PROVER] spell first 50 chars:', requestBody.spell?.substring(0, 50));

    console.log('[PAYROLL PROVER] app_private_inputs keys:', Object.keys(requestBody.app_private_inputs || {}));
    const firstPrivateKey = Object.keys(requestBody.app_private_inputs || {})[0];
    if (firstPrivateKey) {
        console.log('[PAYROLL PROVER] app_private_inputs key format:', firstPrivateKey);
        console.log('[PAYROLL PROVER] app_private_inputs value type:', typeof requestBody.app_private_inputs[firstPrivateKey]);
        console.log('[PAYROLL PROVER] app_private_inputs value first 50 chars:', requestBody.app_private_inputs[firstPrivateKey]?.substring(0, 50));
    }

    console.log('[PAYROLL PROVER] binaries keys:', Object.keys(requestBody.binaries || {}));
    const firstBinaryKey = Object.keys(requestBody.binaries || {})[0];
    if (firstBinaryKey) {
        console.log('[PAYROLL PROVER] binaries key format:', firstBinaryKey);
        console.log('[PAYROLL PROVER] binaries value type:', typeof requestBody.binaries[firstBinaryKey]);
        console.log('[PAYROLL PROVER] binaries value first 100 chars:', requestBody.binaries[firstBinaryKey]?.substring(0, 100));
    }

    console.log('[PAYROLL PROVER] prev_txs type:', typeof requestBody.prev_txs);
    console.log('[PAYROLL PROVER] prev_txs is array:', Array.isArray(requestBody.prev_txs));
    console.log('[PAYROLL PROVER] prev_txs length:', requestBody.prev_txs?.length);
    if (requestBody.prev_txs && requestBody.prev_txs.length > 0) {
        console.log('[PAYROLL PROVER] prev_txs[0] type:', typeof requestBody.prev_txs[0]);
        console.log('[PAYROLL PROVER] prev_txs[0] keys:', requestBody.prev_txs[0] ? Object.keys(requestBody.prev_txs[0]) : 'null');
    }

    console.log('[PAYROLL PROVER] change_address type:', typeof requestBody.change_address);
    console.log('[PAYROLL PROVER] fee_rate type:', typeof requestBody.fee_rate);
    console.log('[PAYROLL PROVER] chain:', requestBody.chain);
    console.log('[PAYROLL PROVER] ===== END SOURCE OF TRUTH =====\n');

    // ----------------------------------------------------------------------------
    // Step 8: SEND TO PROVER API WITH RETRIES
    // ----------------------------------------------------------------------------
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        console.log(`\n[PAYROLL PROVER] Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

        const startTime = Date.now();
        const response = await axios.post(PROVER_URL, requestBody, {
          headers: { 'Content-Type': 'application/json' },
          timeout: PROVER_TIMEOUT_MS,
        });
        const elapsed = Date.now() - startTime;
        
        console.log('[PAYROLL PROVER] ✅ Response received:', {
          status: response.status,
          elapsedSec: (elapsed/1000).toFixed(1),
          responseLength: Array.isArray(response.data) ? response.data.length : 'not array'
        });
        
        const commitTxHex = extractTxHexFromJson(response.data, 0);
        const spellTxHex = response.data.length > 1 
            ? extractTxHexFromJson(response.data, 1) 
            : commitTxHex;

        console.log('[PAYROLL PROVER] Successfully extracted hexes:', {
            commit: commitTxHex.substring(0, 10) + '...',
            spell: spellTxHex.substring(0, 10) + '...',
            isSingle: response.data.length === 1
        });

        console.log('[PAYROLL PROVER] ===== SUCCESS =====\n');

        try {
          fs.unlinkSync(TEMP_PREV_TXS_FILE);
          fs.unlinkSync(TEMP_SCRIPT_FILE);
        } catch (e) { /* ignore */ }

        return { commitTxHex, spellTxHex };
        
      } catch (error: any) {
        lastError = error;
        console.error(`\n[PAYROLL PROVER] ❌ Attempt ${attempt + 1} failed:`, error.message);
        
        if (error.response?.status >= 400 && error.response?.status < 500) break;
        
        if (attempt < MAX_RETRIES) {
          const delay = calculateBackoff(attempt);
          console.log(`Retrying in ${Math.round(delay/1000)}s...`);
          await sleep(delay);
        }
      }
    }
    
    throw lastError || new Error('All retries failed');
    
  } catch (cliError: any) {
    console.error('[PAYROLL PROVER] ❌ CLI Payload Generation Failed:', cliError.message);
    console.error('[PAYROLL PROVER] Debug files saved at:');
    console.error(`  - Prev-txs: ${TEMP_PREV_TXS_FILE}`);
    console.error(`  - Script: ${TEMP_SCRIPT_FILE}`);
    
    try {
      const scriptContent = fs.readFileSync(TEMP_SCRIPT_FILE, 'utf8');
      console.error('[PAYROLL PROVER] Script content preview (first 10 lines):');
      scriptContent.split('\n').slice(0, 10).forEach((line, i) => {
        console.error(`  ${i+1}: ${line}`);
      });
    } catch (e) {
      // Ignore read errors
    }
    
    throw new Error(`Failed to generate payload: ${cliError.message}`);
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
    outputs: workers.map(w => ({ address: w.address, tokenAmount: w.amount })),
    ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
  };

  return generateUnsignedTransactions(request, [planUtxo, fundingUtxo.utxo], appId);
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
  
  return generateUnsignedTransactions(request, [anchorUtxo, fundingUtxo.utxo]);
}