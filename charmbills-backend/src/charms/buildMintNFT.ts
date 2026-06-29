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
// Helper: Converts "txid:vout" string to 36-byte Uint8Array (Byte String)
// --------------------------------------------------------------------------------
function utxoTo36Bytes(utxoId: string): Uint8Array {
  const [txid, vout] = utxoId.split(':');
  if (!txid || vout === undefined) {
    throw new ValidationError(`Invalid UTXO format: ${utxoId} (expected "txid:vout")`);
  }
  const txidBytes = Buffer.from(txid, 'hex');
  if (txidBytes.length !== 32) {
    throw new ValidationError(`Invalid txid length: expected 32 bytes, got ${txidBytes.length}`);
  }
  const voutBuf = Buffer.alloc(4);
  voutBuf.writeUInt32LE(parseInt(vout, 10));
  return new Uint8Array(Buffer.concat([txidBytes, voutBuf]));
}

// --------------------------------------------------------------------------------
// Helper: Converts hex string to Uint8Array (Byte String)
// --------------------------------------------------------------------------------
function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

// --------------------------------------------------------------------------------
// App ID Derivation
// --------------------------------------------------------------------------------

/**
 * Derives the unique App ID for a department's payroll plan.
 * appId = SHA256(anchor_utxo_id)
 * 
 * @param utxoId - Anchor UTXO ID in format "txid:vout"
 * @returns 64-character hex string (SHA256 hash)
 */
export function deriveAppId(utxoId: string): string {
  if (!utxoId || typeof utxoId !== 'string') {
    throw new ValidationError('Invalid utxoId: must be non-empty string');
  }
  
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
  if (request.type !== 'mint-nft') {
    throw new ValidationError(`Expected type 'mint-nft', got '${request.type}'`);
  }
  
  if (!request.anchorUtxo) {
    throw new ValidationError('anchorUtxo is required for payroll NFT minting');
  }
  
  if (!request.anchorValue || request.anchorValue < MIN_OUTPUT_SATS) {
    throw new ValidationError(
      `anchorValue must be at least ${MIN_OUTPUT_SATS} sats, got ${request.anchorValue}`
    );
  }
  
  if (!request.fundingUtxo) {
    throw new ValidationError('fundingUtxo is required for payroll NFT minting in v0.12');
  }
  
  if (!request.outputs || request.outputs.length !== 1) {
    throw new ValidationError(`Expected exactly 1 output, got ${request.outputs?.length || 0}`);
  }
  
  const output = request.outputs[0];
  
  if (!output.address) {
    throw new ValidationError('Output address is required');
  }
  
  const metadata = output.nftMetadata;
  if (!metadata) {
    throw new ValidationError('nftMetadata is required for payroll NFT minting');
  }
  
  if (!metadata.metadataHash) {
    throw new ValidationError('metadataHash is required (SHA256 of encrypted IPFS JSON)');
  }
  
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
  
  if (metadata.remaining !== undefined && metadata.remaining <= 0) {
    throw new ValidationError(`remaining must be positive if provided, got ${metadata.remaining}`);
  }
}

// --------------------------------------------------------------------------------
// Strict Type-Marshalling Builder for Rust Bridge
// --------------------------------------------------------------------------------

/**
 * Builds typed variables for the Rust bridge to process.
 * The NFT is sent directly to the employer's Taproot wallet (treasuryHexDest),
 * not to a Scroll vault.
 * 
 * @param request - Validated spell request with payroll metadata
 * @param treasuryHexDest - The treasury hex destination (Taproot script from company config)
 * @returns Object containing typed variables and derived appId
 */
