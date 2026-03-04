import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as dotenv from 'dotenv';
import { encode } from 'cbor-x';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import { buildMintNFT } from './buildMintNFT';
import { buildMintToken } from './buildMintToken';

dotenv.config();

// --------------------------------------------------------------------------------
// Configuration & Constants
// --------------------------------------------------------------------------------
const PROVER_URL = process.env.PROVER_API_URL || constants.PROVER_API_URL;
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const BINARY_PATH = path.resolve(process.cwd(), 'src/app-binary.b64');
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 2000;
const MAX_DELAY_MS = 30000;
const PROVER_TIMEOUT_MS = 600000; // 10 minutes for ZK proof generation

// Load app binary once (cached for performance)
let APP_BINARY_CACHE: string | null = null;

/**
 * Loads the ZK-app binary with caching for performance
 */
function loadAppBinary(): string {
  if (APP_BINARY_CACHE) {
    return APP_BINARY_CACHE;
  }
  
  try {
    APP_BINARY_CACHE = fs.readFileSync(BINARY_PATH, 'utf-8').trim();
    
    if (!APP_BINARY_CACHE) {
      throw new Error('App binary is empty');
    }
    
    console.log(`[INFO] App binary loaded: ${APP_BINARY_CACHE.length} bytes`);
    return APP_BINARY_CACHE;
  } catch (error) {
    console.error('[ERROR] Failed to load app binary:', error);
    throw new Error(`APP_BINARY missing: Could not read file at ${BINARY_PATH}`);
  }
}

/**
 * Exponential backoff with jitter for retry logic
 */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateBackoff(retryCount: number): number {
  const exponentialDelay = BASE_DELAY_MS * Math.pow(2, retryCount);
  const jitter = Math.random() * 1000;
  return Math.min(exponentialDelay + jitter, MAX_DELAY_MS);
}

/**
 * Validates and formats prev_txs for Prover API
 */
function formatPrevTxs(prevTxHexes: string[]): string[] {
    if (!Array.isArray(prevTxHexes)) {
        throw new Error('prevTxHexes must be an array');
    }

    return prevTxHexes.map((hex, index) => {
        if (!hex || typeof hex !== 'string') {
            throw new Error(`prevTxHexes[${index}] is invalid: must be non-empty string`);
        }

        // Clean hex string (remove whitespace, ensure lowercase)
        const cleanedHex = hex.replace(/[^0-9a-fA-F]/g, '').toLowerCase();

        if (cleanedHex.length === 0) {
            throw new Error(`prevTxHexes[${index}] is empty after cleaning`);
        }

        return cleanedHex; 
    });
}

/**
 * Formats multi-signature public inputs for Scroll integration
 */
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

/**
 * Extracts transaction hex from Prover response
 */
function extractTxHex(response: any, index: number): string {
  let hex = response[index];
  
  if (!hex) {
    throw new Error(`Prover response missing transaction at index ${index}`);
  }
  
  // Handle both { bitcoin: "hex" } object and direct string formats
  if (typeof hex === 'object' && hex.bitcoin) {
    hex = hex.bitcoin;
  }
  
  if (typeof hex !== 'string') {
    throw new Error(`Invalid hex format at index ${index}: expected string, got ${typeof hex}`);
  }
  
  if (hex.length === 0) {
    throw new Error(`Empty hex at index ${index}`);
  }
  
  return hex;
}

// --------------------------------------------------------------------------------
// Main Prover Function
// --------------------------------------------------------------------------------

