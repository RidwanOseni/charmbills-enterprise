import { SpellRequest } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';
import * as bitcoin from 'bitcoinjs-lib';

// --------------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------------
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const DEFAULT_TICKER = constants.PAYROLL_NFT_TICKER || "CHARMS-PAY";
const MIN_OUTPUT_SATS = constants.MIN_OUTPUT_SATS || 1000;

// --------------------------------------------------------------------------------
// Custom Error Class
// --------------------------------------------------------------------------------
class ValidationError extends Error {
  constructor(message: string) {
    super(`[buildMintToken.payroll] ${message}`);
    this.name = 'ValidationError';
  }
}

// --------------------------------------------------------------------------------
// App ID Derivation (KEPT for helper functions that need it)
// --------------------------------------------------------------------------------

/**
 * Derives the unique App ID from the Authority UTXO ID.
 * The App ID must match the original Plan NFT's appId for token minting authority.
 * 
 * @param utxoId - Authority UTXO ID in format "txid:vout"
 * @returns 64-character hex string (SHA256 hash)
 */
export function deriveAppId(utxoId: string): string {
  if (!utxoId || typeof utxoId !== 'string') {
    throw new ValidationError('Invalid utxoId: must be non-empty string');
  }
  
  // Validate UTXO ID format (basic check)
  if (!/^[a-f0-9]+:\d+$/i.test(utxoId)) {
    throw new ValidationError(`Invalid UTXO ID format: ${utxoId} (expected "txid:vout")`);
  }
  
  return crypto.createHash('sha256').update(utxoId).digest('hex');
}

// --------------------------------------------------------------------------------
// Validation Functions
// --------------------------------------------------------------------------------

/**
 * Validates the spell request for batch token minting
 */
function validateBatchMintRequest(request: SpellRequest): void {
  // Check request type
  if (request.type !== 'mint-token') {
    throw new ValidationError(
      `Invalid request type: ${request.type}. Expected 'mint-token'.`
    );
  }

  // Check authority UTXO
  if (!request.authorityUtxo) {
    throw new ValidationError('authorityUtxo is required for batch token minting');
  }

  // CRITICAL FIX: Check anchor UTXO for witness pre-image
  if (!request.anchorUtxo) {
    throw new ValidationError('anchorUtxo is required for batch token minting witness');
  }

  // v0.12 FIX: Check funding UTXO (now required and must be in spell inputs)
  if (!request.fundingUtxo) {
    throw new ValidationError('fundingUtxo is required for batch token minting in v0.12');
  }

  // Check outputs
  if (!request.outputs || request.outputs.length < 2) {
    throw new ValidationError(
      `Batch minting requires at least 2 outputs (workers + NFT return), got ${request.outputs?.length}`
    );
  }

  // Validate funding parameters
  if (!request.fundingUtxo || !request.fundingUtxoValue) {
    throw new ValidationError('Funding UTXO details are required');
  }

  if (!request.changeAddress) {
    throw new ValidationError('Change address is required');
  }
}

/**
 * Separates worker outputs from NFT return output with validation
 * FIX: Applies 1,000 sat placeholder for Unified Model if compensationSats is missing [Source 169, 269]
 */
