import { SpellRequest } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

// --------------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------------
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const DEFAULT_TICKER = constants.PAYROLL_NFT_TICKER || "CHARMS-PAY";
const MIN_OUTPUT_SATS = constants.MIN_OUTPUT_SATS || 1000;
const PROTOCOL_VERSION = 8;

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

  // Check funding UTXO (now required for v0.12)
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
// Spell Builder (UPDATED with v0.12 funding UTXO fix)
// --------------------------------------------------------------------------------

/**
 * Builds a Batched Mint-Token Spell for Charms Inc. Payroll.
 * Implements the 1:M:N Scaling Model: 1 NFT Authority -> M Workers -> N Periods.
 * 
 * This function creates a single transaction that:
 * 1. Consumes the Plan NFT (authority) as input
 * 2. Creates M worker tokens (one per employee/freelancer)
 * 3. Returns the Plan NFT to employer with updated remaining supply
 * 
 * @param request - Validated spell request with worker outputs and NFT return metadata
 * @param appId - The existing appId from the saved plan (passed, not derived)
 * @returns Spell JSON for Prover API
 */
export function buildMintToken(request: SpellRequest, appId: string): any {
  // ----------------------------------------------------------------------------
  // Step 1: Validate request
  // ----------------------------------------------------------------------------
  validateBatchMintRequest(request);

  // ----------------------------------------------------------------------------
  // Step 2: Separate and validate outputs
  // ----------------------------------------------------------------------------
  const { workerOutputs, nftReturnOutput } = separateOutputs(request);

  // ----------------------------------------------------------------------------
  // Step 3: Use passed appId (DO NOT derive)
  // ----------------------------------------------------------------------------
  const currentSupply = Number(nftReturnOutput.nftMetadata.remaining);
  const totalTokensToMint = workerOutputs.reduce((sum, w) => sum + w.tokenAmount, 0);
  const newRemainingSupply = currentSupply - totalTokensToMint;

  // ----------------------------------------------------------------------------
  // Step 4: Log batch details (debug only)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintToken.payroll] 📦 Batch mint details:', {
      appId: appId.substring(0, 16) + '...',
      workers: workerOutputs.length,
      totalTokens: totalTokensToMint,
      currentSupply,
      newRemainingSupply,
      scrollPolicy: nftReturnOutput.nftMetadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      authorityUtxo: request.authorityUtxo,
      fundingUtxo: request.fundingUtxo
    });
  }

  // ----------------------------------------------------------------------------
  // Step 5: Construct spell JSON with v0.12 changes
  // ----------------------------------------------------------------------------
  return {
    version: PROTOCOL_VERSION,
    
    // Define apps: $00 = NFT Authority, $01 = Fungible Token
    apps: {
      "$00": `n/${appId}/${APP_VK}`,
      "$01": `t/${appId}/${APP_VK}`
    },
    
    // CRITICAL FIX: Add private_inputs block to satisfy Rust authority check
    // This must contain the original Anchor UTXO ID string that hashes to appId
    private_inputs: {
      "$00": process.env.PAYROLL_ANCHOR_UTXO // The string that hashes to appId
    },
    
    // FIX v0.12: Both authority UTXO and funding UTXO must be in the ins array
    ins: [
      {
        utxo_id: request.authorityUtxo,
        charms: {
          "$00": {
            ticker: nftReturnOutput.nftMetadata.ticker || DEFAULT_TICKER,
            remaining: currentSupply,
            metadataHash: nftReturnOutput.nftMetadata.metadataHash,
            scrollPolicy: Number(nftReturnOutput.nftMetadata.scrollPolicy),
            payPeriodSeconds: Number(nftReturnOutput.nftMetadata.payPeriodSeconds),
            compensationSats: Number(nftReturnOutput.nftMetadata.compensationSats)
          }
        }
      },
      {
        utxo_id: request.fundingUtxo, // FIX: Move funding UTXO into the spell inputs
        charms: {} // Plain BTC inputs have empty charms
      }
    ],
    
    // Outputs: Worker tokens + NFT return
    outs: [
      // WORKER OUTPUTS: Create M fungible tokens for M workers
      // Each token represents 1 pay period authorization
      ...workerOutputs.map(worker => ({
        address: worker.address,
        charms: {
          "$01": Number(worker.tokenAmount) // 1 token = 1 pay period
        },
        sats: MIN_OUTPUT_SATS // Dust limit compliance
      })),
      
      // EMPLOYER RETURN: Return the Authority NFT with updated supply
      {
        address: nftReturnOutput.address,
        charms: {
          "$00": {
            ticker: nftReturnOutput.nftMetadata.ticker || DEFAULT_TICKER,
            remaining: newRemainingSupply,
            metadataHash: nftReturnOutput.nftMetadata.metadataHash,
            scrollPolicy: Number(nftReturnOutput.nftMetadata.scrollPolicy),
            payPeriodSeconds: Number(nftReturnOutput.nftMetadata.payPeriodSeconds),
            compensationSats: Number(nftReturnOutput.nftMetadata.compensationSats)
          }
        },
        sats: MIN_OUTPUT_SATS // Employer liquidity preservation
      }
    ]
  };
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