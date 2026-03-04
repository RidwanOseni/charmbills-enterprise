import { generateUnsignedTransactions } from './charms/proverClient';
import { buildMintToken } from './charms/buildMintToken';
import { createPayrollPlanRequest } from './charms/buildMintNFT';
import { SpellRequest, ProverResult } from '../../shared/types';
import * as constants from '../../shared/constants';
import * as dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import * as bitcoin from 'bitcoinjs-lib';
import { getDynamicFundingUtxo } from './lib/utxo-manager';

// --------------------------------------------------------------------------------
// Environment & Configuration
// --------------------------------------------------------------------------------
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// FIX: Session exclusion list to prevent UTXO reuse across phases
const sessionExcludedUtxos: string[] = [];

sessionExcludedUtxos.push('6e03b829c71f79a30fed24732418959f3b9ef617546933c5e7ef2f41fe881588:1');

// Environment validation
const ENV = {
  ANCHOR_UTXO: process.env.PAYROLL_ANCHOR_UTXO,
  ANCHOR_TX_HEX: process.env.PAYROLL_ANCHOR_TX_HEX,
  ANCHOR_VALUE: process.env.PAYROLL_ANCHOR_VALUE,
  TREASURY_ADDRESS: process.env.PAYROLL_TREASURY_ADDRESS,
  TREASURY_TX_HEX: process.env.PAYROLL_TREASURY_TX_HEX,
  EMPLOYER_ADDRESS: process.env.PAYROLL_EMPLOYER_ADDRESS,
  CHANGE_ADDRESS: process.env.PAYROLL_CHANGE_ADDRESS,
  HR_KEY: process.env.PAYROLL_HR_KEY,
  FINANCE_KEY: process.env.PAYROLL_FINANCE_KEY,
  CEO_KEY: process.env.PAYROLL_CEO_KEY
};

