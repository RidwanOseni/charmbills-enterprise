import { Request, Response } from 'express';
import axios from 'axios';

const RPC_HOST = process.env.RPC_HOST || 'localhost';
const RPC_PORT = process.env.RPC_PORT || 48332;
const RPC_URL = `http://${RPC_HOST}:${RPC_PORT}`;
const RPC_USER = process.env.RPC_USER || '';
const RPC_PASSWORD = process.env.RPC_PASSWORD || '';

if (!RPC_USER || !RPC_PASSWORD) {
    console.warn('[UTXOS API] ⚠️ RPC_USER and RPC_PASSWORD not set. UTXO queries will fail.');
}

const RPC_AUTH = 'Basic ' + Buffer.from(`${RPC_USER}:${RPC_PASSWORD}`).toString('base64');

let supportedUtxoMethod: 'scantxoutset' | 'getaddressutxos' | 'listunspent' | null = null;
let methodDetectionAttempted = false;

interface CachedUtxos {
    utxos: any[];
    timestamp: number;
}

const utxoCache: { [address: string]: CachedUtxos } = {};
const CACHE_TTL_MS = 60000;

async function rpcCall(method: string, params: any[]): Promise<any> {
    const startTime = Date.now();
    try {
        const response = await axios.post(
            RPC_URL,
            {
                jsonrpc: '1.0',
                id: 'utxo-api-' + Date.now(),
                method,
                params
            },
            {
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: RPC_AUTH
                },
                timeout: 60000
            }
        );
        
        if (response.data.error) {
            throw new Error(`RPC error: ${response.data.error.message}`);
        }
        
        const elapsed = Date.now() - startTime;
        if (elapsed > 1000) {
            console.log(`[UTXOS API] ⏱️ RPC call ${method} took ${elapsed}ms`);
        }
        
        return response.data.result;
    } catch (error: any) {
        const elapsed = Date.now() - startTime;
        console.error(`[UTXOS API] RPC call ${method} failed after ${elapsed}ms:`, error.message);
        throw error;
    }
}

async function detectUtxoMethod(): Promise<string> {
    if (supportedUtxoMethod) {
        return supportedUtxoMethod;
    }
    
    if (methodDetectionAttempted) {
        return 'listunspent';
    }
    
    methodDetectionAttempted = true;
    console.log('[UTXOS API] 🔍 Detecting available RPC methods for UTXO queries...');
    
    try {
        await rpcCall('scantxoutset', ['status']);
        supportedUtxoMethod = 'scantxoutset';
        console.log('[UTXOS API] ✅ scantxoutset supported');
        return supportedUtxoMethod;
    } catch (error: any) {
        console.log('[UTXOS API] ⚠️ scantxoutset not available:', error.message);
        
        try {
            await rpcCall('getaddressutxos', [{ addresses: ['tb1qtest'] }]);
            supportedUtxoMethod = 'getaddressutxos';
            console.log('[UTXOS API] ✅ getaddressutxos supported');
            return supportedUtxoMethod;
        } catch (error2: any) {
            console.log('[UTXOS API] ⚠️ getaddressutxos not available:', error2.message);
            supportedUtxoMethod = 'listunspent';
            console.log('[UTXOS API] ✅ Using listunspent as fallback');
            return supportedUtxoMethod;
        }
    }
}

async function fetchUtxosWithScantxoutset(address: string): Promise<any[]> {
    const cached = utxoCache[address];
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        console.log('[UTXOS API] Using cached UTXOs for:', address.substring(0, 16) + '...');
        return cached.utxos;
    }
    
    console.log('[UTXOS API] Using scantxoutset for address:', address.substring(0, 16) + '...');
    const result = await rpcCall('scantxoutset', ['start', [`addr(${address})`]]);
    
    if (!result || !result.unspents) {
        return [];
    }
    
    const utxos = result.unspents.map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: utxo.amount * 100000000,
        status: {
            confirmed: true,
            block_height: utxo.height || 0,
            block_hash: utxo.blockhash || '',
            block_time: Math.floor(Date.now() / 1000)
        }
    }));
    
    utxoCache[address] = {
        utxos: utxos,
        timestamp: Date.now()
    };
    
    console.log(`[UTXOS API] Cached ${utxos.length} UTXOs for address (TTL: ${CACHE_TTL_MS}ms)`);
    
    return utxos;
}

