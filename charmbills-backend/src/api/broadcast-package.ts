import { Request, Response } from 'express';
import axios from 'axios';
import * as constants from '@shared/constants';
import { saveAuditLog } from '../db/schema';
import * as crypto from 'crypto';

// --------------------------------------------------------------------------------
// Configuration for local Bitcoin node (Testnet4)
// --------------------------------------------------------------------------------
const RPC_USER = process.env.RPC_USER;
const RPC_PASSWORD = process.env.RPC_PASSWORD;
const RPC_HOST = process.env.RPC_HOST || constants.DEFAULT_RPC_HOST || '127.0.0.1';
const RPC_PORT = process.env.RPC_PORT || constants.DEFAULT_RPC_PORT || '48332';
const RPC_URL = `http://${RPC_HOST}:${RPC_PORT}`;

const auth = { username: RPC_USER || '', password: RPC_PASSWORD || '' };
const headers = { 'Content-Type': 'text/plain' };

// Helper to get database from app locals
function getDb(req: Request): any {
    return req.app.locals.db;
}

// --------------------------------------------------------------------------------
// Broadcast Package - Main Handler
// --------------------------------------------------------------------------------

/**
 * Broadcasts signed transactions as a package using submitpackage.
 * Mandatory for v0.12 because the Spell depends on the Commit.
 * 
 * The frontend sends an array: [signedCommitHex, signedSpellHex] OR [signedCombinedHex] for v0.12.
 * 
 * PRODUCTION IMPLEMENTATION:
 * 1. Uses submitpackage RPC method for atomic broadcast (Protocol v0.12) [3]
 * 2. Uses sendrawtransaction for single transactions (v0.12 collapsed model)
 * 3. Handles both object and string transaction formats
 * 4. Supports single-transaction packages (v0.12 collapsed funding/spell model) [55, 225]
 * 5. Enhanced error logging for debugging
 * 6. MANUAL AUDIT LOGGING: Records standard BTC transfers (vault funding) that lack ZK-spells [Source 98]
 */
