import { Request, Response } from 'express';
import axios from 'axios';  // Add axios import back

/**
 * Broadcasts the signed transactions as a package to Bitcoin testnet4.
 * The frontend sends an array: [signedCommitHex, signedSpellHex].
 */
export async function broadcastPackage(req: Request, res: Response) {
  try {
    const { transactions } = req.body;

    // ENHANCED: Log the raw request body to see what's actually arriving
    console.log('[BROADCAST] Raw request body received:', {
      bodyKeys: Object.keys(req.body),
      hasTransactions: 'transactions' in req.body,
      transactionsType: typeof transactions,
      fullBody: JSON.stringify(req.body).substring(0, 500) + '...'
    });

    // ENHANCED: More detailed transaction logging
    console.log('[BROADCAST] Transactions package analysis:', {
      count: transactions?.length || 0,
      isArray: Array.isArray(transactions),
      firstItemType: transactions?.[0] ? typeof transactions[0] : 'undefined',
      secondItemType: transactions?.[1] ? typeof transactions[1] : 'undefined'
    });

    if (transactions && Array.isArray(transactions)) {
      transactions.forEach((tx: any, index: number) => {
        console.log(`[BROADCAST] Transaction ${index} detailed analysis:`, {
          type: typeof tx,
          isObject: tx && typeof tx === 'object',
          isString: typeof tx === 'string',
          hasBitcoinProperty: tx && typeof tx === 'object' && 'bitcoin' in tx,
          bitcoinType: tx?.bitcoin ? typeof tx.bitcoin : 'N/A',
          bitcoinLength: tx?.bitcoin?.length || 0,
          rawValue: JSON.stringify(tx).substring(0, 100) + (JSON.stringify(tx).length > 100 ? '...' : '')
        });
        
        // Check if it's the expected object format
        if (tx && typeof tx === 'object' && tx.bitcoin) {
          const hex = tx.bitcoin;
          console.log(`[BROADCAST] Hex validation for tx ${index}:`, {
            length: hex.length,
            isEvenLength: hex.length % 2 === 0,
            isValidHex: /^[0-9a-fA-F]+$/.test(hex),
            startsWith: hex.substring(0, 10),
            endsWith: hex.substring(hex.length - 10),
            preview: hex.substring(0, 50) + '...' + hex.substring(hex.length - 50)
          });
        } else if (typeof tx === 'string') {
          console.log(`[BROADCAST] String hex for tx ${index}:`, {
            length: tx.length,
            isEvenLength: tx.length % 2 === 0,
            isValidHex: /^[0-9a-fA-F]+$/.test(tx)
          });
        }
      });
    }

    if (!transactions || !Array.isArray(transactions) || transactions.length < 2) {
      throw new Error("Package must contain exactly two signed transactions.");
    }

    // CRITICAL FIX: Extract hex strings if they're in {bitcoin: 'hex'} format
    let hexTransactions: string[] = [];
    
    transactions.forEach((tx: any, index: number) => {
      if (tx && typeof tx === 'object' && tx.bitcoin && typeof tx.bitcoin === 'string') {
        // Extract hex from object format
        hexTransactions.push(tx.bitcoin);
        console.log(`[BROADCAST] Extracted hex from object for tx ${index}`);
      } else if (typeof tx === 'string') {
        // Already a hex string
        hexTransactions.push(tx);
        console.log(`[BROADCAST] Using string hex for tx ${index}`);
      } else {
        throw new Error(`Invalid transaction format at index ${index}: ${typeof tx}`);
      }
    });

    console.log('[BROADCAST] Final hex transactions to broadcast:', {
      count: hexTransactions.length,
      firstLength: hexTransactions[0]?.length,
      secondLength: hexTransactions[1]?.length,
      firstValid: /^[0-9a-fA-F]+$/.test(hexTransactions[0] || ''),
      secondValid: /^[0-9a-fA-F]+$/.test(hexTransactions[1] || '')
    });

    // ========== FRIEND'S FIX START ==========
    try {
      console.log('[BROADCAST] Attempting direct RPC broadcast to local node');

      // 1. Prepare the JSON-RPC request body
      const rpcRequest = {
        jsonrpc: "1.0",
        id: "charmbills-broadcast",
        method: "submitpackage",
        params: [hexTransactions] // hexTransactions is your array: [commitHex, spellHex]
      };

      // 2. Call the local node via RPC (Testnet4 default port is 48332)
      // You will need to add your RPC credentials from bitcoin.conf
      const rpcResponse = await axios.post('http://127.0.0.1:48332', rpcRequest, {
        auth: {
          username: process.env.RPC_USER || 'your_username',
          password: process.env.RPC_PASSWORD || 'your_password'
        },
        headers: { 'Content-Type': 'text/plain' }
      });

      const result = rpcResponse.data.result;
      console.log('[BROADCAST] Package submitted successfully via RPC:', result);

      return res.status(200).json({
        success: true,
        txids: result
      });

    } catch (rpcError: any) {
      const errorData = rpcError.response?.data?.error || rpcError.message;
      console.error('[BROADCAST] RPC Broadcast Failed:', errorData);
      return res.status(500).json({ 
        success: false, 
        error: "Node rejected package", 
        details: errorData 
      });
    }
    // ========== FRIEND'S FIX END ==========

  } catch (error: any) {
    // Enhanced error logging
    console.error("[BROADCAST] Broadcasting Failed:", {
      message: error.message,
      code: error.code,
      stack: error.stack?.split('\n').slice(0, 5).join('\n') // First 5 lines of stack
    });

    return res.status(500).json({ 
      error: error.message,
      details: error.response?.data,
      code: error.code
    });
  }
}