export function buildMintNFTVarsWithTemplate(
  request: SpellRequest, 
  treasuryHexDest: string
): { variables: Record<string, string>; appId: string } {
  console.log('🚀 [NEW CODE] buildMintNFTVarsWithTemplate IS RUNNING - Version 3.0');
  
  validatePayrollRequest(request);
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for NFT minting');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }
  
  const appId = deriveAppId(request.anchorUtxo!);
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  
  const ticker = metadata.ticker || DEFAULT_TICKER;
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  const compensationSats = Math.max(metadata.compensationSats || 0, 1000);
  
  const variables: Record<string, string> = {
    type_name: "mint-nft",
    app_id: String(appId),
    app_vk: String(APP_VK),
    anchor_utxo: String(request.anchorUtxo!),
    funding_utxo: String(request.fundingUtxo!),
    ticker: String(ticker),
    remaining: String(remaining),
    metadata_hash: String(metadata.metadataHash),
    scroll_policy: String(metadata.scrollPolicy),
    pay_period_seconds: String(metadata.payPeriodSeconds),
    compensation_sats: String(compensationSats),
    treasury_dest: String(treasuryHexDest),
    scrolls: ""
  };
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Typed variables built for Rust bridge:', {
      type_name: variables.type_name,
      appId: appId.substring(0, 16) + '...',
      ticker,
      remaining,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...',
      anchorUtxo: request.anchorUtxo,
      fundingUtxo: request.fundingUtxo,
      treasury_dest: variables.treasury_dest.substring(0, 30) + '...',
      scrolls: variables.scrolls,
      variableCount: Object.keys(variables).length
    });
  }
  
  return { variables, appId };
}

// --------------------------------------------------------------------------------
// Legacy Builder - Direct JSON Construction (Kept for backward compatibility)
// --------------------------------------------------------------------------------

/**
 * Builds the spell JSON object directly (legacy approach).
 * Used by older prover client versions.
 */
export function buildMintNFTJSON(
  request: SpellRequest, 
  treasuryHexDest: string
): { spell: any; appId: string } {
  validatePayrollRequest(request);
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for NFT minting');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }
  
  const appId = deriveAppId(request.anchorUtxo!);
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  
  const ticker = metadata.ticker || DEFAULT_TICKER;
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  const compensationSats = Math.max(metadata.compensationSats || 0, 1000);
  
  const anchorInputBytes = utxoTo36Bytes(request.anchorUtxo!);
  const fundingInputBytes = utxoTo36Bytes(request.fundingUtxo!);
  const destBytes = hexToBytes(treasuryHexDest);
  
  const appIdBytes = hexToBytes(appId);
  const appVkBytes = hexToBytes(APP_VK);
  
  const appPublicInputs = new Map();
  appPublicInputs.set(["n", appIdBytes, appVkBytes], null);
  
  const spell = {
    version: 15,
    tx: {
      ins: [anchorInputBytes, fundingInputBytes],
      outs: [
        {
          "0": {
            ticker: ticker,
            remaining: remaining,
            metadataHash: metadata.metadataHash,
            scrollPolicy: metadata.scrollPolicy,
            payPeriodSeconds: metadata.payPeriodSeconds,
            compensationSats: compensationSats
          }
        }
      ],
      coins: [
        {
          amount: 1000,
          dest: destBytes
        }
      ]
    },
    app_public_inputs: appPublicInputs
  };
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Legacy spell JSON built:', {
      appId,
      ticker,
      remaining,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...'
    });
  }
  
  return { spell, appId };
}

// --------------------------------------------------------------------------------
// Legacy Variable Builders - Kept for backward compatibility
// --------------------------------------------------------------------------------

export function buildMintNFTVars(
  request: SpellRequest, 
  treasuryHexDest: string
): { variables: Record<string, string>; appId: string } {
  validatePayrollRequest(request);
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for NFT minting');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }
  
  const appId = deriveAppId(request.anchorUtxo!);
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  const ticker = metadata.ticker || DEFAULT_TICKER;
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  const compensationSats = Math.max(metadata.compensationSats || 0, 1000);
  
  const variables: Record<string, string> = {
    app_id: appId,
    app_vk: APP_VK,
    anchor_utxo: String(request.anchorUtxo!),
    funding_utxo: String(request.fundingUtxo!),
    ticker: String(ticker),
    remaining: String(remaining),
    metadataHash: String(metadata.metadataHash),
    scrollPolicy: String(metadata.scrollPolicy),
    payPeriodSeconds: String(metadata.payPeriodSeconds),
    compensationSats: String(compensationSats),
    treasury_dest: String(treasuryHexDest)
  };
  
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    variables.multi_sig_signers = String(request.multiSigSigners.join(','));
    variables.multi_sig_threshold = String(request.multiSigThreshold || 2);
  }
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Legacy variables built:', {
      appId,
      ticker,
      remaining,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...',
      variableCount: Object.keys(variables).length
    });
  }
  
  return { variables, appId };
}