function separateOutputs(request: SpellRequest): {
  workerOutputs: Array<{ address: string; tokenAmount: number }>;
  nftReturnOutput: { address: string; nftMetadata: any };
} {
  // Identify worker outputs (have tokenAmount)
  const workerOutputs = request.outputs
    .filter(out => out.tokenAmount !== undefined && out.tokenAmount > 0)
    .map(out => ({
      address: out.address,
      tokenAmount: out.tokenAmount!
    }));

  if (workerOutputs.length === 0) {
    throw new ValidationError('No worker outputs found with valid tokenAmount');
  }

  // Identify NFT return output (has nftMetadata)
  const nftReturnOutput = request.outputs.find(out => out.nftMetadata !== undefined);

  if (!nftReturnOutput) {
    throw new ValidationError('Missing NFT return output with nftMetadata');
  }

  if (!nftReturnOutput.address) {
    throw new ValidationError('NFT return output missing address');
  }

  const metadata = nftReturnOutput.nftMetadata!;
  
  // [FIXED VALIDATION] Apply 1,000 sat placeholder for Unified Model [Source 269]
  if (metadata.compensationSats === undefined || metadata.compensationSats < MIN_OUTPUT_SATS) {
    console.log('[buildMintToken.payroll] ℹ️ Applying 1,000 sat placeholder for Unified Model');
    metadata.compensationSats = MIN_OUTPUT_SATS; // Set to 1,000 to satisfy contract
  }
  
  // Validate required enforcement fields (now compensationSats is guaranteed to exist)
  if (!metadata.metadataHash) {
    throw new ValidationError('NFT return output missing metadataHash');
  }

  if (metadata.scrollPolicy === undefined || ![0, 1].includes(metadata.scrollPolicy)) {
    throw new ValidationError('NFT return output missing valid scrollPolicy (0 or 1)');
  }

  if (!metadata.payPeriodSeconds || metadata.payPeriodSeconds <= 0) {
    throw new ValidationError('NFT return output missing valid payPeriodSeconds');
  }

  // Validate remaining supply
  if (metadata.remaining === undefined || metadata.remaining < 0) {
    throw new ValidationError('NFT return output missing valid remaining supply');
  }

  return {
    workerOutputs,
    nftReturnOutput: {
      address: nftReturnOutput.address,
      nftMetadata: metadata
    }
  };
}

/**
 * Calculates batch totals and validates supply constraints
 */
function calculateBatchMetrics(
  workerOutputs: Array<{ tokenAmount: number }>,
  currentSupply: number
): { totalTokensToMint: number; newRemainingSupply: number } {
  const totalTokensToMint = workerOutputs.reduce(
    (sum, out) => sum + out.tokenAmount,
    0
  );

  if (totalTokensToMint <= 0) {
    throw new ValidationError(`Total tokens to mint must be positive, got ${totalTokensToMint}`);
  }

  const newRemainingSupply = currentSupply - totalTokensToMint;

  if (newRemainingSupply < 0) {
    throw new ValidationError(
      `Insufficient supply in Plan NFT. Attempting to mint ${totalTokensToMint} ` +
      `tokens but only ${currentSupply} remain.`
    );
  }

  return { totalTokensToMint, newRemainingSupply };
}

// --------------------------------------------------------------------------------
// Strict Type-Marshalling Builder for Rust Bridge
// Returns typed variables that the Rust bridge will process
// The Rust bridge handles the YAML/Protocol structure
// --------------------------------------------------------------------------------

/**
 * Builds typed variables for the Rust bridge to process batch token minting.
 * This replaces the YAML template approach with direct typed marshalling.
 * 
 * CRITICAL FIX: Uses anchorUtxo (original App Identity) instead of authorityUtxo (current Plan NFT)
 * The witness pre-image must be the UTXO that created the appId, not the current Plan NFT.
 * 
 * @param request - Validated spell request with worker outputs and NFT return metadata
 * @param appId - The existing appId from the saved plan (passed, not derived)
 * @param treasuryHexDest - The treasury hex destination for change output (from company config)
 * @returns Object containing typed variables
 */
