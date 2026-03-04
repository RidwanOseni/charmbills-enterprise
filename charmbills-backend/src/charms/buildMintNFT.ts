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
// Validation Errors
// --------------------------------------------------------------------------------
class ValidationError extends Error {
  constructor(message: string) {
    super(`[buildMintNFT] ${message}`);
    this.name = 'ValidationError';
  }
}

// --------------------------------------------------------------------------------
// App ID Derivation
// --------------------------------------------------------------------------------

/**
 * Derives the unique App ID for a department's payroll plan.
 * appId = SHA256(anchor_utxo_id) [3, 5]
 * 
 * @param utxoId - Anchor UTXO ID in format "txid:vout"
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
// Input Validation
// --------------------------------------------------------------------------------

/**
 * Validates that the request contains all required fields for payroll NFT minting
 */
function validatePayrollRequest(request: SpellRequest): void {
  // Check request type
  if (request.type !== 'mint-nft') {
    throw new ValidationError(`Expected type 'mint-nft', got '${request.type}'`);
  }
  
  // Check anchor UTXO
  if (!request.anchorUtxo) {
    throw new ValidationError('anchorUtxo is required for payroll NFT minting');
  }
  
  if (!request.anchorValue || request.anchorValue < MIN_OUTPUT_SATS) {
    throw new ValidationError(
      `anchorValue must be at least ${MIN_OUTPUT_SATS} sats, got ${request.anchorValue}`
    );
  }
  
  // Check funding UTXO (now required for v0.12)
  if (!request.fundingUtxo) {
    throw new ValidationError('fundingUtxo is required for payroll NFT minting in v0.12');
  }
  
  // Check outputs
  if (!request.outputs || request.outputs.length !== 1) {
    throw new ValidationError(`Expected exactly 1 output, got ${request.outputs?.length || 0}`);
  }
  
  const output = request.outputs[0];
  
  if (!output.address) {
    throw new ValidationError('Output address is required');
  }
  
  // Check NFT metadata
  const metadata = output.nftMetadata;
  if (!metadata) {
    throw new ValidationError('nftMetadata is required for payroll NFT minting');
  }
  
  // Required enforcement fields (must be present and valid)
  if (!metadata.metadataHash) {
    throw new ValidationError('metadataHash is required (SHA256 of encrypted IPFS JSON)');
  }
  
  // Validate metadataHash format (64 hex chars = 32 bytes)
  if (!/^[a-f0-9]{64}$/i.test(metadata.metadataHash)) {
    throw new ValidationError(`metadataHash must be 64 hex characters, got ${metadata.metadataHash.length}`);
  }
  
  if (metadata.scrollPolicy === undefined || metadata.scrollPolicy === null) {
    throw new ValidationError('scrollPolicy is required (0=Time, 1=Proof)');
  }
  
  if (![0, 1].includes(metadata.scrollPolicy)) {
    throw new ValidationError(`scrollPolicy must be 0 (Time) or 1 (Proof), got ${metadata.scrollPolicy}`);
  }
  
  if (!metadata.payPeriodSeconds || metadata.payPeriodSeconds <= 0) {
    throw new ValidationError(`payPeriodSeconds must be positive, got ${metadata.payPeriodSeconds}`);
  }
  
  if (!metadata.compensationSats || metadata.compensationSats < MIN_OUTPUT_SATS) {
    throw new ValidationError(
      `compensationSats must be at least ${MIN_OUTPUT_SATS}, got ${metadata.compensationSats}`
    );
  }
  
  // Optional fields with defaults
  if (metadata.remaining !== undefined && metadata.remaining <= 0) {
    throw new ValidationError(`remaining must be positive if provided, got ${metadata.remaining}`);
  }
}

// --------------------------------------------------------------------------------
// Spell Builder
// --------------------------------------------------------------------------------

/**
 * Builds the Spell JSON for creating a Charms Inc. Plan NFT (Authority Object).
 * Implements the Hybrid Metadata model for privacy and enforcement [1].
 * 
 * @param request - Validated spell request with payroll metadata
 * @returns Object containing the spell JSON and derived appId
 */
