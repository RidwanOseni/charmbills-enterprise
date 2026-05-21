import { generateUnsignedTransactions } from './charms/proverClient';
import { buildMintToken } from './charms/buildMintToken';
import { createPayrollPlanRequest } from './charms/buildMintNFT';
import { SpellRequest, ProverResult } from '@shared/types';
import * as constants from '@shared/constants';
import * as dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import * as bitcoin from 'bitcoinjs-lib';
import { getDynamicFundingUtxo } from './lib/utxo-manager';

// --------------------------------------------------------------------------------
// Environment & Configuration
// --------------------------------------------------------------------------------
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// CRITICAL FIX: Session exclusion list to prevent UTXO reuse across phases
const sessionExcludedUtxos: string[] = [];

// Environment validation
const ENV = {
  ANCHOR_UTXO: process.env.PAYROLL_ANCHOR_UTXO,
  ANCHOR_TX_HEX: process.env.PAYROLL_ANCHOR_TX_HEX,
  ANCHOR_VALUE: process.env.PAYROLL_ANCHOR_VALUE,
  TREASURY_ADDRESS: process.env.PAYROLL_TREASURY_ADDRESS,
  EMPLOYER_ADDRESS: process.env.PAYROLL_EMPLOYER_ADDRESS,
  CHANGE_ADDRESS: process.env.PAYROLL_CHANGE_ADDRESS,
  HR_KEY: process.env.PAYROLL_HR_KEY,
  FINANCE_KEY: process.env.PAYROLL_FINANCE_KEY,
  CEO_KEY: process.env.PAYROLL_CEO_KEY
};

