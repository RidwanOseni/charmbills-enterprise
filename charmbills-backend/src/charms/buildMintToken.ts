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
function deriveAppId(utxoId: string): string {
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
  
  // Validate required enforcement fields
  if (!metadata.metadataHash) {
    throw new ValidationError('NFT return output missing metadataHash');
  }

  if (metadata.scrollPolicy === undefined || ![0, 1].includes(metadata.scrollPolicy)) {
    throw new ValidationError('NFT return output missing valid scrollPolicy (0 or 1)');
  }

  if (!metadata.payPeriodSeconds || metadata.payPeriodSeconds <= 0) {
    throw new ValidationError('NFT return output missing valid payPeriodSeconds');
  }

  if (!metadata.compensationSats || metadata.compensationSats < MIN_OUTPUT_SATS) {
    throw new ValidationError('NFT return output missing valid compensationSats');
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
// Spell Builder (Template Variables Version)
// --------------------------------------------------------------------------------

/**
 * Builds template variables for a Batched Mint-Token Spell for Charms Inc. Payroll.
 * Implements the 1:M:N Scaling Model: 1 NFT Authority -> M Workers -> N Periods.
 * 
 * This function prepares template variables that will be substituted into YAML templates
 * via envsubst in proverClient.ts. The resulting transaction:
 * 1. Consumes the Plan NFT (authority) as input
 * 2. Creates M worker tokens (one per employee/freelancer)
 * 3. Returns the Plan NFT to employer with updated remaining supply
 * 
 * @param request - Validated spell request with worker outputs and NFT return metadata
 * @param appId - The existing appId from the saved plan (passed, not derived)
 * @param anchorUtxo - The anchor UTXO for private inputs (from company config) [10]
 * @param treasuryHexDest - The treasury hex destination for change output (from company config) [12]
 * @returns Template variables object for envsubst
 */
export function buildMintToken(
  request: SpellRequest, 
  appId: string,
  anchorUtxo: string,      // Required for private_inputs [10]
  treasuryHexDest: string  // Required for change output [12]
): Record<string, string> {
  // ----------------------------------------------------------------------------
  // Step 1: Validate request
  // ----------------------------------------------------------------------------
  validateBatchMintRequest(request);

  // ----------------------------------------------------------------------------
  // Step 2: Validate parameters
  // ----------------------------------------------------------------------------
  if (!anchorUtxo || typeof anchorUtxo !== 'string') {
    throw new ValidationError('anchorUtxo is required for batch token minting');
  }
  
  // Validate anchor UTXO format
  if (!/^[a-f0-9]+:\d+$/i.test(anchorUtxo)) {
    throw new ValidationError(`Invalid anchorUtxo format: ${anchorUtxo} (expected "txid:vout")`);
  }
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for batch token minting');
  }
  
  // Validate hex destination format
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string (even number of hex characters)');
  }

  // ----------------------------------------------------------------------------
  // Step 3: Separate and validate outputs
  // ----------------------------------------------------------------------------
  const { workerOutputs, nftReturnOutput } = separateOutputs(request);
  const metadata = nftReturnOutput.nftMetadata;

  // ----------------------------------------------------------------------------
  // Step 4: Calculate batch metrics
  // ----------------------------------------------------------------------------
  const currentSupply = Number(metadata.remaining);
  const { totalTokensToMint, newRemainingSupply } = calculateBatchMetrics(
    workerOutputs,
    currentSupply
  );

  // ----------------------------------------------------------------------------
  // Step 5: Log batch details (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] 📦 Batch mint details:', {
      appId: appId.substring(0, 16) + '...',
      workers: workerOutputs.length,
      totalTokens: totalTokensToMint,
      currentSupply,
      newRemainingSupply,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      authorityUtxo: request.authorityUtxo,
      fundingUtxo: request.fundingUtxo,
      anchorUtxo: anchorUtxo.substring(0, 32) + '...',
      treasuryHexDest: treasuryHexDest.substring(0, 16) + '...'
    });
  }

  // ----------------------------------------------------------------------------
  // Step 6: Initialize spellVars object
  // ----------------------------------------------------------------------------
  const spellVars: Record<string, string> = {
    // App identifiers
    app_id: appId,
    app_vk: APP_VK,
    
    // UTXO inputs for the YAML 'ins' block [Source 230, 750]
    plan_utxo: request.authorityUtxo!, 
    funding_utxo: request.fundingUtxo!,
    anchor_utxo: anchorUtxo, // Required for private witness [Source 64, 750]

    // NFT metadata - Casing must be camelCase for Rust Serde [Source 49]
    ticker: metadata.ticker || DEFAULT_TICKER,
    currentSupply: currentSupply.toString(),
    newRemaining: newRemainingSupply.toString(),
    metadataHash: metadata.metadataHash,
    scrollPolicy: (metadata.scrollPolicy ?? 0).toString(),
    payPeriodSeconds: (metadata.payPeriodSeconds ?? 0).toString(),
    
    // CRITICAL: Must be >= 1000 to satisfy Rust validation [Source 50]
    compensationSats: Math.max(metadata.compensationSats || 0, 1000).toString(),

    // Treasury destinations [Source 231, 750]
    change_amount: MIN_OUTPUT_SATS.toString(),
    treasury_hex_dest: treasuryHexDest,
    amount_0: MIN_OUTPUT_SATS.toString() // Standard return amount for authority NFT 
};
  
  // ----------------------------------------------------------------------------
  // Step 7: ADD ALL REQUIRED MAPPINGS FOR THE YAML TEMPLATE
  // These variables are required by mint-token.yaml for the ins block
  // ----------------------------------------------------------------------------
  
  // UTXO inputs - Required for the ins block
  spellVars.plan_utxo = request.authorityUtxo!;
  spellVars.funding_utxo = request.fundingUtxo!;
  
  // NFT metadata - Required to describe the input NFT's state
  spellVars.ticker = metadata.ticker || DEFAULT_TICKER;
  spellVars.current_supply = currentSupply.toString();
  spellVars.new_remaining = newRemainingSupply.toString();
  spellVars.metadataHash = metadata.metadataHash;
  spellVars.scrollPolicy = metadata.scrollPolicy.toString();
  spellVars.payPeriodSeconds = metadata.payPeriodSeconds.toString();
  spellVars.compensationSats = metadata.compensationSats.toString();
  
  // Treasury change variables - Required for the Bitcoin output (from parameter) [12]
  spellVars.change_amount = MIN_OUTPUT_SATS.toString();
  spellVars.treasury_hex_dest = treasuryHexDest;
  spellVars.amount_0 = MIN_OUTPUT_SATS.toString(); // For backward compatibility
  
  // ----------------------------------------------------------------------------
  // Step 8: Add worker outputs with HEX destination conversion
  // CRITICAL FIX: Use Buffer.from() to avoid TypeScript error and convert address to hex
  // ----------------------------------------------------------------------------
  workerOutputs.forEach((worker, index) => {
    const workerNum = index + 1;
    
    try {
      // 1. Convert address to ScriptPubKey
      const script = bitcoin.address.toOutputScript(worker.address, bitcoin.networks.testnet);
      
      // 2. FIX: Use Buffer.from() to avoid the "Expected 0 arguments" TS error
      // This converts the 'tb1p...' address to a hex string for the YAML
      spellVars[`worker_hex_dest_${workerNum}`] = Buffer.from(script).toString('hex');
      
      // 3. Add the token amount (1 token = 1 pay period)
      spellVars[`worker_amount_${workerNum}`] = worker.tokenAmount.toString();
      
      // Log the conversion for debugging
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[buildMintToken.payroll] Converted worker ${workerNum} address to hex:`, {
          address: worker.address.substring(0, 20) + '...',
          hex: spellVars[`worker_hex_dest_${workerNum}`].substring(0, 40) + '...'
        });
      }
    } catch (error: any) {
      throw new ValidationError(`Invalid worker address at index ${index}: ${worker.address} - ${error.message}`);
    }
  });
  
  // Add total worker count for template loops
  spellVars.worker_count = workerOutputs.length.toString();
  
  // ----------------------------------------------------------------------------
  // Step 9: Add multi-sig support if present
  // ----------------------------------------------------------------------------
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    spellVars.multi_sig_signers = request.multiSigSigners.join(',');
    spellVars.multi_sig_threshold = (request.multiSigThreshold || 2).toString();
  }
  
  // ----------------------------------------------------------------------------
  // Step 10: Verify all critical variables are present before returning
  // ----------------------------------------------------------------------------
  const requiredVars = [
    'app_id', 'app_vk', 'plan_utxo', 'funding_utxo', 'anchor_utxo',
    'ticker', 'current_supply', 'new_remaining', 'metadataHash',
    'scrollPolicy', 'payPeriodSeconds', 'compensationSats',
    'change_amount', 'treasury_hex_dest', 'worker_count'
  ];
  
  const missingVars = requiredVars.filter(varName => !spellVars[varName]);
  if (missingVars.length > 0) {
    throw new ValidationError(
      `Missing required variables for YAML template: ${missingVars.join(', ')}`
    );
  }
  
  // Also verify that worker hex destinations are actually hex (no 't' characters)
  for (let i = 1; i <= workerOutputs.length; i++) {
    const hexDest = spellVars[`worker_hex_dest_${i}`];
    if (hexDest && /[^0-9a-f]/i.test(hexDest)) {
      throw new ValidationError(
        `worker_hex_dest_${i} contains non-hex characters. Value: ${hexDest.substring(0, 30)}...`
      );
    }
  }
  
  // ----------------------------------------------------------------------------
  // Step 11: Log variable summary (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] ✅ Template variables built:', {
      appId: appId.substring(0, 16) + '...',
      variableCount: Object.keys(spellVars).length,
      workerCount: workerOutputs.length,
      hasMultiSig: !!request.multiSigSigners,
      requiredVariablesPresent: requiredVars.every(v => spellVars[v]),
      sampleVariables: {
        plan_utxo: spellVars.plan_utxo,
        funding_utxo: spellVars.funding_utxo,
        ticker: spellVars.ticker,
        current_supply: spellVars.current_supply,
        new_remaining: spellVars.new_remaining,
        change_amount: spellVars.change_amount,
        treasury_hex_dest: spellVars.treasury_hex_dest?.substring(0, 16) + '...',
        worker_amount_1: spellVars.worker_amount_1,
        worker_hex_dest_1: spellVars.worker_hex_dest_1?.substring(0, 40) + '...'
      }
    });
  }
  
  return spellVars;
}

// --------------------------------------------------------------------------------
// Helper Functions (KEPT with original logic)
// --------------------------------------------------------------------------------

/**
 * Creates a spell request for hiring a single worker
 * 
 * @param authorityUtxo - Plan NFT UTXO
 * @param employerAddress - Where to return the NFT
 * @param workerAddress - Worker's wallet address
 * @param planMetadata - Plan NFT metadata (copied from the original)
 * @param fundingUtxo - UTXO for fees
 * @param changeAddress - Address for change
 * @returns Formatted SpellRequest
 */
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
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      // Worker token
      {
        address: workerAddress,
        tokenAmount: 1 // 1 token = 1 pay period
      },
      // NFT return to employer
      {
        address: employerAddress,
        nftMetadata: planMetadata
      }
    ]
  };
}

/**
 * Creates a spell request for batch hiring multiple workers
 * 
 * @param authorityUtxo - Plan NFT UTXO
 * @param employerAddress - Where to return the NFT
 * @param workers - Array of worker addresses (each gets 1 token)
 * @param planMetadata - Plan NFT metadata (copied from the original)
 * @param fundingUtxo - UTXO for fees
 * @param changeAddress - Address for change
 * @returns Formatted SpellRequest
 */
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
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      // Worker tokens (one per worker)
      ...workers.map(address => ({
        address,
        tokenAmount: 1
      })),
      // NFT return to employer
      {
        address: employerAddress,
        nftMetadata: planMetadata
      }
    ]
  };
}

/**
 * Creates a spell request for hiring workers with custom token amounts
 * (e.g., part-time workers getting 0.5 tokens)
 * 
 * @param authorityUtxo - Plan NFT UTXO
 * @param employerAddress - Where to return the NFT
 * @param workerAllocations - Array of {address, amount} pairs
 * @param planMetadata - Plan NFT metadata (copied from the original)
 * @param fundingUtxo - UTXO for fees
 * @param changeAddress - Address for change
 * @returns Formatted SpellRequest
 */
export function createCustomBatchHireRequest(
  authorityUtxo: string,
  employerAddress: string,
  workerAllocations: Array<{ address: string; amount: number }>,
  planMetadata: any,
  fundingUtxo: { utxo: string; value: number },
  changeAddress: string
): SpellRequest {
  // Validate total allocation
  const total = workerAllocations.reduce((sum, w) => sum + w.amount, 0);
  
  if (total > planMetadata.remaining) {
    throw new ValidationError(
      `Total allocation (${total}) exceeds remaining supply (${planMetadata.remaining})`
    );
  }

  return {
    type: 'mint-token',
    authorityUtxo,
    fundingUtxo: fundingUtxo.utxo,
    fundingUtxoValue: fundingUtxo.value,
    changeAddress,
    feeRate: constants.DEFAULT_FEE_RATE,
    outputs: [
      // Worker tokens with custom amounts
      ...workerAllocations.map(w => ({
        address: w.address,
        tokenAmount: w.amount
      })),
      // NFT return to employer
      {
        address: employerAddress,
        nftMetadata: planMetadata
      }
    ]
  };
}