export function buildMintTokenVars(
  request: SpellRequest,
  appId: string,
  treasuryHexDest: string
): { variables: Record<string, any> } {
  // ----------------------------------------------------------------------------
  // Step 1: Validate request
  // ----------------------------------------------------------------------------
  validateBatchMintRequest(request);

  // ----------------------------------------------------------------------------
  // Step 2: Validate treasuryHexDest parameter
  // ----------------------------------------------------------------------------
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for batch token minting');
  }
  
  // Validate hex destination format
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }

  // ----------------------------------------------------------------------------
  // Step 3: Separate outputs
  // ----------------------------------------------------------------------------
  const { workerOutputs, nftReturnOutput } = separateOutputs(request);
  const metadata = nftReturnOutput.nftMetadata;

  // ----------------------------------------------------------------------------
  // Step 4: Calculate new remaining supply
  // ----------------------------------------------------------------------------
  const currentSupply = metadata.remaining;
  const { newRemainingSupply } = calculateBatchMetrics(workerOutputs, currentSupply);

  // ----------------------------------------------------------------------------
  // Step 5: Build typed variables for Rust bridge
  // The Rust bridge expects specific field names matching BridgeVariables struct
  // 
  // CRITICAL FIX: Use anchorUtxo (original App Identity) NOT authorityUtxo
  // The witness pre-image must be the UTXO that created the appId
  // ----------------------------------------------------------------------------
  const variables: Record<string, any> = {
    type_name: "mint-token",
    app_id: String(appId),
    app_vk: String(APP_VK),
    // CRITICAL FIX: Use original anchor, NOT authorityUtxo
    // request.anchorUtxo must be the "txid:vout" that created the appId
    anchor_utxo: String(request.anchorUtxo!),
    funding_utxo: String(request.fundingUtxo!),
    ticker: String(metadata.ticker || DEFAULT_TICKER),
    remaining: String(newRemainingSupply),
    metadata_hash: String(metadata.metadataHash),
    scroll_policy: String(metadata.scrollPolicy),
    pay_period_seconds: String(metadata.payPeriodSeconds),
    compensation_sats: String(Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS)),
    treasury_dest: String(treasuryHexDest),
    worker_dests: workerOutputs.map(w => w.address),
    token_amounts: workerOutputs.map(w => String(w.tokenAmount))
  };

  // Add optional multi-sig fields if present
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    variables.multi_sig_signers = String(request.multiSigSigners.join(','));
    variables.multi_sig_threshold = String(request.multiSigThreshold || 2);
  }

  // ----------------------------------------------------------------------------
  // Step 6: Logging (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] ✅ Typed variables built for Rust bridge:', {
      type_name: variables.type_name,
      appId: appId.substring(0, 16) + '...',
      workerCount: workerOutputs.length,
      totalTokens: workerOutputs.reduce((sum, w) => sum + w.tokenAmount, 0),
      currentSupply,
      newRemainingSupply,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      compensationSats: Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS),
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo,
      treasuryHexDest: treasuryHexDest.substring(0, 16) + '...',
      workerDestsCount: variables.worker_dests.length,
      tokenAmountsCount: variables.token_amounts.length,
      hasMultiSig: !!request.multiSigSigners
    });
  }

  return { variables };
}

// --------------------------------------------------------------------------------
// Legacy YAML Builder - Kept for backward compatibility
// --------------------------------------------------------------------------------

/**
 * Builds a dynamic YAML template and variables for batch token minting (legacy approach).
 * 
 * @param request - Validated spell request with worker outputs and NFT return metadata
 * @param appId - The existing appId from the saved plan (passed, not derived)
 * @param treasuryHexDest - The treasury hex destination for change output (from company config)
 * @returns Object containing templateYaml string and variables map
 */