async function fetchUtxosWithGetaddressutxos(address: string): Promise<any[]> {
    console.log('[UTXOS API] Using getaddressutxos for address:', address.substring(0, 16) + '...');
    const result = await rpcCall('getaddressutxos', [{ addresses: [address] }]);
    
    if (!result || !Array.isArray(result)) {
        return [];
    }
    
    return result.map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.outputIndex || utxo.vout || 0,
        value: utxo.satoshis || utxo.amount || 0,
        status: {
            confirmed: true,
            block_height: utxo.height || 0,
            block_time: Math.floor(Date.now() / 1000)
        }
    }));
}

async function fetchUtxosWithListunspent(address: string): Promise<any[]> {
    console.log('[UTXOS API] Using listunspent for address:', address.substring(0, 16) + '...');
    const result = await rpcCall('listunspent', [0, 9999999, [address]]);
    
    if (!result || !Array.isArray(result)) {
        return [];
    }
    
    return result.map((utxo: any) => ({
        txid: utxo.txid,
        vout: utxo.vout,
        value: Math.round(utxo.amount * 100000000),
        status: {
            confirmed: utxo.confirmations > 0,
            block_height: utxo.blockheight || 0,
            block_time: Math.floor(Date.now() / 1000)
        }
    }));
}

export async function getUtxos(req: Request, res: Response) {
    const { address } = req.params;
    const requestId = Date.now().toString(36);
    
    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }
    
    console.log(`[UTXOS API:${requestId}] Fetching UTXOs for address: ${address.substring(0, 16)}...`);
    
    try {
        const method = await detectUtxoMethod();
        let utxos: any[] = [];
        let usedMethod = method;
        
        try {
            if (method === 'scantxoutset') {
                utxos = await fetchUtxosWithScantxoutset(address);
            } else if (method === 'getaddressutxos') {
                utxos = await fetchUtxosWithGetaddressutxos(address);
            } else {
                utxos = await fetchUtxosWithListunspent(address);
            }
            
            console.log(`[UTXOS API:${requestId}] Found ${utxos.length} UTXOs using ${method}`);
            
        } catch (error: any) {
            console.warn(`[UTXOS API:${requestId}] Primary method ${method} failed:`, error.message);
            console.log(`[UTXOS API:${requestId}] Falling back to listunspent...`);
            
            utxos = await fetchUtxosWithListunspent(address);
            usedMethod = 'listunspent';
            console.log(`[UTXOS API:${requestId}] Found ${utxos.length} UTXOs using listunspent (fallback)`);
        }
        
        res.json(utxos);
        
    } catch (error: any) {
        console.error(`[UTXOS API:${requestId}] Final error:`, error.message);
        res.status(500).json({
            error: 'Failed to fetch UTXOs from RPC',
            details: error.message
        });
    }
}

export async function getAddressBalance(req: Request, res: Response) {
    const { address } = req.params;
    const requestId = Date.now().toString(36);
    
    if (!address) {
        return res.status(400).json({ error: 'Address is required' });
    }
    
    console.log(`[UTXOS API:${requestId}] Fetching balance for: ${address.substring(0, 16)}...`);
    
    try {
        const method = await detectUtxoMethod();
        let utxos: any[] = [];
        
        if (method === 'scantxoutset') {
            const cached = utxoCache[address];
            if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
                utxos = cached.utxos;
            } else {
                const result = await rpcCall('scantxoutset', ['start', [`addr(${address})`]]);
                if (result && result.unspents) {
                    utxos = result.unspents;
                }
            }
        } else if (method === 'getaddressutxos') {
            const result = await rpcCall('getaddressutxos', [{ addresses: [address] }]);
            if (result && Array.isArray(result)) {
                utxos = result;
            }
        } else {
            const result = await rpcCall('listunspent', [0, 9999999, [address]]);
            if (result && Array.isArray(result)) {
                utxos = result;
            }
        }
        
        const totalBalance = utxos.reduce((sum: number, utxo: any) => {
            const value = utxo.amount ? utxo.amount * 100000000 : (utxo.satoshis || utxo.value || 0);
            return sum + value;
        }, 0);
        
        console.log(`[UTXOS API:${requestId}] Balance: ${totalBalance} sats (${utxos.length} UTXOs)`);
        
        res.json({
            balance: totalBalance,
            utxoCount: utxos.length
        });
        
    } catch (error: any) {
        console.error(`[UTXOS API:${requestId}] Balance error:`, error.message);
        res.status(500).json({ error: error.message });
    }
}