export function buildMintNFT(
  request: SpellRequest, 
  treasuryHexDest: string
): { spellVars: Record<string, string>; appId: string } {
  validatePayrollRequest(request);
  
  if (!treasuryHexDest || typeof treasuryHexDest !== 'string') {
    throw new ValidationError('treasuryHexDest is required for NFT minting');
  }
  
  const hexRegex = /^[0-9a-fA-F]+$/;
  if (!hexRegex.test(treasuryHexDest) || treasuryHexDest.length % 2 !== 0) {
    throw new ValidationError('treasuryHexDest must be a valid hex string');
  }
  
  const appId = deriveAppId(request.anchorUtxo!);
  const output = request.outputs[0];
  const metadata = output.nftMetadata!;
  const ticker = metadata.ticker || DEFAULT_TICKER;
  const remaining = metadata.remaining !== undefined ? metadata.remaining : 1;
  const compensationSats = Math.max(metadata.compensationSats || 0, 1000);
  
  const spellVars: Record<string, string> = {
    app_id: appId,
    app_vk: APP_VK,
    in_utxo_0: request.anchorUtxo!,
    funding_utxo: request.fundingUtxo!,
    ticker: ticker,
    remaining: remaining.toString(),
    metadataHash: metadata.metadataHash,
    scrollPolicy: (metadata.scrollPolicy ?? 0).toString(),
    payPeriodSeconds: (metadata.payPeriodSeconds ?? 0).toString(),
    compensationSats: compensationSats.toString(),
    dest_0: treasuryHexDest,
    amount_0: "1000"
  };
  
  if (request.multiSigSigners && request.multiSigSigners.length > 0) {
    spellVars.multi_sig_signers = request.multiSigSigners.join(',');
    spellVars.multi_sig_threshold = (request.multiSigThreshold || 2).toString();
  }
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildMintNFT.payroll] ✅ Legacy template variables built:', {
      appId,
      ticker,
      remaining,
      scrollPolicy: metadata.scrollPolicy === 0 ? 'Time' : 'Proof',
      payPeriodSeconds: metadata.payPeriodSeconds,
      compensationSats: spellVars.compensationSats,
      metadataHash: metadata.metadataHash.substring(0, 16) + '...',
      variableCount: Object.keys(spellVars).length
    });
  }
  
  return { spellVars, appId };
}

// --------------------------------------------------------------------------------
// Helper: Create payroll plan request
// --------------------------------------------------------------------------------

export function createPayrollPlanRequest(params: {
  anchorUtxo: string;
  anchorValue: number;
  fundingUtxo: string;
  fundingValue: number;
  changeAddress: string;
  employerAddress: string;
  ticker?: string;
  metadataHash: string;
  scrollPolicy: 0 | 1;
  payPeriodSeconds: number;
  compensationSats?: number;
  remaining?: number;
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
          compensationSats: compensationSats || 0
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
  
  return createPayrollPlanRequest({
    anchorUtxo,
    anchorValue,
    fundingUtxo,
    fundingValue,
    changeAddress,
    employerAddress,
    metadataHash: crypto.createHash('sha256').update('test-cid').digest('hex'),
    scrollPolicy: 0,
    payPeriodSeconds: 1209600,
    compensationSats: 0,
    ticker: 'PAY-TEST',
    remaining: 100,
    multiSigSigners: ['key1', 'key2', 'key3'],
    multiSigThreshold: 2
  });
}