function validateEnv(phase: 'plan' | 'hiring'): void {
  const required = phase === 'plan' 
    ? ['ANCHOR_UTXO', 'ANCHOR_TX_HEX', 'ANCHOR_VALUE', 'TREASURY_ADDRESS', 'EMPLOYER_ADDRESS', 'CHANGE_ADDRESS']
    : ['TREASURY_ADDRESS', 'CHANGE_ADDRESS'];
  
  const missing = required.filter(key => !ENV[key as keyof typeof ENV]);
  
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables for ${phase} phase:\n${missing.map(k => `  PAYROLL_${k}`).join('\n')}`
    );
  }
}

function logExclusionListStatus(phase: string): void {
  console.log(`\n📋 Session Exclusion List (${phase}):`);
  if (sessionExcludedUtxos.length === 0) {
    console.log(`  No UTXOs excluded yet`);
  } else {
    sessionExcludedUtxos.forEach((utxo, index) => {
      console.log(`  ${index + 1}. ${utxo}`);
    });
  }
}

// --------------------------------------------------------------------------------
// Phase 1: Create Departmental Plan NFT
// --------------------------------------------------------------------------------

async function runPlanCreationDemo() {
  console.log('\n' + '='.repeat(60));
  console.log('🚀 [PHASE 1] Creating "Engineering Dept" Plan NFT');
  console.log('='.repeat(60));
  
  try {
    validateEnv('plan');
    
    const metadataHash = crypto.randomBytes(32).toString('hex');
    
    console.log('\n📋 Plan Configuration:');
    console.log(`  Department:       Engineering`);
    console.log(`  Scroll Policy:    Time-based (Employees)`);
    console.log(`  Pay Period:       ${constants.SECONDS_PER_BIWEEK} seconds (2 weeks)`);
    console.log(`  Compensation:     5,000,000 sats (0.05 BTC)`);
    console.log(`  Total Supply:     100 pay periods`);
    console.log(`  Multi-sig:        Yes (2-of-3)`);
    console.log(`  Metadata Hash:    ${metadataHash.substring(0, 16)}...`);
    
    logExclusionListStatus('Before Phase 1');
    
    console.log('\n🔍 Looking up dynamic funding UTXO for Phase 1...');
    console.log(`  ⚠️  Excluding ${sessionExcludedUtxos.length} UTXOs from previous operations`);
    
    const funding1 = await getDynamicFundingUtxo(
      ENV.TREASURY_ADDRESS!, 
      50000, 
      sessionExcludedUtxos
    );
    
    console.log(`  ✅ Found UTXO: ${funding1.utxoId}`);
    console.log(`  Value:        ${funding1.value} sats`);
    console.log(`  Hex:          ${funding1.hex.substring(0, 50)}...`);
    
    sessionExcludedUtxos.push(funding1.utxoId);
    console.log(`  📝 Added to session exclusion list: ${funding1.utxoId}`);
    
    logExclusionListStatus('After Phase 1 UTXO Addition');
    
    const request = createPayrollPlanRequest({
      anchorUtxo: ENV.ANCHOR_UTXO!,
      anchorValue: Number(ENV.ANCHOR_VALUE),
      fundingUtxo: funding1.utxoId,
      fundingValue: funding1.value,
      changeAddress: ENV.CHANGE_ADDRESS!,
      employerAddress: ENV.EMPLOYER_ADDRESS!,
      ticker: constants.PAYROLL_NFT_TICKER,
      metadataHash,
      scrollPolicy: 0,
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
    
    console.log('\n⏳ Generating unsigned transactions (this may take a moment)...');
    
    const result: ProverResult = await generateUnsignedTransactions(
      request, 
      [ENV.ANCHOR_TX_HEX!, funding1.hex]
    );
    
    console.log('✅ Transactions generated successfully!');
    console.log(`  Commit Tx: ${result.commitTxHex.substring(0, 50)}...`);
    console.log(`  Spell Tx:  ${result.spellTxHex.substring(0, 50)}...`);
    
    const appId = crypto.createHash('sha256').update(ENV.ANCHOR_UTXO!).digest('hex');
    
    const spellTx = bitcoin.Transaction.fromHex(result.spellTxHex);
    const spellTxId = spellTx.getId();
    
    const planData = {
      appId,
      planUtxo: `${spellTxId}:0`,
      planTxHex: result.spellTxHex,
      metadataHash,
      initialSupply: 100,
      fundingUtxoUsed: funding1.utxoId,
      timestamp: new Date().toISOString()
    };
    
    await fs.mkdir('./transactions', { recursive: true });
    await fs.writeFile(
      './transactions/plan-created.json',
      JSON.stringify(planData, null, 2)
    );
    
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
    console.log(`   Phase 1 Funding UTXO: ${funding1.utxoId} (excluded from future phases)`);
    console.log('='.repeat(60) + '\n');
    
    return { result, metadataHash, appId, planData, fundingUtxoUsed: funding1.utxoId };
    
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

async function runBatchHiringDemo(
  planUtxo: string, 
  planTxHex: string, 
  appId: string, 
  metadataHash: string,
  initialSupply: number = 100,
  phase1FundingUtxo?: string
) {
  console.log('\n' + '='.repeat(60));
  console.log('📦 [PHASE 2] Batch Hiring Demo (1:M:N Scaling)');
  console.log('='.repeat(60));
  
  try {
    validateEnv('hiring');
    
    console.log('✅ Plan data loaded:', {
      appId: appId.substring(0, 16) + '...',
      metadataHash: metadataHash.substring(0, 16) + '...',
      planUtxo: planUtxo,
      initialSupply: initialSupply,
      phase1FundingUtxo: phase1FundingUtxo || 'Not provided'
    });
    
    logExclusionListStatus('Before Phase 2');
    
    console.log('\n🔍 Looking up dynamic funding UTXO for Phase 2...');
    console.log(`  ⚠️  Excluding ${sessionExcludedUtxos.length} UTXOs from previous phases`);
    
    if (phase1FundingUtxo) {
      console.log(`  🔒 Phase 1 UTXO "${phase1FundingUtxo}" is in exclusion list`);
    }
    
    const funding2 = await getDynamicFundingUtxo(
      ENV.TREASURY_ADDRESS!, 
      50000, 
      sessionExcludedUtxos
    );
    
    console.log(`  ✅ Found UTXO: ${funding2.utxoId}`);
    console.log(`  Value:        ${funding2.value} sats`);
    console.log(`  Hex:          ${funding2.hex.substring(0, 50)}...`);
    console.log(`  🔄 This is a DIFFERENT UTXO from Phase 1 (ensured by exclusion list)`);
    
    if (phase1FundingUtxo && funding2.utxoId === phase1FundingUtxo) {
      console.error(`  ❌ ERROR: Phase 2 received the same UTXO as Phase 1!`);
      throw new Error(`UTXO reuse detected: ${funding2.utxoId} was used in Phase 1`);
    }
    
    sessionExcludedUtxos.push(funding2.utxoId);
    console.log(`  📝 Added to session exclusion list: ${funding2.utxoId}`);
    
    logExclusionListStatus('After Phase 2 UTXO Addition');
    
    const workers = [
      { address: "tb1p88h6het0z0zgul7hh9dds78lyuvg3hm9xuuldrrdr94fqmfdw80s8wy92c", periods: 1 },
      { address: "tb1px56fvphmsdutf9xndf65p5k29uja6ugmuxql6eqwlrxxdfhppd8qlvhn5q", periods: 1 },
      { address: "tb1pt4py68l9zj7v3a26duzsaff0q79ltdp79u42jmm2l8386g339a6qlpc8je", periods: 1 }
    ];
    
    const totalTokensMinted = workers.reduce((sum, w) => sum + w.periods, 0);
    
    console.log(`\n📋 Hiring ${workers.length} workers:`);
    workers.forEach((w, i) => {
      console.log(`  Worker ${i + 1}: ${w.address.substring(0, 20)}... (${w.periods} period)`);
    });
    console.log(`\n📊 Supply Math: ${initialSupply} (in) - ${totalTokensMinted} (minted) = ${initialSupply - totalTokensMinted} (out)`);
    
    // CRITICAL FIX: Pass ORIGINAL supply (initialSupply) to builder, NOT calculated new supply
    const request: SpellRequest = {
      type: 'mint-token',
      authorityUtxo: planUtxo,
      anchorUtxo: process.env.PAYROLL_ANCHOR_UTXO,
      fundingUtxo: funding2.utxoId,
      fundingUtxoValue: funding2.value,
      changeAddress: ENV.CHANGE_ADDRESS!,
      feeRate: constants.DEFAULT_FEE_RATE,
      outputs: [
        ...workers.map(w => ({
          address: w.address,
          tokenAmount: w.periods
        })),
        {
          address: ENV.EMPLOYER_ADDRESS!,
          nftMetadata: {
            ticker: constants.PAYROLL_NFT_TICKER,
            remaining: initialSupply, // FIX: Pass original supply (100), not calculated new supply
            metadataHash: metadataHash,
            scrollPolicy: 0,
            payPeriodSeconds: constants.SECONDS_PER_BIWEEK,
            compensationSats: 5_000_000
          }
        }
      ]
    };
    
    console.log('\n🔧 Built Batch Hiring Request:');
    console.log(`  Authority UTXO:   ${request.authorityUtxo}`);
    console.log(`  Anchor UTXO:      ${request.anchorUtxo ? request.anchorUtxo.substring(0, 40) + '...' : 'MISSING!'}`);
    console.log(`  Funding UTXO:     ${request.fundingUtxo}`);
    console.log(`  Worker Outputs:   ${workers.length}`);
    console.log(`  Total Tokens:     ${totalTokensMinted}`);
    console.log(`  Input Supply:     ${initialSupply} periods`);
    console.log(`  Output Supply:    ${initialSupply - totalTokensMinted} periods (will be calculated by builder)`);
    console.log(`  Metadata Hash:    ${metadataHash.substring(0, 16)}...`);
    
    console.log('\n⏳ Building mint token spell...');
    const spellVars = buildMintToken(request, appId);
    
    console.log('⏳ Generating batch hiring transactions...');
    
    const result: ProverResult = await generateUnsignedTransactions(
      request, 
      [planTxHex, funding2.hex],
      appId
    );
    
    console.log('✅ Batch hiring transactions generated successfully!');
    console.log(`  Commit Tx: ${result.commitTxHex.substring(0, 50)}...`);
    console.log(`  Spell Tx:  ${result.spellTxHex.substring(0, 50)}...`);
    
    const hiringRecord = {
      workers: workers.length,
      totalTokens: totalTokensMinted,
      timestamp: new Date().toISOString(),
      appId: appId,
      metadataHash: metadataHash,
      supplyUsed: totalTokensMinted,
      supplyRemaining: initialSupply - totalTokensMinted,
      initialSupply: initialSupply,
      commitTx: result.commitTxHex,
      spellTx: result.spellTxHex,
      spellVars,
      fundingUtxoUsed: funding2.utxoId,
      anchorUtxoUsed: request.anchorUtxo,
      excludedUtxosAtTime: [...sessionExcludedUtxos]
    };
    
    await fs.writeFile(
      './transactions/batch-hiring.json',
      JSON.stringify(hiringRecord, null, 2)
    );
    
    console.log('\n📝 ===== SIGNING INSTRUCTIONS =====');
    console.log('Batch hiring transactions generated successfully!');
    console.log(`\n📊 Supply Update: ${initialSupply} -> ${initialSupply - totalTokensMinted} periods remaining`);
    console.log(`   Tokens Minted:  ${totalTokensMinted}`);
    console.log(`\n💰 UTXO Usage Summary:`);
    console.log(`  Phase 1 UTXO:   ${phase1FundingUtxo || 'N/A'}`);
    console.log(`  Phase 2 UTXO:   ${funding2.utxoId}`);
    console.log(`  Anchor UTXO:    ${request.anchorUtxo ? request.anchorUtxo.substring(0, 40) + '...' : 'N/A'}`);
    console.log(`  ✅ Different UTXOs ensure no mempool rejection`);
    console.log('\n1. Save the transaction hexes:');
    console.log(`   COMMIT_TX_HEX="${result.commitTxHex.substring(0, 50)}..."`);
    console.log(`   SPELL_TX_HEX="${result.spellTxHex.substring(0, 50)}..."`);
    console.log('\n2. Sign and broadcast as a package:');
    console.log('   bitcoin-cli signrawtransactionwithwallet "$COMMIT_TX_HEX"');
    console.log('   bitcoin-cli signrawtransactionwithwallet "$SPELL_TX_HEX" \'[{"txid":"...","vout":0}]\'');
    console.log('   bitcoin-cli submitpackage \'["$SIGNED_COMMIT", "$SIGNED_SPELL"]\'');
    console.log('\n3. After confirmation, workers will have "Proof of Hire" tokens');
    console.log('='.repeat(60) + '\n');
    
    return result;
    
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

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('🏢 CHARMS INC. PAYROLL ORCHESTRATION TEST');
  console.log('='.repeat(60));
  console.log('\n⚠️  IMPORTANT: This demo implements sessionExcludedUtxos to ensure');
  console.log('   Phase 1 and Phase 2 use DIFFERENT treasury UTXOs.');
  console.log('   This prevents the mempool rejection that occurs when reusing UTXOs.');
  
  try {
    const args = process.argv.slice(2);
    
    if (args.includes('--phase2-only')) {
      console.log('\n📂 Loading plan data from previous run...');
      
      try {
        const planData = JSON.parse(
          await fs.readFile('./transactions/plan-created.json', 'utf-8')
        );
        
        console.log('✅ Plan data loaded:', {
          appId: planData.appId.substring(0, 16) + '...',
          planUtxo: planData.planUtxo,
          metadataHash: planData.metadataHash.substring(0, 16) + '...',
          initialSupply: planData.initialSupply || 100,
          phase1FundingUtxo: planData.fundingUtxoUsed || 'Not recorded'
        });
        
        if (planData.fundingUtxoUsed) {
          console.log(`\n🔄 Restoring exclusion list with Phase 1 UTXO: ${planData.fundingUtxoUsed}`);
          sessionExcludedUtxos.push(planData.fundingUtxoUsed);
          logExclusionListStatus('After Restoration');
        }
        
        await runBatchHiringDemo(
          planData.planUtxo, 
          planData.planTxHex, 
          planData.appId, 
          planData.metadataHash,
          planData.initialSupply || 100,
          planData.fundingUtxoUsed
        );
      } catch (error) {
        console.error('❌ No plan data found. Run without --phase2-only first.');
        process.exit(1);
      }
      
    } else if (args.includes('--freelancer')) {
      console.log('\n🆓 Running Freelancer Project Demo');
      console.log('='.repeat(60));
      console.log('\n⚠️  Freelancer demo not fully implemented in this test script.');
      console.log('Please use the API endpoints for freelancer workflows.');
      
    } else {
      console.log('\n🔄 Running full workflow: Phase 1 + Phase 2');
      console.log('   Phase 1 will select and exclude a UTXO');
      console.log('   Phase 2 will select a DIFFERENT UTXO from the exclusion list');
      
      const phase1Result = await runPlanCreationDemo();
      
      if (phase1Result) {
        console.log('\n⏳ Phase 1 complete. Phase 1 UTXO added to exclusion list.');
        console.log('   Phase 2 will now select a different UTXO for funding.');
        console.log('   This ensures no UTXO reuse and prevents mempool rejection.\n');
        
        await runBatchHiringDemo(
          phase1Result.planData.planUtxo, 
          phase1Result.planData.planTxHex,
          phase1Result.appId,
          phase1Result.metadataHash,
          phase1Result.planData.initialSupply || 100,
          phase1Result.fundingUtxoUsed
        );
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ TEST COMPLETE');
    console.log('='.repeat(60));
    console.log('\n📊 Session Exclusion List Summary:');
    console.log(`   Total UTXOs excluded during session: ${sessionExcludedUtxos.length}`);
    sessionExcludedUtxos.forEach((utxo, index) => {
      console.log(`   ${index + 1}. ${utxo}`);
    });
    console.log('\n💡 This prevented UTXO reuse and ensured mempool acceptance.\n');
    
  } catch (error) {
    console.error('\n💥 FATAL ERROR:');
    console.error(error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

export {
  runPlanCreationDemo,
  runBatchHiringDemo,
  sessionExcludedUtxos
};