function validateEnv(phase: 'plan' | 'hiring'): void {
  const required = phase === 'plan' 
    ? ['ANCHOR_UTXO', 'ANCHOR_TX_HEX', 'ANCHOR_VALUE', 'TREASURY_ADDRESS', 'EMPLOYER_ADDRESS', 'CHANGE_ADDRESS']
    : ['TREASURY_ADDRESS', 'TREASURY_TX_HEX', 'CHANGE_ADDRESS']; 
  
  const missing = required.filter(key => !ENV[key as keyof typeof ENV]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for ${phase} phase:\n${missing.map(k => `  PAYROLL_${k}`).join('\n')}`
    );
  }
}

// --------------------------------------------------------------------------------
// Phase 1: Create Departmental Plan NFT
// --------------------------------------------------------------------------------

/**
 * PHASE 1: Creates the Departmental Plan NFT (Authority Object).
 * This establishes the 'Rules of Engagement' for payroll.
 */
async function runPlanCreationDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 [PHASE 1] Creating "Engineering Dept" Plan NFT');
  console.log('='.repeat(60));
  
  try {
    // Step 1: Validate environment
    validateEnv('plan');
    
    // Step 2: Generate mock metadata hash (in production, this would be from IPFS)
    const metadataHash = crypto.randomBytes(32).toString('hex');
    
    console.log('\n📋 Plan Configuration:');
    console.log(`  Department:       Engineering`);
    console.log(`  Scroll Policy:    Time-based (Employees)`);
    console.log(`  Pay Period:       ${constants.SECONDS_PER_BIWEEK} seconds (2 weeks)`);
    console.log(`  Compensation:     5,000,000 sats (0.05 BTC)`);
    console.log(`  Total Supply:     100 pay periods`);
    console.log(`  Multi-sig:        Yes (2-of-3)`);
    console.log(`  Metadata Hash:    ${metadataHash.substring(0, 16)}...`);
    
    // FIX: Dynamically find a fresh UTXO for the treasury address with session exclusion
    console.log('\n🔍 Looking up dynamic funding UTXO...');
    const funding1 = await getDynamicFundingUtxo(ENV.TREASURY_ADDRESS!, 50000, sessionExcludedUtxos);
    console.log(`  ✅ Found UTXO: ${funding1.utxoId}`);
    console.log(`  Value:        ${funding1.value} sats`);
    console.log(`  Hex:          ${funding1.hex.substring(0, 50)}...`);
    
    // FIX: Mark this UTXO as used for the session
    sessionExcludedUtxos.push(funding1.utxoId);
    console.log(`  📝 Added to session exclusion list: ${funding1.utxoId}`);
    
    // Step 3: Build spell request with dynamic funding
    const request = createPayrollPlanRequest({
      anchorUtxo: ENV.ANCHOR_UTXO!,
      anchorValue: Number(ENV.ANCHOR_VALUE),
      fundingUtxo: funding1.utxoId,
      fundingValue: funding1.value,
      changeAddress: ENV.CHANGE_ADDRESS!,
      employerAddress: ENV.EMPLOYER_ADDRESS!,
      ticker: constants.PAYROLL_NFT_TICKER,
      metadataHash,
      scrollPolicy: 0, // 0 = Time-based for employees
      payPeriodSeconds: constants.SECONDS_PER_BIWEEK,
      compensationSats: 5_000_000,
      remaining: 100,
      multiSigSigners: [ENV.HR_KEY, ENV.FINANCE_KEY, ENV.CEO_KEY].filter(k => !!k) as string[],
      multiSigThreshold: 2
    });
    
    console.log('\n🔧 Built Spell Request:');
    console.log(`  Type:             ${request.type}`);
    console.log(`  Anchor UTXO:      ${request.anchorUtxo}`);
    console.log(`  Funding UTXO:     ${request.fundingUtxo}`);
    console.log(`  Employer Address: ${request.outputs[0].address.substring(0, 20)}...`);
    console.log(`  Initial Supply:   100 periods`);
    
    // Step 4: Generate unsigned transactions
    console.log('\n⏳ Generating unsigned transactions (this may take a moment)...');
    
    const result = await generateUnsignedTransactions(request, [ENV.ANCHOR_TX_HEX!, funding1.hex]);
    
    console.log('✅ Transactions generated successfully!');
    console.log(`  Commit Tx: ${result.commitTxHex.substring(0, 50)}...`);
    console.log(`  Spell Tx:  ${result.spellTxHex.substring(0, 50)}...`);
    
    // Step 5: Derive App ID from anchor UTXO
    const appId = crypto.createHash('sha256').update(ENV.ANCHOR_UTXO!).digest('hex');
    
    // FIX: Derive actual transaction ID from spellTxHex
    const spellTx = bitcoin.Transaction.fromHex(result.spellTxHex);
    const spellTxId = spellTx.getId();
    
    // Step 6: Save for next phase with correct UTXO
    const planData = {
      appId,
      planUtxo: `${spellTxId}:0`,
      planTxHex: result.spellTxHex,
      metadataHash,
      initialSupply: 100,
      timestamp: new Date().toISOString()
    };
    
    await fs.mkdir('./transactions', { recursive: true });
    await fs.writeFile(
      './transactions/plan-created.json',
      JSON.stringify(planData, null, 2)
    );
    
    // Step 7: Log signing instructions
    console.log('\n🔐 ===== 2-OF-3 MULTI-SIG TREASURY REQUIRED =====');
    console.log('This payroll plan requires approval from:');
    console.log('  • HR Department');
    console.log('  • Finance Department');
    console.log('  • CEO');
    console.log('\nSigning sequence:');
    console.log('1. Save the transaction hexes:');
    console.log(`   COMMIT_HEX="${result.commitTxHex.substring(0, 50)}..."`);
    console.log(`   SPELL_HEX="${result.spellTxHex.substring(0, 50)}..."`);
    console.log('\n2. Each signer must sign independently:');
    console.log('   HR:      bitcoin-cli signrawtransactionwithwallet "$COMMIT_HEX"');
    console.log('   Finance: bitcoin-cli signrawtransactionwithwallet "$COMMIT_HEX"');
    console.log('   CEO:     bitcoin-cli signrawtransactionwithwallet "$COMMIT_HEX"');
    console.log('\n3. Combine signatures and broadcast package:');
    console.log('   bitcoin-cli submitpackage \'["$SIGNED_COMMIT", "$SIGNED_SPELL"]\'');
    console.log('\n4. After confirmation, the Plan NFT will be active with App ID:');
    console.log(`   ${appId}`);
    console.log(`   NFT UTXO:         ${spellTxId}:0`);
    console.log(`   Initial Supply:   100 periods`);
    console.log('='.repeat(60) + '\n');
    
    return planData;
    
  } catch (error: any) {
    console.error('\n❌ Phase 1 Failed:');
    console.error(error.message);
    if (error.stack) console.error(error.stack);
    return null;
  }
}

// --------------------------------------------------------------------------------
// Phase 2: Batch Hiring (1:M:N Scaling)
// --------------------------------------------------------------------------------

/**
 * PHASE 2: Performs a Batch Hiring Run (1:M:N Scaling).
 * Mints 'Proof of Hire' tokens for multiple workers in a single transaction.
 * 
 * @param planUtxo - The Plan NFT UTXO (from Phase 1)
 * @param planTxHex - The Plan NFT transaction hex (for provenance)
 */
async function runBatchHiringDemo(planUtxo: string, planTxHex: string) {
  console.log('\n' + '='.repeat(60));
  console.log('📦 [PHASE 2] Batch Hiring Demo (1:M:N Scaling)');
  console.log('='.repeat(60));
  
  try {
    // Step 1: Validate environment
    validateEnv('hiring');
    
    // Step 2: Load plan data from Phase 1
    console.log('\n📂 Loading plan data from Phase 1...');
    const planData = JSON.parse(
      await fs.readFile('./transactions/plan-created.json', 'utf-8')
    );
    
    console.log('✅ Plan data loaded:', {
      appId: planData.appId.substring(0, 16) + '...',
      metadataHash: planData.metadataHash.substring(0, 16) + '...',
      planUtxo: planData.planUtxo,
      initialSupply: planData.initialSupply || 100
    });
    
    // FIX: Dynamically find a DIFFERENT UTXO for the treasury address using session exclusion
    console.log('\n🔍 Looking up dynamic funding UTXO (excluding previously used)...');
    const funding2 = await getDynamicFundingUtxo(ENV.TREASURY_ADDRESS!, 50000, sessionExcludedUtxos);
    console.log(`  ✅ Found UTXO: ${funding2.utxoId}`);
    console.log(`  Value:        ${funding2.value} sats`);
    console.log(`  Hex:          ${funding2.hex.substring(0, 50)}...`);
    console.log(`  🔄 This is automatically different from Phase 1 UTXO due to exclusion list`);
    
    // Step 3: Define workers (mock data - in production, these come from HR)
    const workers = [
      { address: "tb1p88h6het0z0zgul7hh9dds78lyuvg3hm9xuuldrrdr94fqmfdw80s8wy92c", periods: 1 },
      { address: "tb1px56fvphmsdutf9xndf65p5k29uja6ugmuxql6eqwlrxxdfhppd8qlvhn5q", periods: 1 },
      { address: "tb1pt4py68l9zj7v3a26duzsaff0q79ltdp79u42jmm2l8386g339a6qlpc8je", periods: 1 }
    ];
    
    console.log(`\n📋 Hiring ${workers.length} workers:`);
    workers.forEach((w, i) => {
      console.log(`  Worker ${i + 1}: ${w.address.substring(0, 20)}... (${w.periods} period)`);
    });
    
    // Step 4: Build batch hiring request with dynamic funding
    const request: SpellRequest = {
      type: 'mint-token',
      authorityUtxo: planUtxo,
      fundingUtxo: funding2.utxoId,
      fundingUtxoValue: funding2.value,
      changeAddress: ENV.CHANGE_ADDRESS!,
      feeRate: constants.DEFAULT_FEE_RATE,
      outputs: [
        // Worker outputs (each gets a token)
        ...workers.map(w => ({
          address: w.address,
          tokenAmount: w.periods
        })),
        // NFT return to employer
        {
          address: ENV.EMPLOYER_ADDRESS!,
          nftMetadata: {
            ticker: constants.PAYROLL_NFT_TICKER,
            remaining: 100,
            metadataHash: planData.metadataHash,
            scrollPolicy: 0,
            payPeriodSeconds: constants.SECONDS_PER_BIWEEK,
            compensationSats: 5_000_000
          }
        }
      ]
    };
    
    console.log('\n🔧 Built Batch Hiring Request:');
    console.log(`  Authority UTXO:   ${request.authorityUtxo}`);
    console.log(`  Funding UTXO:     ${request.fundingUtxo}`);
    console.log(`  Worker Outputs:   ${workers.length}`);
    console.log(`  Total Tokens:     ${workers.length}`);
    console.log(`  Current Supply:   100 periods`);
    console.log(`  New Remaining:    ${100 - workers.length} periods`);
    console.log(`  Metadata Hash:    ${planData.metadataHash.substring(0, 16)}...`);
    
    // Step 5: Generate spell JSON using buildMintToken
    console.log('\n⏳ Building mint token spell...');
    const spellJson = buildMintToken(request, planData.appId);
    
    // Step 6: Generate unsigned transactions - Pass funding hex for ownership proof
    console.log('⏳ Generating batch hiring transactions...');
    
    // For token minting, we need both the authority tx hex and funding tx hex
    const result = await generateUnsignedTransactions(
      request, 
      [planTxHex, funding2.hex],
      planData.appId
    );
    
    console.log('✅ Batch hiring transactions generated successfully!');
    console.log(`  Commit Tx: ${result.commitTxHex.substring(0, 50)}...`);
    console.log(`  Spell Tx:  ${result.spellTxHex.substring(0, 50)}...`);
    
    // Step 7: Save record
    const hiringRecord = {
      workers: workers.length,
      totalTokens: workers.length,
      timestamp: new Date().toISOString(),
      appId: planData.appId,
      metadataHash: planData.metadataHash,
      supplyUsed: workers.length,
      supplyRemaining: 100 - workers.length,
      commitTx: result.commitTxHex,
      spellTx: result.spellTxHex,
      spellJson,
      fundingUtxoUsed: funding2.utxoId
    };
    
    await fs.writeFile(
      './transactions/batch-hiring.json',
      JSON.stringify(hiringRecord, null, 2)
    );
    
    // Step 8: Log signing instructions
    console.log('\n📝 ===== SIGNING INSTRUCTIONS =====');
    console.log('Batch hiring transactions generated successfully!');
    console.log(`\n📊 Supply Update: ${100 - workers.length} periods remaining`);
    console.log('\n1. Save the transaction hexes:');
    console.log(`   COMMIT_TX_HEX="${result.commitTxHex.substring(0, 50)}..."`);
    console.log(`   SPELL_TX_HEX="${result.spellTxHex.substring(0, 50)}..."`);
    console.log('\n2. Sign and broadcast as a package:');
    console.log('   bitcoin-cli signrawtransactionwithwallet "$COMMIT_TX_HEX"');
    console.log('   bitcoin-cli signrawtransactionwithwallet "$SPELL_TX_HEX" \'[{"txid":"...","vout":0}]\'');
    console.log('   bitcoin-cli submitpackage \'["$SIGNED_COMMIT", "$SIGNED_SPELL"]\'');
    console.log('\n3. After confirmation, workers will have "Proof of Hire" tokens');
    console.log('='.repeat(60) + '\n');
    
    return hiringRecord;
    
  } catch (error: any) {
    console.error('\n❌ Phase 2 Failed:');
    console.error(error.message);
    if (error.stack) console.error(error.stack);
    return null;
  }
}

// --------------------------------------------------------------------------------
// Main Runner
// --------------------------------------------------------------------------------

/**
 * Main execution function
 */
async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🏢 CHARMS INC. PAYROLL ORCHESTRATION TEST');
  console.log('='.repeat(60));
  
  try {
    // ----------------------------------------------------------------------------
    // Step 1: Check command line arguments
    // ----------------------------------------------------------------------------
    const args = process.argv.slice(2);
    
    if (args.includes('--phase2-only')) {
      // Run only Phase 2 (requires existing plan data)
      console.log('\n📂 Loading plan data from previous run...');
      
      try {
        const planData = JSON.parse(
          await fs.readFile('./transactions/plan-created.json', 'utf-8')
        );
        
        console.log('✅ Plan data loaded:', {
          appId: planData.appId.substring(0, 16) + '...',
          planUtxo: planData.planUtxo,
          metadataHash: planData.metadataHash.substring(0, 16) + '...',
          initialSupply: planData.initialSupply || 100
        });
        
        await runBatchHiringDemo(planData.planUtxo, planData.planTxHex);
      } catch (error) {
        console.error('❌ No plan data found. Run without --phase2-only first.');
        process.exit(1);
      }
      
    } else if (args.includes('--freelancer')) {
      // Run freelancer demo (proof-based)
      console.log('\n🆓 Running Freelancer Project Demo');
      console.log('='.repeat(60));
      
      console.log('\n⚠️  Freelancer demo not fully implemented in this test script.');
      console.log('Please use the API endpoints for freelancer workflows.');
      
    } else {
      // Default: Run both phases
      console.log('\n🔄 Running full workflow: Phase 1 + Phase 2');
      
      const planData = await runPlanCreationDemo();
      
      if (planData) {
        console.log('\n⏳ Waiting for Phase 1 confirmation...');
        console.log('(In a real environment, wait for the transaction to be mined)');
        console.log('Press Ctrl+C to simulate confirmation, then run with --phase2-only\n');
        
        // Simulate waiting for user input
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // For demo purposes, we'll run Phase 2 immediately
        // In production, you'd wait for confirmation
        await runBatchHiringDemo(planData.planUtxo, planData.planTxHex);
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST COMPLETE');
    console.log('='.repeat(60) + '\n');
    
  } catch (error) {
    console.error('\n💥 FATAL ERROR:');
    console.error(error);
    process.exit(1);
  }
}

// --------------------------------------------------------------------------------
// Execute
// --------------------------------------------------------------------------------
if (require.main === module) {
  main().catch(console.error);
}

// --------------------------------------------------------------------------------
// Exports
// --------------------------------------------------------------------------------
export {
  runPlanCreationDemo,
  runBatchHiringDemo
};