import { Request, Response } from 'express';
import { generateUnsignedTransactions } from '../charms/proverClient';
import { getDynamicFundingUtxo, estimateRequiredSats } from '../lib/utxo-manager';
import { SpellRequest, ProverResult } from '@shared/types';
import { calculateScrollFee } from '../lib/charms-utils';
import * as constants from '@shared/constants';
import * as crypto from 'crypto';

/**
 * Endpoint to hire workers (mint payroll tokens) with dynamic UTXO selection
 * POST /api/subscriptions/mint
 */
export async function mintPayrollToken(req: Request, res: Response) {
  const requestId = crypto.randomBytes(4).toString('hex');
  
  console.log(`\n[HIRING API:${requestId}] ===== START mintPayrollToken =====`);
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Validate request body
    // ----------------------------------------------------------------------------
    const { 
      authorityUtxo,      // Plan NFT UTXO
      authorityTxHex,     // Plan NFT creation tx hex (for provenance)
      workers,            // Array of worker addresses
      employerAddress,    // Where to return the Plan NFT
      planMetadata        // Plan NFT metadata (copied from original)
    } = req.body;

    console.log(`[HIRING API:${requestId}] Request summary:`, {
      authorityUtxo: authorityUtxo?.substring(0, 20) + '...',
      workerCount: workers?.length,
      employerAddress: employerAddress?.substring(0, 20) + '...'
    });

    // Validate required fields
    if (!authorityUtxo || !authorityTxHex || !workers || !employerAddress || !planMetadata) {
      const missing = [];
      if (!authorityUtxo) missing.push('authorityUtxo');
      if (!authorityTxHex) missing.push('authorityTxHex');
      if (!workers) missing.push('workers');
      if (!employerAddress) missing.push('employerAddress');
      if (!planMetadata) missing.push('planMetadata');
      
      throw new Error(`Missing required fields: ${missing.join(', ')}`);
    }

    if (!Array.isArray(workers) || workers.length === 0) {
      throw new Error('workers must be a non-empty array');
    }

    // Validate each worker
    workers.forEach((w: any, i: number) => {
      if (!w.address) {
        throw new Error(`Worker ${i} missing address`);
      }
    });

    // ----------------------------------------------------------------------------
    // Step 2: Get treasury address from environment
    // ----------------------------------------------------------------------------
    const treasuryAddress = process.env.PAYROLL_TREASURY_ADDRESS;
    if (!treasuryAddress) {
      throw new Error('PAYROLL_TREASURY_ADDRESS not set in environment');
    }

    // ----------------------------------------------------------------------------
    // Step 3: Calculate required satoshis
    // ----------------------------------------------------------------------------
    const requiredSats = estimateRequiredSats(workers.length);
    console.log(`[HIRING API:${requestId}] Estimated required: ${requiredSats} sats`);

    // ----------------------------------------------------------------------------
    // Step 4: Dynamically select funding UTXO
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Selecting funding UTXO...`);
    const funding = await getDynamicFundingUtxo(treasuryAddress, requiredSats);
    
    console.log(`[HIRING API:${requestId}] Selected funding:`, {
      utxo: funding.utxoId,
      value: funding.value
    });

    // ----------------------------------------------------------------------------
    // Step 5: Calculate Scroll service fee (ENTERPRISE ADDITION)
    // ----------------------------------------------------------------------------
    const totalSatsSpent = funding.value;
    const numInputs = 2; // Authority UTXO + Funding UTXO
    const scrollFee = calculateScrollFee(numInputs, totalSatsSpent);
    
    console.log(`[HIRING API:${requestId}] 💳 Calculated Scroll Service Fee: ${scrollFee} sats`);

    // ----------------------------------------------------------------------------
    // Step 6: Build worker outputs (each gets MIN_OUTPUT_SATS)
    // ----------------------------------------------------------------------------
    const workerOutputs = workers.map((w: any) => ({
      address: w.address,
      tokenAmount: w.periods || 1, // Default 1 token = 1 pay period
      sats: constants.MIN_OUTPUT_SATS // 1000 sats (dust limit)
    }));

    // Calculate total tokens being minted
    const totalTokens = workerOutputs.reduce((sum, w) => sum + w.tokenAmount, 0);
    
    // Validate supply
    if (totalTokens > planMetadata.remaining) {
      throw new Error(
        `Insufficient supply: trying to mint ${totalTokens} tokens ` +
        `but only ${planMetadata.remaining} remaining`
      );
    }

    // ----------------------------------------------------------------------------
    // Step 7: Construct SpellRequest
    // ----------------------------------------------------------------------------
    const request: SpellRequest = {
      type: 'mint-token',
      authorityUtxo,
      fundingUtxo: funding.utxoId,
      fundingUtxoValue: funding.value,
      changeAddress: treasuryAddress, // Change returns to treasury
      feeRate: constants.DEFAULT_FEE_RATE,
      outputs: [
        ...workerOutputs,
        {
          address: employerAddress,
          nftMetadata: {
            ...planMetadata,
            remaining: planMetadata.remaining - totalTokens
          },
          sats: constants.MIN_OUTPUT_SATS
        }
      ]
    };

    console.log(`[HIRING API:${requestId}] SpellRequest built:`, {
      authority: request.authorityUtxo,
      funding: request.fundingUtxo,
      workerCount: workerOutputs.length,
      totalTokens,
      newRemaining: planMetadata.remaining - totalTokens
    });

    // ----------------------------------------------------------------------------
    // Step 8: Generate unsigned transactions
    // ----------------------------------------------------------------------------
    console.log(`[HIRING API:${requestId}] Calling proverClient...`);

    // FIX: Explicitly use ProverResult to type the 'result' variable
    // Ensure appId is passed for v12 migration [4]
    const result: ProverResult = await generateUnsignedTransactions(
      request, 
      [
        authorityTxHex,
        funding.hex
      ],
      planMetadata.appId // Pass appId for v12 compatibility
    );

    console.log(`[HIRING API:${requestId}] ✅ Transactions generated`);

    // ----------------------------------------------------------------------------
    // Step 9: Return success response with fee information
    // ----------------------------------------------------------------------------
    // The spread operator (...result) now correctly spreads a typed ProverResult
    const response = {
      ...result,
      fundingUsed: funding.utxoId,
      fundingValue: funding.value,
      workerCount: workers.length,
      totalTokens,
      scrollFee,
      sponsored: true
    };

    console.log(`[HIRING API:${requestId}] ===== SUCCESS =====\n`);
    
    return res.status(200).json(response);

  } catch (error: any) {
    console.error(`\n[HIRING API:${requestId}] ❌ ERROR =====`);
    console.error(error.message);
    console.error(error.stack);
    console.error(`[HIRING API:${requestId}] ===== END =====\n`);
    
    const statusCode = error.message.includes('Missing') ? 400 : 500;
    
    return res.status(statusCode).json({
      error: error.message,
      requestId
    });
  }
}