export async function broadcastPackage(req: Request, res: Response) {
  const requestId = Math.random().toString(36).substring(7);
  const db = getDb(req);
  
  console.log(`\n[BROADCAST:${requestId}] ===== START broadcastPackage =====`);
  
  try {
    const { transactions } = req.body;

    // ----------------------------------------------------------------------------
    // Step 1: Log the raw request body for debugging
    // ----------------------------------------------------------------------------
    console.log(`[BROADCAST:${requestId}] Raw request body received:`, {
      bodyKeys: Object.keys(req.body),
      hasTransactions: 'transactions' in req.body,
      transactionsType: typeof transactions,
      fullBodyPreview: JSON.stringify(req.body).substring(0, 500) + '...'
    });

    // ----------------------------------------------------------------------------
    // Step 2: Validate transactions package
    // CRITICAL FIX: Allow single-transaction packages for v0.12 compatibility [Source 55, 225]
    // The v0.12 collapsed funding/spell model returns a single combined transaction
    // ----------------------------------------------------------------------------
    console.log(`[BROADCAST:${requestId}] Transactions package analysis:`, {
      count: transactions?.length || 0,
      isArray: Array.isArray(transactions),
      firstItemType: transactions?.[0] ? typeof transactions[0] : 'undefined',
      secondItemType: transactions?.[1] ? typeof transactions[1] : 'undefined'
    });

    // [FIX] Change validation from < 2 to === 0 to support single hexes [Source 55, 225]
    if (!transactions || !Array.isArray(transactions) || transactions.length === 0) {
      throw new Error("Package must contain at least one signed transaction.");
    }

    console.log(`[BROADCAST:${requestId}] Package contains ${transactions.length} transaction(s)`);
    const isSingleTransaction = transactions.length === 1;
    if (isSingleTransaction) {
      console.log(`[BROADCAST:${requestId}] Single-transaction mode detected (v0.12 collapsed model) - using sendrawtransaction`);
    } else {
      console.log(`[BROADCAST:${requestId}] Dual-transaction mode detected (v11/v12 standard model) - using submitpackage`);
    }

    // ----------------------------------------------------------------------------
    // Step 3: Extract hex strings from object format if needed
    // ----------------------------------------------------------------------------
    const hexTransactions: string[] = [];
    
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      
      // Extract hex from object format {bitcoin: "hex..."}
      if (tx && typeof tx === 'object' && tx.bitcoin && typeof tx.bitcoin === 'string') {
        hexTransactions.push(tx.bitcoin);
        console.log(`[BROADCAST:${requestId}] Extracted hex from object for tx ${index}`);
        
        // Validate hex
        if (!/^[0-9a-fA-F]+$/.test(tx.bitcoin)) {
          throw new Error(`Transaction ${index} contains invalid hex characters`);
        }
        
      } else if (typeof tx === 'string') {
        // Already a hex string
        hexTransactions.push(tx);
        console.log(`[BROADCAST:${requestId}] Using string hex for tx ${index}`);
        
        // Validate hex
        if (!/^[0-9a-fA-F]+$/.test(tx)) {
          throw new Error(`Transaction ${index} is not a valid hex string`);
        }
        
      } else {
        throw new Error(`Invalid transaction format at index ${index}: ${typeof tx}`);
      }
    }

    console.log(`[BROADCAST:${requestId}] Final hex transactions to broadcast:`, {
      count: hexTransactions.length,
      firstLength: hexTransactions[0]?.length,
      secondLength: hexTransactions[1]?.length,
      firstValid: /^[0-9a-fA-F]+$/.test(hexTransactions[0] || ''),
      secondValid: /^[0-9a-fA-F]+$/.test(hexTransactions[1] || '')
    });

    // ----------------------------------------------------------------------------
    // Step 4: Validate RPC credentials
    // ----------------------------------------------------------------------------
    if (!RPC_USER || !RPC_PASSWORD) {
      throw new Error('RPC_USER and RPC_PASSWORD must be set in environment variables');
    }
    
    console.log(`[BROADCAST:${requestId}] RPC Configuration:`, {
      host: RPC_HOST,
      port: RPC_PORT,
      url: RPC_URL,
      hasUser: !!RPC_USER,
      hasPassword: !!RPC_PASSWORD
    });

    // ----------------------------------------------------------------------------
    // Step 5: Prepare RPC request - use appropriate method based on transaction count
    // CRITICAL: submitpackage requires at least 2 transactions
    // For single transactions, use sendrawtransaction instead
    // ----------------------------------------------------------------------------
    const isSingle = hexTransactions.length === 1;
    const rpcMethod = isSingle ? "sendrawtransaction" : "submitpackage";
    const rpcParams = isSingle ? [hexTransactions[0]] : [hexTransactions];
    
    const rpcRequest = {
      jsonrpc: "1.0",
      id: `charmbills-broadcast-${requestId}`,
      method: rpcMethod,
      params: rpcParams
    };
    
    console.log(`[BROADCAST:${requestId}] RPC Request:`, {
      method: rpcRequest.method,
      paramsCount: rpcRequest.params.length,
      txCount: Array.isArray(rpcRequest.params[0]) ? rpcRequest.params[0].length : 1
    });

    // ----------------------------------------------------------------------------
    // Step 6: Execute the broadcast via RPC [4]
    // ----------------------------------------------------------------------------
    console.log(`[BROADCAST:${requestId}] Connecting to: ${RPC_URL}`);
    
    const rpcResponse = await axios.post(RPC_URL, rpcRequest, {
      auth: { username: RPC_USER, password: RPC_PASSWORD },
      headers: { 'Content-Type': 'text/plain' },
      timeout: 30000 // 30 second timeout
    });

    // ----------------------------------------------------------------------------
    // Step 7: Check for RPC errors
    // ----------------------------------------------------------------------------
    if (rpcResponse.data?.error) {
      const rpcError = rpcResponse.data.error;
      console.error(`[BROADCAST:${requestId}] RPC Error:`, rpcError);
      throw new Error(`RPC Error: ${rpcError.message} (code: ${rpcError.code})`);
    }

    const result = rpcResponse.data.result;
    console.log(`[BROADCAST:${requestId}] Broadcast successful via ${rpcMethod}:`, result);

    // ----------------------------------------------------------------------------
    // Step 8: Parse and return transaction IDs
    // ----------------------------------------------------------------------------
    let txids: string[] = [];
    if (isSingle) {
        // sendrawtransaction returns a single txid string
        txids = [result];
        console.log(`[BROADCAST:${requestId}] Single txid: ${result}`);
    } else if (Array.isArray(result)) {
        txids = result;
        console.log(`[BROADCAST:${requestId}] Multiple txids: ${result.join(', ')}`);
    } else if (typeof result === 'string') {
        txids = [result];
    } else if (result && typeof result === 'object') {
        txids = result.txids || [result];
    }

    console.log(`[BROADCAST:${requestId}] Transaction IDs:`, txids);

    // =========================================================================
    // CRITICAL FIX: MANUAL AUDIT LOGGING FOR STANDARD BTC TRANSFERS
    // =========================================================================
    // The indexer only detects ZK-spells (OP_RETURN metadata). Standard P2TR
    // transfers (like vault funding) have no spell to index. Without manual
    // logging, treasury funding transactions never appear in the audit trail.
    // This implements the "Write-Ahead Log" pattern for production systems.
    // =========================================================================
    
    // Determine if this is a treasury funding transaction (single transaction with no spell)
    // For single transactions, we log as TREASURY_FUNDING since they're likely vault transfers
    // For dual transactions, the indexer will detect the spell automatically
    if (isSingle && txids.length > 0) {
        const txid = txids[0];
        console.log(`[BROADCAST:${requestId}] ✅ Recording treasury event for ${txid}`);
        
        try {
            await saveAuditLog(
                db,
                crypto.randomUUID(),
                'TREASURY_FUNDING',
                'Liquidity locked in Scroll Vault',
                txid,
                'pending'  // Initial status - will be updated to 'confirmed' by indexer
            );
            console.log(`[BROADCAST:${requestId}] ✅ Audit log saved for treasury funding`);
        } catch (auditError: any) {
            // Don't fail the broadcast if audit logging fails
            console.error(`[BROADCAST:${requestId}] ⚠️ Failed to save audit log:`, auditError.message);
        }
    } else if (!isSingle && txids.length > 0) {
        // For dual transactions (ZK-spells), the indexer will handle logging
        console.log(`[BROADCAST:${requestId}] Dual transaction mode - audit logging will be handled by indexer`);
    }

    // CRITICAL FIX: Log the actual broadcasted txid for the token UTXO
    // The worker's token UTXO is at index 0 of the transaction outputs
    if (txids.length > 0) {
        console.log(`[BROADCAST:${requestId}] ✅ IMPORTANT - Actual broadcasted txid: ${txids[0]}`);
        console.log(`[BROADCAST:${requestId}] Worker token UTXO will be: ${txids[0]}:0`);
    }
    console.log(`[BROADCAST:${requestId}] ===== SUCCESS =====\n`);
    
    return res.status(200).json({
      success: true,
      txids: txids,
      message: `Successfully broadcast ${txids.length} transaction(s) using ${rpcMethod}`,
      rpcEndpoint: RPC_URL,
      isSingleMode: isSingle
    });

  } catch (error: any) {
    // ----------------------------------------------------------------------------
    // Enhanced error logging
    // ----------------------------------------------------------------------------
    console.error(`\n[BROADCAST:${requestId}] ❌ ERROR =====`);
    console.error(`[BROADCAST:${requestId}] Error message: ${error.message}`);
    console.error(`[BROADCAST:${requestId}] Error code: ${error.code}`);
    
    if (error.response) {
      console.error(`[BROADCAST:${requestId}] Response status: ${error.response.status}`);
      console.error(`[BROADCAST:${requestId}] Response data:`, error.response.data);
      console.error(`[BROADCAST:${requestId}] Response headers:`, error.response.headers);
    } else if (error.request) {
      console.error(`[BROADCAST:${requestId}] No response received from RPC node`);
      console.error(`[BROADCAST:${requestId}] Request details:`, error.request);
    }
    
    console.error(`[BROADCAST:${requestId}] Stack trace:`, error.stack?.split('\n').slice(0, 5).join('\n'));
    console.error(`[BROADCAST:${requestId}] ===== END =====\n`);

    // Determine appropriate status code
    let statusCode = 500;
    let errorMessage = error.message;
    
    if (error.message.includes('RPC_USER') || error.message.includes('RPC_PASSWORD')) {
      statusCode = 500;
      errorMessage = 'RPC credentials not configured';
    } else if (error.message.includes('Connection refused') || error.message.includes('ECONNREFUSED')) {
      statusCode = 503;
      errorMessage = 'Bitcoin node is not running or not accessible';
    } else if (error.message.includes('timeout')) {
      statusCode = 504;
      errorMessage = 'RPC request timeout - node may be busy';
    } else if (error.message.includes('Invalid transaction')) {
      statusCode = 400;
      errorMessage = error.message;
    } else if (error.message.includes('at least one signed transaction')) {
      statusCode = 400;
      errorMessage = error.message;
    }
    
    const errorData = error.response?.data?.error || error.response?.data || error.message;
    
    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: errorData,
      code: error.code,
      requestId
    });
  }
}