export function buildMintTokenVarsLegacy(
  request: SpellRequest,
  appId: string,
  treasuryHexDest: string
): { templateYaml: string; variables: Record<string, string> } {
  // ----------------------------------------------------------------------------
  // Step 1: Validate request
  // ----------------------------------------------------------------------------
  validateBatchMintRequest(request);

  // ----------------------------------------------------------------------------
  // Step 2: Validate treasuryHexDest parameter
  // ----------------------------------------------------------------------------
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for batch token minting');
  }
  
  // Validate hex destination format
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }

  // ----------------------------------------------------------------------------
  // Step 3: Separate outputs
  // ----------------------------------------------------------------------------
  const workerOutputs = request.outputs.filter(o => o.tokenAmount !== undefined && o.tokenAmount > 0);
  const nftOutput = request.outputs.find(o => o.nftMetadata);

  if (!nftOutput) {
    throw new ValidationError('Missing NFT return output with nftMetadata');
  }

  if (workerOutputs.length === 0) {
    throw new ValidationError('No worker outputs found with valid tokenAmount');
  }

  const metadata = nftOutput.nftMetadata!;

  // ----------------------------------------------------------------------------
  // Step 4: Calculate new remaining supply
  // ----------------------------------------------------------------------------
  const currentSupply = metadata.remaining;
  const totalTokensToMint = workerOutputs.reduce((sum, w) => sum + (w.tokenAmount || 0), 0);
  const newRemainingSupply = currentSupply - totalTokensToMint;

  if (newRemainingSupply < 0) {
    throw new ValidationError(
      `Insufficient supply in Plan NFT. Attempting to mint ${totalTokensToMint} ` +
      `tokens but only ${currentSupply} remain.`
    );
  }

  // ----------------------------------------------------------------------------
  // Step 5: Dynamically construct the YAML content based on worker count
  // ----------------------------------------------------------------------------
  let outsYaml = "";
  let coinsYaml = "";

  // Add worker outputs (fungible tokens use key "1")
  for (let i = 0; i < workerOutputs.length; i++) {
    const worker = workerOutputs[i];
    outsYaml += `    - "1": ${worker.tokenAmount}\n`;
    coinsYaml += `    - amount: 1000\n      dest: "{{worker_dest_${i}}}"\n`;
  }

  // Add the NFT return output (key "0" for authority NFT)
  outsYaml += `    - "0":\n        ticker: {{ticker}}\n        remaining: {{remaining}}\n        metadataHash: "{{metadataHash}}"\n        scrollPolicy: {{scrollPolicy}}\n        payPeriodSeconds: {{payPeriodSeconds}}\n        compensationSats: {{compensationSats}}\n`;
  
  // Add treasury change output
  coinsYaml += `    - amount: 1000\n      dest: "{{treasury_dest}}"\n`;

  // ----------------------------------------------------------------------------
  // Step 6: Build the dynamic YAML template
  // ----------------------------------------------------------------------------
  const templateYaml = `version: 14
tx:
  ins:
    - "{{anchor_utxo}}"
    - "{{funding_utxo}}"
  outs:
${outsYaml}  coins:
${coinsYaml}
app_public_inputs:
  "n/{{app_id}}/{{app_vk}}": null
  "t/{{app_id}}/{{app_vk}}": null
`;

  // ----------------------------------------------------------------------------
  // Step 7: Prepare the variables
  // ----------------------------------------------------------------------------
  const variables: Record<string, string> = {
    app_id: String(appId),
    app_vk: String(APP_VK),
    anchor_utxo: String(request.anchorUtxo!),
    funding_utxo: String(request.fundingUtxo!),
    ticker: String(metadata.ticker || DEFAULT_TICKER),
    remaining: String(newRemainingSupply),
    metadataHash: String(metadata.metadataHash),
    scrollPolicy: String(metadata.scrollPolicy),
    payPeriodSeconds: String(metadata.payPeriodSeconds),
    compensationSats: String(Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS)),
    treasury_dest: String(treasuryHexDest)
  };

  // Add worker addresses as variables
  for (let i = 0; i < workerOutputs.length; i++) {
    variables[`worker_dest_${i}`] = String(workerOutputs[i].address);
  }

  // Add optional multi-sig fields if present
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    variables.multi_sig_signers = String(request.multiSigSigners.join(','));
    variables.multi_sig_threshold = String(request.multiSigThreshold || 2);
  }

  // ----------------------------------------------------------------------------
  // Step 8: Logging (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] ✅ Legacy YAML and variables built:', {
      appId: appId.substring(0, 16) + '...',
      workerCount: workerOutputs.length,
      totalTokens: totalTokensToMint,
      currentSupply,
      newRemainingSupply,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      compensationSats: Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS),
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo,
      treasuryHexDest: treasuryHexDest.substring(0, 16) + '...',
      variableCount: Object.keys(variables).length
    });
  }

  return { templateYaml, variables };
}

// --------------------------------------------------------------------------------
// Spell Builder (JSON Construction Version) - Kept for backward compatibility
// --------------------------------------------------------------------------------

/**
 * Builds the spell JSON object for a Batched Mint-Token Spell (legacy approach).
 */
