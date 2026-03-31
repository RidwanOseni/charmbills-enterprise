import { SpellRequest } from '@shared/types';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

// --------------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------------
const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const DEFAULT_TICKER = constants.PAYROLL_NFT_TICKER || "CHARMS-PAY";
const MIN_OUTPUT_SATS = constants.MIN_OUTPUT_SATS || 1000;

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
 * UPDATED: Removed compensationSats validation - now enforced at Scroll Settlement Layer
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
  
  // v0.12 FIX: Check funding UTXO (now required and must be in spell inputs)
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
  
  // ----------------------------------------------------------------------------
  // REMOVED: compensationSats validation - no longer enforced on-chain
  // Salary enforcement now happens at Scroll Settlement Layer
  // ----------------------------------------------------------------------------
  // OLD VALIDATION (REMOVED):
  // if (!metadata.compensationSats || metadata.compensationSats < MIN_OUTPUT_SATS) {
  //   throw new ValidationError(...);
  // }
  
  // Optional fields with defaults
  if (metadata.remaining !== undefined && metadata.remaining <= 0) {
    throw new ValidationError(`remaining must be positive if provided, got ${metadata.remaining}`);
  }
}

// --------------------------------------------------------------------------------
// Spell Builder (Template Variables Version)
// --------------------------------------------------------------------------------

/**
 * Builds the template variables for creating a Charms Inc. Plan NFT (Authority Object).
 * Instead of building the complete JSON, this returns variables that will be substituted
 * into YAML templates via envsubst in proverClient.ts.
 * 
 * Implements the Hybrid Metadata model for privacy and enforcement [1].
 * 
 * UNIFIED DEPARTMENTAL NFT MODEL:
 * - compensationSats is now a placeholder (0) since salary is enforced at Scroll Settlement Layer
 * - One NFT per department handles multiple workers with different salaries
 * 
 * @param request - Validated spell request with payroll metadata
 * @param treasuryHexDest - The treasury hex destination (from company config) [5, 11]
 * @returns Object containing template variables and derived appId
 */
export function buildMintNFT(
  request: SpellRequest, 
  treasuryHexDest: string // Passed from API lookup [5, 11]
): { spellVars: Record<string, string>; appId: string } {
  // ----------------------------------------------------------------------------
  // Step 1: Validate input
  // ----------------------------------------------------------------------------
  validatePayrollRequest(request);
  
  // ----------------------------------------------------------------------------
  // Step 2: Validate treasuryHexDest parameter
  // ----------------------------------------------------------------------------
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for NFT minting');
  }
  
  // Validate hex destination format (should be hex string, starts with '5120' for Taproot)
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string (even number of hex characters)');
  }
  
  // ----------------------------------------------------------------------------
  // Step 3: Derive appId from anchor UTXO
  // ----------------------------------------------------------------------------
  const appId = deriveAppId(request.anchorUtxo!);
  
  // ----------------------------------------------------------------------------
  // Step 4: Extract validated data
  // ----------------------------------------------------------------------------
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  
  // Use provided ticker or default
  const ticker = metadata.ticker || DEFAULT_TICKER;
  
  // Remaining supply (default to 1 unless specified)
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  
  // ----------------------------------------------------------------------------
  // Step 5: Build template variables for envsubst
  // ----------------------------------------------------------------------------
  const spellVars: Record<string, string> = {
    // App identifiers
    app_id: appId,
    app_vk: APP_VK,
    
    // UTXO inputs for the YAML 'ins' block [Source 729]
    in_utxo_0: request.anchorUtxo!,
    funding_utxo: request.fundingUtxo!,

    // NFT metadata - Casing must be camelCase for Rust serde [Source 38]
    ticker: ticker,
    remaining: remaining.toString(),
    metadataHash: metadata.metadataHash,
    scrollPolicy: (metadata.scrollPolicy ?? 0).toString(),
    payPeriodSeconds: (metadata.payPeriodSeconds ?? 0).toString(),
    
    // CRITICAL: Must be >= 1000 to pass Rust validation [Source 39]
    // Even if placeholder, "0" will cause a Condition Failed error.
    compensationSats: Math.max(metadata.compensationSats || 0, 1000).toString(),

    // Bitcoin Destination - Must match ${dest_0} in mint-nft.yaml [Source 729]
    dest_0: treasuryHexDest,
    amount_0: "1000" // Required for the coins array amount [Source 810]
};
  
  // Add optional multi-sig fields if present
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    spellVars.multi_sig_signers = request.multiSigSigners.join(',');
    spellVars.multi_sig_threshold = (request.multiSigThreshold || 2).toString();
  }
  
  // ----------------------------------------------------------------------------
  // Step 6: Logging (debug only, remove in production)
  // ----------------------------------------------------------------------------
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Template variables built:', {
      appId,
      ticker,
      remaining,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats: spellVars.compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...',
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo,
      treasuryHexDest: treasuryHexDest.substring(0, 16) + '...',
      hasMultiSig: !!request.multiSigSigners
    });
  }
  
  return { spellVars, appId };
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
  compensationSats?: number;  // Optional - now only used in IPFS metadata
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
          compensationSats: compensationSats || 0 // Placeholder - not enforced on-chain
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
    compensationSats: 0, // Placeholder - not enforced
    ticker: 'PAY-TEST',
    remaining: 100, // Department supply (100 tokens for hiring)
    multiSigSigners: ['key1', 'key2', 'key3'],
    multiSigThreshold: 2
  });
}