// --------------------------------------------------------------------------------
// Health Check Endpoint - Check RPC connection
// --------------------------------------------------------------------------------

/**
 * Health check to verify RPC connection to Bitcoin node
 * GET /api/broadcast/health
 */
export async function checkRpcHealth(req: Request, res: Response) {
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`\n[RPC HEALTH:${requestId}] Checking RPC connection...`);
  
  try {
    // Validate RPC credentials
    if (!RPC_USER || !RPC_PASSWORD) {
      throw new Error('RPC credentials not configured');
    }
    
    // Simple getblockchaininfo to test connection
    const rpcRequest = {
      jsonrpc: "1.0",
      id: `health-check-${requestId}`,
      method: "getblockchaininfo",
      params: []
    };
    
    console.log(`[RPC HEALTH:${requestId}] Testing connection to: ${RPC_URL}`);
    
    const response = await axios.post(RPC_URL, rpcRequest, {
      auth: { username: RPC_USER, password: RPC_PASSWORD },
      headers: { 'Content-Type': 'text/plain' },
      timeout: 5000
    });
    
    if (response.data?.error) {
      throw new Error(`RPC Error: ${response.data.error.message}`);
    }
    
    const blockchainInfo = response.data.result;
    
    console.log(`[RPC HEALTH:${requestId}] ✅ Connected to Bitcoin node`);
    console.log(`[RPC HEALTH:${requestId}] Chain: ${blockchainInfo.chain}`);
    console.log(`[RPC HEALTH:${requestId}] Blocks: ${blockchainInfo.blocks}`);
    
    return res.status(200).json({
      success: true,
      chain: blockchainInfo.chain,
      blocks: blockchainInfo.blocks,
      headers: blockchainInfo.headers,
      nodeVersion: blockchainInfo.version,
      rpcEndpoint: RPC_URL,
      message: 'RPC connection successful'
    });
    
  } catch (error: any) {
    console.error(`[RPC HEALTH:${requestId}] ❌ RPC connection failed:`, error.message);
    
    return res.status(503).json({
      success: false,
      error: error.message,
      details: error.response?.data?.error || error.code
    });
  }
}