export function buildMintTokenJSON(
  request: SpellRequest,
  appId: string,
  treasuryHexDest: string
): any {
  // ----------------------------------------------------------------------------
  // Step 1: Validate request
  // ----------------------------------------------------------------------------
  validateBatchMintRequest(request);

  // ----------------------------------------------------------------------------
  // Step 2: Validate treasuryHexDest parameter
  // ----------------------------------------------------------------------------
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for batch token minting');
  }
  
  // Validate hex destination format
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }

  // ----------------------------------------------------------------------------
  // Step 3: Separate outputs
  // ----------------------------------------------------------------------------
  const nftOutput = request.outputs.find(o => o.nftMetadata);
  const workerOutputs = request.outputs.filter(o => o.tokenAmount !== undefined && o.tokenAmount > 0);

  if (!nftOutput) {
    throw new ValidationError('Missing NFT return output with nftMetadata');
  }

  if (workerOutputs.length === 0) {
    throw new ValidationError('No worker outputs found with valid tokenAmount');
  }

  const metadata = nftOutput.nftMetadata!;

  // ----------------------------------------------------------------------------
  // Step 4: Calculate new remaining supply
  // ----------------------------------------------------------------------------
  const currentSupply = metadata.remaining;
  const totalTokensToMint = workerOutputs.reduce((sum, w) => sum + (w.tokenAmount || 0), 0);
  const newRemainingSupply = currentSupply - totalTokensToMint;

  if (newRemainingSupply < 0) {
    throw new ValidationError(
      `Insufficient supply in Plan NFT. Attempting to mint ${totalTokensToMint} ` +
      `tokens but only ${currentSupply} remain.`
    );
  }

  // ----------------------------------------------------------------------------
  // Step 5: Build dynamic outputs
  // ----------------------------------------------------------------------------
  const outs: any[] = workerOutputs.map(w => ({ "1": w.tokenAmount }));

  outs.push({
    "0": {
      ticker: metadata.ticker || DEFAULT_TICKER,
      remaining: newRemainingSupply,
      metadataHash: metadata.metadataHash,
      scrollPolicy: metadata.scrollPolicy,
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats: Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS)
    }
  });

  // ----------------------------------------------------------------------------
  // Step 6: Build dynamic coins
  // ----------------------------------------------------------------------------
  const coins: any[] = [];

  for (const worker of workerOutputs) {
    try {
      const script = bitcoin.address.toOutputScript(worker.address, bitcoin.networks.testnet);
      const destArray = Array.from(script);
      coins.push({
        amount: MIN_OUTPUT_SATS,
        dest: destArray
      });
    } catch (error: any) {
      throw new ValidationError(`Invalid worker address: ${worker.address} - ${error.message}`);
    }
  }

  const treasuryDestBytes = Buffer.from(treasuryHexDest, 'hex');
  const treasuryDestArray = Array.from(treasuryDestBytes);
  coins.push({
    amount: MIN_OUTPUT_SATS,
    dest: treasuryDestArray
  });

  // ----------------------------------------------------------------------------
  // Step 7: Build the spell JSON object
  // ----------------------------------------------------------------------------
  const spell = {
    version: 14,
    tx: {
      ins: [ request.anchorUtxo!, request.fundingUtxo! ],
      outs: outs,
      coins: coins
    },
    app_public_inputs: {
      [`n/${appId}/${APP_VK}`]: null,
      [`t/${appId}/${APP_VK}`]: null
    }
  };

  // ----------------------------------------------------------------------------
  // Step 8: Logging (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] ✅ Legacy spell JSON built:', {
      appId: appId.substring(0, 16) + '...',
      workerCount: workerOutputs.length,
      totalTokens: totalTokensToMint,
      currentSupply,
      newRemainingSupply,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      compensationSats: Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS),
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo,
      treasuryHexDest: treasuryHexDest.substring(0, 16) + '...',
      workerCoinsCount: workerOutputs.length
    });
  }

  return spell;
}

// --------------------------------------------------------------------------------
// Spell Builder (Template Variables Version) - Kept for backward compatibility
// --------------------------------------------------------------------------------