export function buildMintNFT(request: SpellRequest): { spell: any; appId: string } {
  // ----------------------------------------------------------------------------
  // Step 1: Validate input
  // ----------------------------------------------------------------------------
  validatePayrollRequest(request);
  
  // ----------------------------------------------------------------------------
  // Step 2: Derive appId from anchor UTXO
  // ----------------------------------------------------------------------------
  const appId = deriveAppId(request.anchorUtxo!);
  
  // ----------------------------------------------------------------------------
  // Step 3: Extract validated data
  // ----------------------------------------------------------------------------
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  
  // Use provided ticker or default (ensure it's a string)
  const ticker = metadata.ticker || DEFAULT_TICKER;
  
  // Remaining supply (default 1 for single authority NFT)
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  
  // ----------------------------------------------------------------------------
  // Step 4: Build spell JSON with v0.12 changes
  // ----------------------------------------------------------------------------
  const spell = {
    version: PROTOCOL_VERSION,
    
    // Define the NFT app with tag 'n' (NFT) and derived identity [5]
    apps: {
      "$00": `n/${appId}/${APP_VK}`
    },
    
    // Private input links the app identity to the specific anchor UTXO [7, 8]
    private_inputs: {
      "$00": request.anchorUtxo
    },
    
    // FIX v0.12: Both anchor UTXO and funding UTXO must be in the ins array
    ins: [
      {
        utxo_id: request.anchorUtxo,
        charms: {} // Initial minting has no charms in input [6]
      },
      {
        utxo_id: request.fundingUtxo, // FIX: Move funding UTXO into the spell inputs
        charms: {} // Plain BTC inputs have empty charms
      }
    ],
    
    // Outputs array: exactly one NFT output
    outs: [
      {
        address: output.address,
        charms: {
          "$00": {
            // Core identifiers
            ticker: ticker,
            remaining: remaining,
            
            // Enforcement fields (used by Rust contract)
            metadataHash: metadata.metadataHash,   // SHA256 of encrypted IPFS JSON [1]
            scrollPolicy: metadata.scrollPolicy,   // 0=Time, 1=Proof
            payPeriodSeconds: metadata.payPeriodSeconds,
            compensationSats: metadata.compensationSats
          }
        },
        // NFT must meet dust limit [9]
        sats: MIN_OUTPUT_SATS
      }
    ]
  };
  
  // ----------------------------------------------------------------------------
  // Step 5: Logging (debug only, remove in production)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Spell built successfully:', {
      appId,
      ticker,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats: metadata.compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...',
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo
    });
  }
  
  return { spell, appId };
}

// --------------------------------------------------------------------------------
// Helper: Create payroll plan request
// --------------------------------------------------------------------------------

/**
 * Creates a properly formatted SpellRequest for payroll plan creation
 * 
 * @param params - Payroll plan parameters
 * @returns Formatted SpellRequest ready for proverClient
 */
export function createPayrollPlanRequest(params: {
  anchorUtxo: string;
  anchorValue: number;
  fundingUtxo: string;
  fundingValue: number;
  changeAddress: string;
  employerAddress: string;  // Where the NFT will be sent
  ticker?: string;
  metadataHash: string;      // SHA256 of encrypted IPFS JSON
  scrollPolicy: 0 | 1;       // 0=Time, 1=Proof
  payPeriodSeconds: number;
  compensationSats: number;
  remaining?: number;        // Optional, defaults to 1
  feeRate?: number;
  multiSigSigners?: string[];
  multiSigThreshold?: number;
}): SpellRequest {
  const {
    anchorUtxo,
    anchorValue,
    fundingUtxo,
    fundingValue,
    changeAddress,
    employerAddress,
    ticker,
    metadataHash,
    scrollPolicy,
    payPeriodSeconds,
    compensationSats,
    remaining,
    feeRate,
    multiSigSigners,
    multiSigThreshold
  } = params;
  
  return {
    type: 'mint-nft',
    anchorUtxo,
    anchorValue,
    fundingUtxo,
    fundingUtxoValue: fundingValue,
    changeAddress,
    feeRate: feeRate || constants.DEFAULT_FEE_RATE,
    outputs: [
      {
        address: employerAddress,
        nftMetadata: {
          ticker: ticker || DEFAULT_TICKER,
          remaining: remaining !== undefined ? remaining : 1,
          metadataHash,
          scrollPolicy,
          payPeriodSeconds,
          compensationSats
        }
      }
    ],
    ...(multiSigSigners && { 
       multiSigSigners: multiSigSigners, 
       multiSigThreshold: multiSigThreshold || 2
    })
  };
}

// --------------------------------------------------------------------------------
// Testing helpers (only used in development)
// --------------------------------------------------------------------------------

/**
 * Creates a test request using environment variables (for CLI testing only)
 */
export function createTestPayrollRequest(): SpellRequest {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('createTestPayrollRequest should not be used in production');
  }
  
  const anchorUtxo = process.env.TEST_ANCHOR_UTXO;
  const anchorValue = Number(process.env.TEST_ANCHOR_VALUE);
  const fundingUtxo = process.env.TEST_FUNDING_UTXO;
  const fundingValue = Number(process.env.TEST_FUNDING_VALUE);
  const changeAddress = process.env.TEST_CHANGE_ADDRESS;
  const employerAddress = process.env.TEST_EMPLOYER_ADDRESS;
  
  if (!anchorUtxo || !anchorValue || !fundingUtxo || !fundingValue || !changeAddress || !employerAddress) {
    throw new Error('Missing test environment variables');
  }
  
  // Example test values
  return createPayrollPlanRequest({
    anchorUtxo,
    anchorValue,
    fundingUtxo,
    fundingValue,
    changeAddress,
    employerAddress,
    metadataHash: crypto.createHash('sha256').update('test-cid').digest('hex'),
    scrollPolicy: 0, // Time-based for employees
    payPeriodSeconds: 1209600, // 2 weeks
    compensationSats: 5000000, // 5M sats
    ticker: 'PAY-TEST',
    multiSigSigners: ['key1', 'key2', 'key3'],
    multiSigThreshold: 2
  });
}