// --------------------------------------------------------------------------------
// Node Info Endpoint - Get node details for dashboard
// --------------------------------------------------------------------------------

/**
 * FIX FOR TS2305: Provides node version and network details to the dashboard.
 * GET /api/broadcast/node-info
 */
export async function getNodeInfo(req: Request, res: Response) {
  const requestId = Math.random().toString(36).substring(7);
  
  console.log(`\n[RPC NODE INFO:${requestId}] Fetching node information...`);
  
  try {
    // Validate RPC credentials
    if (!RPC_USER || !RPC_PASSWORD) {
      throw new Error('RPC credentials not configured');
    }
    
    // Get network info
    const rpcRequest = {
      jsonrpc: "1.0",
      id: `node-info-${requestId}`,
      method: "getnetworkinfo",
      params: []
    };
    
    const response = await axios.post(RPC_URL, rpcRequest, {
      auth: { username: RPC_USER, password: RPC_PASSWORD },
      headers: { 'Content-Type': 'text/plain' },
      timeout: 10000
    });
    
    if (response.data?.error) {
      throw new Error(`RPC Error: ${response.data.error.message}`);
    }
    
    const networkInfo = response.data.result;
    
    console.log(`[RPC NODE INFO:${requestId}] ✅ Node info retrieved`);
    console.log(`[RPC NODE INFO:${requestId}] Version: ${networkInfo.version}`);
    console.log(`[RPC NODE INFO:${requestId}] Network: ${networkInfo.network}`);
    
    return res.status(200).json({
      success: true,
      version: networkInfo.version,
      subversion: networkInfo.subversion,
      network: networkInfo.network,
      connections: networkInfo.connections,
      protocols: networkInfo.protocolversion,
      warnings: networkInfo.warnings
    });
    
  } catch (error: any) {
    console.error(`[RPC NODE INFO:${requestId}] ❌ Failed to fetch node info:`, error.message);
    
    return res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data?.error || error.code
    });
  }
}