export function buildMintToken(
  request: SpellRequest, 
  appId: string,
  anchorUtxo: string,
  treasuryHexDest: string
): Record<string, string> {
  validateBatchMintRequest(request);

  if (!anchorUtxo || typeof anchorUtxo !== 'string') {
    throw new ValidationError('anchorUtxo is required for batch token minting');
  }
  
  if (!/^[a-f0-9]+:\d+$/i.test(anchorUtxo)) {
    throw new ValidationError(`Invalid anchorUtxo format: ${anchorUtxo}`);
  }
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for batch token minting');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }

  const { workerOutputs, nftReturnOutput } = separateOutputs(request);
  const metadata = nftReturnOutput.nftMetadata;
  const currentSupply = Number(metadata.remaining);
  const { newRemainingSupply } = calculateBatchMetrics(workerOutputs, currentSupply);

  const spellVars: Record<string, string> = {
    app_id: appId,
    app_vk: APP_VK,
    plan_utxo: request.authorityUtxo!, 
    funding_utxo: request.fundingUtxo!,
    anchor_utxo: anchorUtxo,
    ticker: metadata.ticker || DEFAULT_TICKER,
    currentSupply: currentSupply.toString(),
    newRemaining: newRemainingSupply.toString(),
    metadataHash: metadata.metadataHash,
    scrollPolicy: (metadata.scrollPolicy ?? 0).toString(),
    payPeriodSeconds: (metadata.payPeriodSeconds ?? 0).toString(),
    compensationSats: Math.max(metadata.compensationSats || 0, MIN_OUTPUT_SATS).toString(),
    change_amount: MIN_OUTPUT_SATS.toString(),
    treasury_hex_dest: treasuryHexDest,
    amount_0: MIN_OUTPUT_SATS.toString()
  };
  
  workerOutputs.forEach((worker, index) => {
    const workerNum = index + 1;
    try {
      const script = bitcoin.address.toOutputScript(worker.address, bitcoin.networks.testnet);
      spellVars[`worker_hex_dest_${workerNum}`] = Buffer.from(script).toString('hex');
      spellVars[`worker_amount_${workerNum}`] = worker.tokenAmount.toString();
    } catch (error: any) {
      throw new ValidationError(`Invalid worker address: ${worker.address} - ${error.message}`);
    }
  });
  
  spellVars.worker_count = workerOutputs.length.toString();
  
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    spellVars.multi_sig_signers = request.multiSigSigners.join(',');
    spellVars.multi_sig_threshold = (request.multiSigThreshold || 2).toString();
  }
  
  return spellVars;
}

// --------------------------------------------------------------------------------
// Helper Functions (KEPT with original logic)
// --------------------------------------------------------------------------------

export function createSingleHireRequest(
  authorityUtxo: string,
  employerAddress: string,
  workerAddress: string,
  planMetadata: any,
  fundingUtxo: { utxo: string; value: number },
  changeAddress: string
): SpellRequest {
  return {
    type: 'mint-token',
    authorityUtxo,
    anchorUtxo: authorityUtxo,
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      { address: workerAddress, tokenAmount: 1 },
      { address: employerAddress, nftMetadata: planMetadata }
    ]
  };
}

export function createBatchHireRequest(
  authorityUtxo: string,
  employerAddress: string,
  workers: string[],
  planMetadata: any,
  fundingUtxo: { utxo: string; value: number },
  changeAddress: string
): SpellRequest {
  return {
    type: 'mint-token',
    authorityUtxo,
    anchorUtxo: authorityUtxo,
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      ...workers.map(address => ({ address, tokenAmount: 1 })),
      { address: employerAddress, nftMetadata: planMetadata }
    ]
  };
}

export function createCustomBatchHireRequest(
  authorityUtxo: string,
  employerAddress: string,
  workerAllocations: Array<{ address: string; amount: number }>,
  planMetadata: any,
  fundingUtxo: { utxo: string; value: number },
  changeAddress: string
): SpellRequest {
  const total = workerAllocations.reduce((sum, w) => sum + w.amount, 0);
  if (total > planMetadata.remaining) {
    throw new ValidationError(
      `Total allocation (${total}) exceeds remaining supply (${planMetadata.remaining})`
    );
  }

  return {
    type: 'mint-token',
    authorityUtxo,
    anchorUtxo: authorityUtxo,
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      ...workerAllocations.map(w => ({ address: w.address, tokenAmount: w.amount })),
      { address: employerAddress, nftMetadata: planMetadata }
    ]
  };
}