/**
 * Generates unsigned transactions for payroll operations with batching and multi-sig support
 * 
 * @param request - Spell request containing payroll action details
 * @param prevTxHexes - Previous transaction hexes for provenance (Anchor + Authority UTXOs)
 * @param appId - Optional appId required for token minting operations
 * @returns ProverResult with commit and spell transaction hexes
 */
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
  if (!PROVER_URL) {
    throw new Error('PROVER_API_URL not configured in environment');
  }
  
  if (!request.fundingUtxo || !request.fundingUtxoValue) {
    throw new Error('Funding UTXO required for payroll transaction');
  }
  
  if (!request.changeAddress) {
    throw new Error('Change address required for payroll transaction');
  }
  
  // ----------------------------------------------------------------------------
  // Step 2: Load app binary (cached)
  // ----------------------------------------------------------------------------
  const appBinary = loadAppBinary();
  
  // ----------------------------------------------------------------------------
  // Step 3: Build spell JSON based on action type
  // ----------------------------------------------------------------------------
  let spellJson: any;
  
  try {
    if (request.type === 'mint-nft') {
      // Create new employment Plan NFT
      const result = buildMintNFT(request);
      spellJson = result.spell;
      console.log('[PAYROLL PROVER] Built mint-nft spell for new employment plan');
      
    } else if (request.type === 'mint-token') {
      // CRITICAL FIX: appId is required for token minting
      if (!appId) {
        throw new Error("appId is required for hiring (mint-token)");
      }
      
      // Batch mint tokens for multiple workers (1:M:N model) - pass appId
      spellJson = buildMintToken(request, appId);
      console.log('[PAYROLL PROVER] Built mint-token spell with batch outputs');
      
    } else if (request.type === 'scroll-freeze') {
      // PRODUCTION FIX: Support vault-freeze spells for termination [3]
      if (!request.authorityUtxo) {
        throw new Error("Vault UTXO (authorityUtxo) is required for freeze operations");
      }
      
      spellJson = {
        version: 8, // Protocol version 8 [5]
        apps: {
          "$00": `n/${appId}/${APP_VK}` // Authority app
        },
        ins: [
          {
            utxo_id: request.authorityUtxo, // The vault/token being frozen [6]
            charms: {} 
          },
          {
            utxo_id: request.fundingUtxo, // Treasury sponsorship [7]
            charms: {}
          }
        ],
        outs: [], // Freeze operations typically have no outputs [6]
        public_inputs: {
          "$00": {
            action: "freeze",
            threshold: 3 // Board-level 3-of-5 threshold [8]
          }
        }
      };
      console.log('[PAYROLL PROVER] Built scroll-freeze spell for termination');
      
    } else {
      throw new Error(`Unsupported payroll action: ${request.type}`);
    }
  } catch (error: any) {
    console.error('[PAYROLL PROVER] Spell building failed:', error);
    throw new Error(`Failed to build spell: ${error.message}`);
  }
  
  // ----------------------------------------------------------------------------
  // Step 4: Format prev_txs with validation
  // ----------------------------------------------------------------------------
  const formattedPrevTxs = formatPrevTxs(prevTxHexes);
  console.log(`[PAYROLL PROVER] Formatted ${formattedPrevTxs.length} prev_txs (as raw strings)`);
  
  // ----------------------------------------------------------------------------
  // Step 5: Add multi-sig to spell if required
  // ----------------------------------------------------------------------------
  const multiSigInputs = formatMultiSigInputs(request);
  if (multiSigInputs) {
    Object.assign(spellJson, multiSigInputs);
    console.log('[PAYROLL PROVER] Integrated multi-sig into spell object');
  }

  // ----------------------------------------------------------------------------
  // Step 6: Construct Prover API request body (v0.12 Tuple-Compliant) - FIX APPLIED
  // ----------------------------------------------------------------------------

  // 1. NORMALIZE SPELL (Mandatory for v0.12 "tx" field requirement)
  const normalizedSpell = {
    version: spellJson.version,
    mock: false,
    // v0.12 Requirement: ins, outs, and coins must be inside the 'tx' object
    tx: {
      ins: spellJson.ins.map((i: any) => i.utxo_id), // Just the IDs
      outs: spellJson.outs.map((o: any) => {
        // Map the app tags ($00) to their charm data objects
        const keyedCharms: any = {};
        if (o.charms) {
          Object.keys(o.charms).forEach(tag => {
            keyedCharms[tag] = o.charms[tag];
          });
        }
        return keyedCharms;
      }),
      // Map BTC outputs for fee verification
      coins: spellJson.outs.map((o: any) => ({
        amount: o.sats || 1000,
        dest: o.address
      }))
    },
    // Required even if empty
    app_public_inputs: spellJson.public_inputs || {} 
  };

  // 1. Spell: Hex-encoded CBOR string (satisfies Rule #1 - worked in error_2.txt)
  const spellCbor = encode(normalizedSpell);
  const spellHex = Buffer.from(spellCbor).toString('hex');

  // 2. Binaries: Convert to an Array of Pairs [[key_bytes, value_bytes]]
  // This solves the "expected bytes" error for the VK key at Column 945
  const vkBytes = Array.from(Buffer.from(APP_VK, 'hex'));
  const appBinaryBytes = Array.from(Buffer.from(appBinary, 'base64'));
  const binariesTupleArray = [ [vkBytes, appBinaryBytes] ];

  // 3. PrevTxs: Wrap each byte array in the 'bitcoin' enum variant object
  // The Rust type is Vec<Tx>, where Tx is an enum [1, 2]
  const prevTxsObjects = formattedPrevTxs.map(hex => ({
      bitcoin: Array.from(Buffer.from(hex, 'hex'))
  }));

  const requestBody: any = {
    chain: 'bitcoin',
    spell: spellHex, // Rule 1: Hex-CBOR string
    
    // Rule 2 Fix: Use Array of Tuples to provide byte-keys for BTreeMap
    binaries: binariesTupleArray, 
    prev_txs: prevTxsObjects, 
    
    change_address: request.changeAddress,
    fee_rate: request.feeRate || 2.0,

    // MANDATORY v0.12 FIELDS (Tuple format for empty Maps)
    app_private_inputs: [], 
    tx_ins_beamed_source_utxos: [],
    collateral_utxo: null 
  };

  // CANARY LOG: Verifies the structural shift to Tuple Arrays
  console.log('[TUPLE-V12-FIX] Binaries is Tuple Array:', Array.isArray(requestBody.binaries));
  console.log('[TUPLE-V12-FIX] Binaries first key bytes length:', requestBody.binaries[0][0].length);
  console.log('[TUPLE-V12-FIX] Binaries first value bytes length:', requestBody.binaries[0][1].length);
  console.log('[TUPLE-V12-FIX] PrevTxs first object has bitcoin field:', !!requestBody.prev_txs[0]?.bitcoin);
  console.log('[TUPLE-V12-FIX] PrevTxs first bitcoin bytes length:', requestBody.prev_txs[0]?.bitcoin?.length);

  // Debug log
  console.log('[PAYROLL PROVER] Request body prepared (v0.12):', {
    spellType: request.type,
    spellHexLength: requestBody.spell.length,
    binariesIsTupleArray: Array.isArray(requestBody.binaries) && Array.isArray(requestBody.binaries[0]),
    binariesKeyLength: requestBody.binaries[0]?.[0]?.length,
    binariesValueLength: requestBody.binaries[0]?.[1]?.length,
    prevTxsCount: requestBody.prev_txs.length,
    prevTxsFirstIsObject: typeof requestBody.prev_txs[0] === 'object',
    prevTxsFirstHasBitcoin: !!requestBody.prev_txs[0]?.bitcoin,
    feeRate: request.feeRate || 2.0,
    multiSig: !!multiSigInputs,
    appIdProvided: !!appId
  });
  
  // ----------------------------------------------------------------------------
  // Step 7: Execute with retry logic
  // ----------------------------------------------------------------------------
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[PAYROLL PROVER] Attempt ${attempt + 1}/${MAX_RETRIES + 1}`);

      const response = await axios.post(PROVER_URL, requestBody, {
        headers: { 'Content-Type': 'application/json' },
        timeout: PROVER_TIMEOUT_MS
      });
      
      console.log('[PAYROLL PROVER] Prover response received:', {
        status: response.status,
        dataType: Array.isArray(response.data) ? 'array' : typeof response.data
      });
      
      // ------------------------------------------------------------------------
      // Step 8: Extract and validate response
      // ------------------------------------------------------------------------
      if (!Array.isArray(response.data) || response.data.length < 2) {
        throw new Error('Prover API returned invalid response: expected array of 2 transactions');
      }
      
      const commitTxHex = extractTxHex(response.data, 0);
      const spellTxHex = extractTxHex(response.data, 1);
      
      console.log('[PAYROLL PROVER] Transaction hexes extracted:', {
        commitLength: commitTxHex.length,
        spellLength: spellTxHex.length
      });
      
      console.log('[PAYROLL PROVER] ===== SUCCESS =====\n');
      
      return { commitTxHex, spellTxHex };
      
    } catch (error: any) {
      lastError = error;
      
      console.error(`[PAYROLL PROVER] Attempt ${attempt + 1} failed:`, {
        message: error.message,
        status: error.response?.status,
        data: error.response?.data
      });
      
      // Don't retry on client errors (4xx)
      if (error.response?.status >= 400 && error.response?.status < 500) {
        console.error('[PAYROLL PROVER] Client error, aborting retries');
        break;
      }
      
      // Retry on server errors, network issues, timeouts
      if (attempt < MAX_RETRIES) {
        const delay = calculateBackoff(attempt);
        console.log(`[PAYROLL PROVER] Retrying in ${Math.round(delay)}ms...`);
        await sleep(delay);
      }
    }
  }
  
  // ----------------------------------------------------------------------------
  // Step 9: All retries failed
  // ----------------------------------------------------------------------------
  console.error('[PAYROLL PROVER] ===== ALL RETRIES FAILED =====\n');
  
  let errorMessage = 'Prover API failed after all retry attempts. ';
  
  if (lastError) {
    if (axios.isAxiosError(lastError)) {
      if (lastError.code === 'ECONNABORTED' || lastError.message.includes('timeout')) {
        errorMessage += 'Request timed out. ZK proof generation may be slow.';
      } else if (lastError.response) {
        errorMessage += `HTTP ${lastError.response.status}: ${JSON.stringify(lastError.response.data)}`;
      } else if (lastError.request) {
        errorMessage += 'Network error: No response received.';
      } else {
        errorMessage += lastError.message;
      }
    } else {
      errorMessage += lastError.message;
    }
  }
  
  throw new Error(errorMessage);
}

/**
 * Batch payroll helper - creates multiple worker tokens in one transaction
 * 
 * @param planUtxo - Plan NFT UTXO
 * @param workers - Array of worker addresses and amounts
 * @param fundingUtxo - UTXO for fees
 * @param changeAddress - Address for change
 * @param appId - The appId from the saved plan (required for token minting)
 * @param multiSigSigners - Optional multi-signature signers
 * @returns ProverResult with batched transaction
 */
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
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress: changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: workers.map(w => ({
      address: w.address,
      tokenAmount: w.amount
    })),
    ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
  };
  
  // For token minting, prevTxHexes should contain the Plan NFT authority UTXO
  // Pass the appId as the third argument
  return generateUnsignedTransactions(request, [planUtxo], appId);
}

/**
 * Create new employment plan (Plan NFT)
 */
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
      address: changeAddress, // NFT goes to employer's change address
      nftMetadata: {
        ticker: planDetails.ticker,
        remaining: 1, // Single employment contract
        metadataHash: planDetails.metadataHash,
        scrollPolicy: planDetails.scrollPolicy,
        payPeriodSeconds: planDetails.payPeriodSeconds,
        compensationSats: planDetails.compensationSats
      }
    }],
    ...(multiSigSigners && { multiSigSigners, multiSigThreshold: 2 })
  };
  
  // For NFT minting, prevTxHexes should contain the anchor UTXO
  // No appId needed for mint-nft
  return generateUnsignedTransactions(request, [anchorUtxo]);
}