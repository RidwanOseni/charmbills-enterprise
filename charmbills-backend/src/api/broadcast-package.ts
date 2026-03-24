import { Request, Response } from 'express';
import axios from 'axios';
import * as constants from '@shared/constants';

/**
 * Broadcasts the signed transactions as a package to Bitcoin testnet4.
 * The frontend sends an array: [signedCommitHex, signedSpellHex].
 * 
 * PRODUCTION IMPLEMENTATION:
 * 1. Resolves RPC connection details from environment or constants
 * 2. Uses submitpackage RPC method for atomic broadcast (Protocol v0.12) [3]
 * 3. Handles both object and string transaction formats
 * 4. Enhanced error logging for debugging
 */
export async function broadcastPackage(req: Request, res: Response) {
  const requestId = Math.random().toString(36).substring(7);
  
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
    // ----------------------------------------------------------------------------
    console.log(`[BROADCAST:${requestId}] Transactions package analysis:`, {
      count: transactions?.length || 0,
      isArray: Array.isArray(transactions),
      firstItemType: transactions?.[0] ? typeof transactions[0] : 'undefined',
      secondItemType: transactions?.[1] ? typeof transactions[1] : 'undefined'
    });

    if (!transactions || !Array.isArray(transactions) || transactions.length < 2) {
      throw new Error("Package must contain exactly two signed transactions.");
    }

    // ----------------------------------------------------------------------------
    // Step 3: Extract hex strings from object format if needed
    // ----------------------------------------------------------------------------
    let hexTransactions: string[] = [];
    
    for (let index = 0; index < transactions.length; index++) {
      const tx = transactions[index];
      
      console.log(`[BROADCAST:${requestId}] Transaction ${index} analysis:`, {
        type: typeof tx,
        isObject: tx && typeof tx === 'object',
        isString: typeof tx === 'string',
        hasBitcoinProperty: tx && typeof tx === 'object' && 'bitcoin' in tx,
        bitcoinType: tx?.bitcoin ? typeof tx.bitcoin : 'N/A',
        bitcoinLength: tx?.bitcoin?.length || 0,
        rawValue: JSON.stringify(tx).substring(0, 100) + (JSON.stringify(tx).length > 100 ? '...' : '')
      });
      
      // Extract hex from object format {bitcoin: "hex..."}
      if (tx && typeof tx === 'object' && tx.bitcoin && typeof tx.bitcoin === 'string') {
        hexTransactions.push(tx.bitcoin);
        console.log(`[BROADCAST:${requestId}] Extracted hex from object for tx ${index}`);
        
        // Validate hex
        const hex = tx.bitcoin;
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
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
    // Step 4: Resolve RPC connection details [1]
    // Priority: Environment Variables (.env) > Shared Constants > Hardcoded Default
    // ----------------------------------------------------------------------------
    const rpcHost = process.env.RPC_HOST || constants.DEFAULT_RPC_HOST || '127.0.0.1';
    const rpcPort = process.env.RPC_PORT || constants.DEFAULT_RPC_PORT || '48332';
    const rpcUrl = `http://${rpcHost}:${rpcPort}`;
    
    // Get RPC credentials from environment [4]
    const rpcUser = process.env.RPC_USER;
    const rpcPassword = process.env.RPC_PASSWORD;
    
    if (!rpcUser || !rpcPassword) {
      throw new Error('RPC_USER and RPC_PASSWORD must be set in environment variables');
    }
    
    console.log(`[BROADCAST:${requestId}] RPC Configuration:`, {
      host: rpcHost,
      port: rpcPort,
      url: rpcUrl,
      hasUser: !!rpcUser,
      hasPassword: !!rpcPassword
    });

    // ----------------------------------------------------------------------------
    // Step 5: Prepare submitpackage RPC request for atomic broadcast [3]
    // CRITICAL: submitpackage is mandatory for v0.12 atomic broadcast
    // ----------------------------------------------------------------------------
    const rpcRequest = {
      jsonrpc: "1.0",
      id: `charmbills-broadcast-${requestId}`,
      method: "submitpackage", // Mandatory method for v11/v12 spells [3]
      params: [hexTransactions] // The array: [signedCommitHex, signedSpellHex]
    };
    
    console.log(`[BROADCAST:${requestId}] RPC Request:`, {
      method: rpcRequest.method,
      paramsCount: rpcRequest.params.length,
      txCount: rpcRequest.params[0]?.length
    });

    // ----------------------------------------------------------------------------
    // Step 6: Execute the broadcast via RPC [4]
    // ----------------------------------------------------------------------------
    console.log(`[BROADCAST:${requestId}] Connecting to: ${rpcUrl}`);
    
    const rpcResponse = await axios.post(rpcUrl, rpcRequest, {
      auth: {
        username: rpcUser,
        password: rpcPassword
      },
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
    console.log(`[BROADCAST:${requestId}] Package submitted successfully via RPC:`, result);
    
    // ----------------------------------------------------------------------------
    // Step 8: Parse and return transaction IDs
    // ----------------------------------------------------------------------------
    let txids: string[] = [];
    if (Array.isArray(result)) {
      txids = result;
    } else if (typeof result === 'string') {
      txids = [result];
    } else if (result && typeof result === 'object') {
      txids = result.txids || [result];
    }
    
    console.log(`[BROADCAST:${requestId}] Transaction IDs:`, txids);
    console.log(`[BROADCAST:${requestId}] ===== SUCCESS =====\n`);
    
    return res.status(200).json({
      success: true,
      txids: txids,
      message: `Successfully broadcast package with ${txids.length} transaction(s)`,
      rpcEndpoint: rpcUrl
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
    }
    
    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      details: error.response?.data?.error || error.response?.data,
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
    // Resolve RPC connection details using same priority [1]
    const rpcHost = process.env.RPC_HOST || constants.DEFAULT_RPC_HOST || '127.0.0.1';
    const rpcPort = process.env.RPC_PORT || constants.DEFAULT_RPC_PORT || '48332';
    const rpcUrl = `http://${rpcHost}:${rpcPort}`;
    
    const rpcUser = process.env.RPC_USER;
    const rpcPassword = process.env.RPC_PASSWORD;
    
    if (!rpcUser || !rpcPassword) {
      throw new Error('RPC credentials not configured');
    }
    
    // Simple getblockchaininfo to test connection
    const rpcRequest = {
      jsonrpc: "1.0",
      id: `health-check-${requestId}`,
      method: "getblockchaininfo",
      params: []
    };
    
    console.log(`[RPC HEALTH:${requestId}] Testing connection to: ${rpcUrl}`);
    
    const response = await axios.post(rpcUrl, rpcRequest, {
      auth: { username: rpcUser, password: rpcPassword },
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
      rpcEndpoint: rpcUrl,
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