export async function getRecommendedFees(req: Request, res: Response) {
    const requestId = Date.now().toString(36);
    console.log(`[FEE API:${requestId}] Fetching recommended fees from RPC...`);
    
    try {
        const result = await rpcCall('estimatesmartfee', [6]);
        
        if (!result || result.errors) {
            console.log(`[FEE API:${requestId}] estimatesmartfee failed, trying fallback...`);
            const fallbackResult = await rpcCall('estimatesmartfee', [2]);
            
            if (fallbackResult && !fallbackResult.errors) {
                const feeRate = Math.ceil(fallbackResult.feerate * 100000000);
                const satsPerVByte = Math.ceil(feeRate / 1000);
                
                console.log(`[FEE API:${requestId}] Fallback fee rate: ${satsPerVByte} sats/vbyte`);
                return res.json({
                    fastestFee: satsPerVByte,
                    halfHourFee: Math.max(1, satsPerVByte - 2),
                    hourFee: Math.max(1, satsPerVByte - 4),
                    minimumFee: Math.max(1, Math.floor(satsPerVByte / 2)),
                    feeRate: satsPerVByte
                });
            }
            throw new Error('Failed to estimate fee from RPC');
        }
        
        const feeRate = Math.ceil(result.feerate * 100000000);
        const satsPerVByte = Math.ceil(feeRate / 1000);
        
        console.log(`[FEE API:${requestId}] Fee rate: ${satsPerVByte} sats/vbyte`);
        
        res.json({
            fastestFee: satsPerVByte,
            halfHourFee: Math.max(1, satsPerVByte - 2),
            hourFee: Math.max(1, satsPerVByte - 4),
            minimumFee: Math.max(1, Math.floor(satsPerVByte / 2)),
            feeRate: satsPerVByte
        });
        
    } catch (error: any) {
        console.error(`[FEE API:${requestId}] Error:`, error.message);
        
        res.json({
            fastestFee: 10,
            halfHourFee: 8,
            hourFee: 5,
            minimumFee: 3,
            feeRate: 8,
            _fallback: true
        });
    }
}

export async function getTransactionHex(req: Request, res: Response) {
    const { txid } = req.params;
    const requestId = Date.now().toString(36);
    
    if (!txid) {
        return res.status(400).json({ error: 'txid is required' });
    }
    
    console.log(`[TX API:${requestId}] Fetching hex for txid: ${txid.substring(0, 16)}...`);
    
    try {
        const hex = await rpcCall('getrawtransaction', [txid]);
        
        if (!hex) {
            console.log(`[TX API:${requestId}] Transaction not found`);
            return res.status(404).json({ error: 'Transaction not found' });
        }
        
        console.log(`[TX API:${requestId}] Hex length: ${hex.length} bytes`);
        res.send(hex);
        
    } catch (error: any) {
        console.error(`[TX API:${requestId}] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
}

export async function getUtxoStatus(req: Request, res: Response) {
    const { txid, vout } = req.params;
    const requestId = Date.now().toString(36);
    
    if (!txid || vout === undefined) {
        return res.status(400).json({ error: 'txid and vout are required' });
    }
    
    console.log(`[UTXO STATUS:${requestId}] Checking UTXO: ${txid.substring(0, 16)}:${vout}`);
    
    try {
        const result = await rpcCall('gettxout', [txid, parseInt(vout), true]);
        
        if (!result) {
            console.log(`[UTXO STATUS:${requestId}] UTXO is spent or does not exist`);
            return res.json({ spent: true });
        }
        
        console.log(`[UTXO STATUS:${requestId}] UTXO is unspent, value: ${result.value} BTC`);
        
        res.json({
            spent: false,
            value: result.value,
            scriptPubKey: result.scriptPubKey,
            confirmations: result.confirmations
        });
        
    } catch (error: any) {
        console.error(`[UTXO STATUS:${requestId}] Error:`, error.message);
        res.status(500).json({ error: error.message });
    }
}