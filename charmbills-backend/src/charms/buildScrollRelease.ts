import { SpellRequest } from '@shared/types';
import * as constants from '@shared/constants';

const APP_VK = process.env.HARDCODED_APP_VK || constants.HARDCODED_APP_VK;
const MIN_OUTPUT_SATS = constants.MIN_OUTPUT_SATS || 1000;

class ValidationError extends Error {
  constructor(message: string) {
    super(`[buildScrollRelease] ${message}`);
    this.name = 'ValidationError';
  }
}

function validateScrollReleaseRequest(request: SpellRequest): void {
  if (request.type !== 'scroll-release') {
    throw new ValidationError(`Expected type 'scroll-release', got '${request.type}'`);
  }
  
  const authorityUtxos = request.authorityUtxos || (request.authorityUtxo ? [request.authorityUtxo] : []);
  
  if (authorityUtxos.length === 0) {
    throw new ValidationError('authorityUtxos is required for scroll-release (worker tokens being spent)');
  }
  
  if (!request.fundingUtxo) {
    throw new ValidationError('fundingUtxo is required for scroll-release (treasury UTXO for fees)');
  }
  
  if (!request.salaryUtxo) {
    throw new ValidationError('salaryUtxo is required for scroll-release (vault UTXO for salaries)');
  }
  
  if (!request.outputs || request.outputs.length === 0) {
    throw new ValidationError('Outputs are required for scroll-release (worker payments)');
  }
  
  if (!request.planMetadata?.appId) {
    throw new ValidationError('planMetadata.appId is required for scroll-release');
  }
  
  if (!request.planMetadata?.ticker) {
    throw new ValidationError('planMetadata.ticker is required for scroll-release (department NFT)');
  }
  
  if (request.planMetadata?.remaining === undefined) {
    throw new ValidationError('planMetadata.remaining is required for scroll-release (updated supply)');
  }
}

export function buildScrollReleaseVars(
  request: SpellRequest,
  treasuryHexDest: string
): { variables: Record<string, any> } {
  console.log('[buildScrollRelease] Building typed variables for scroll-release');
  
  validateScrollReleaseRequest(request);
  
  const authorityUtxos = request.authorityUtxos || (request.authorityUtxo ? [request.authorityUtxo] : []);
  
  const realWorkers = request.outputs.filter(o => 
    o.address !== constants.PLATFORM_FEE_ADDRESS && 
    o.address !== constants.SCROLL_FEE_ADDRESS_TESTNET4 &&
    o.address !== request.vaultChangeAddress &&
    o.address !== request.changeAddress &&
    !o.nftMetadata
  );
  
  const workerDests = realWorkers.map(o => o.address);
  const salaryAmounts = realWorkers.map(o => String(o.sats || 0));
  
  console.log(`[buildScrollRelease] Worker count: ${workerDests.length}`);
  console.log(`[buildScrollRelease] Authority token count: ${authorityUtxos.length}`);
  console.log(`[buildScrollRelease] Total salary: ${realWorkers.reduce((sum, o) => sum + (o.sats || 0), 0)} sats`);
  
  const platformFeeOutput = request.outputs.find(o => o.address === constants.PLATFORM_FEE_ADDRESS);
  const scrollFeeOutput = request.outputs.find(o => o.address === constants.SCROLL_FEE_ADDRESS_TESTNET4);
  
  if (platformFeeOutput) {
    console.log(`[buildScrollRelease] Platform fee: ${platformFeeOutput.sats} sats`);
  }
  if (scrollFeeOutput) {
    console.log(`[buildScrollRelease] Scroll fee: ${scrollFeeOutput.sats} sats`);
  }
  
  console.log(`[buildScrollRelease] Department NFT state: ticker=${request.planMetadata!.ticker}, remaining=${request.planMetadata!.remaining}`);
  
  const workerCount = realWorkers.length;
  let scrollIndex = workerCount;
  if (platformFeeOutput) scrollIndex++;
  if (scrollFeeOutput) scrollIndex++;
  
  const variables: Record<string, any> = {
    type_name: "scroll-release",
    app_id: String(request.planMetadata!.appId),
    app_vk: String(APP_VK),
    anchor_utxo: authorityUtxos[0] || '',
    authority_utxos: authorityUtxos,
    funding_utxo: String(request.fundingUtxo),
    salary_utxo: String(request.salaryUtxo),
    treasury_dest: "",
    ticker: request.planMetadata!.ticker,
    remaining: String(request.planMetadata!.remaining),
    metadata_hash: request.planMetadata!.metadataHash || "0".repeat(64),
    scroll_policy: String(request.planMetadata!.scrollPolicy || 0),
    pay_period_seconds: String(request.planMetadata!.payPeriodSeconds || 0),
    compensation_sats: String(request.planMetadata!.compensationSats || 0),
    has_treasury_change: !!request.hasTreasuryChange,
    worker_dests: workerDests,
    token_amounts: salaryAmounts,
    scrolls: String(scrollIndex)
  };
  
  if (process.env.NODE_ENV !== 'production') {
    console.log('[buildScrollRelease] ✅ Typed variables built for Rust bridge:', {
      type_name: variables.type_name,
      appId: request.planMetadata!.appId.substring(0, 16) + '...',
      ticker: variables.ticker,
      remaining: variables.remaining,
      authority_count: authorityUtxos.length,
      funding_utxo: request.fundingUtxo.substring(0, 20) + '...',
      salary_utxo: request.salaryUtxo ? request.salaryUtxo.substring(0, 20) + '...' : 'undefined',
      worker_count: workerDests.length,
      scrolls_index: variables.scrolls,
      treasury_dest_empty: variables.treasury_dest === "",
      variableCount: Object.keys(variables).length
    });
  }
  
  return { variables };
}