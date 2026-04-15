import axios from 'axios';

// Corrected base URL without extra "/scrolls" segment [Source 661, 737]
const SCROLL_BASE = "https://scrolls-v12.charms.dev";

/**
 * Centralized derivation logic.
 * Converts a hex appId into a deterministic 64-bit nonce.
 */
export function deriveNonceFromAppId(appId: string): number {
    // Take first 15 characters of the hex appId and parse as hex to get a number
    return parseInt(appId.substring(0, 15), 16);
}

/**
 * Fetches the isolated vault address from the Scroll Protocol.
 * Uses the correct API path: /{network}/address/{nonce} [Source 661]
 * 
 * @param appId - The application ID (hex string) to derive the vault address
 * @returns The vault address as a string (e.g., "tb1...")
 */
export async function getVaultAddress(appId: string): Promise<string> {
    const nonce = deriveNonceFromAppId(appId);
    const network = "testnet4";
    const targetUrl = `${SCROLL_BASE}/${network}/address/${nonce}`;
    
    try {
        console.log(`[Scrolls Client] Querying vault: ${targetUrl}`);
        
        const res = await axios.get(targetUrl, { 
            timeout: 15000,  // Increased for testnet latency [Source 737]
            headers: { 'Accept': 'application/json' },
            family: 4  // Force IPv4 to avoid IPv6 connection hang [Source 737]
        });
        
        if (!res.data || typeof res.data !== 'string') {
            throw new Error('Invalid response from Scroll API');
        }
        
        // Remove quotes and whitespace from the raw string response [3]
        return res.data.trim().replace(/"/g, '');
    } catch (error: any) {
        const status = error.response?.status;
        console.error('[Scrolls Client] Failed to get vault address:', error.message);
        
        if (status === 404) {
            throw new Error(`Scroll API Error: Endpoint ${targetUrl} not found. Check network version.`);
        }
        throw new Error(`Scroll API error: ${error.message}`);
    }
}

/**
 * Triggers the Scroll Settlement (Payment Release).
 * Scrolls will ONLY sign if the tx carries a correct spell (token spend) [8].
 * 
 * @param txToSign - The transaction hex string to be signed by Scroll
 * @param signInputs - Array of objects containing input index and nonce for each input to sign
 * @param prevTxs - Array of previous transaction hexes for context
 * @returns The signed transaction as a hex-encoded string
 * 
 * Based on Scroll API documentation:
 * POST /{network}/sign
 * {
 *   "sign_inputs": [
 *     { "index": 0, "nonce": 1234567890 },
 *     { "index": 1, "nonce": 1234567890 }
 *   ],
 *   "prev_txs": ["hex...", "hex..."],
 *   "tx_to_sign": "hex..."
 * }
 */
export async function requestScrollSignature(
    txToSign: string, 
    signInputs: Array<{ index: number; nonce: number }>, 
    prevTxs: string[]
): Promise<string> {
    const network = "testnet4";
    const targetUrl = `${SCROLL_BASE}/${network}/sign`;
    
    try {
        console.log(`[Scrolls Client] Requesting signature from: ${targetUrl}`);
        
        // POST /testnet4/sign [7]
        const res = await axios.post(targetUrl, {
            tx_to_sign: txToSign,
            sign_inputs: signInputs,
            prev_txs: prevTxs
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            family: 4  // Force IPv4 to avoid IPv6 connection hang
        });
        
        if (!res.data || typeof res.data !== 'string') {
            throw new Error('Invalid response from Scroll sign API');
        }
        
        // Remove quotes from the JSON string response
        return res.data.trim().replace(/"/g, '');
    } catch (error: any) {
        console.error('[Scrolls Client] Failed to request Scroll signature:', error.message);
        if (error.response?.data) {
            console.error('[Scrolls Client] Scroll API response:', error.response.data);
        }
        throw new Error(`Scroll Policy Rejection: ${error.response?.data || error.message}`);
    }
}

/**
 * Gets the current Scroll policy for a specific vault.
 * Useful for debugging and understanding settlement rules.
 * 
 * @param appId - The application ID (hex string) to query policy for
 * @returns The Scroll policy object
 */
export async function getScrollPolicy(appId: string): Promise<any> {
    const nonce = deriveNonceFromAppId(appId);
    const network = "testnet4";
    const targetUrl = `${SCROLL_BASE}/${network}/policy/${nonce}`;
    
    try {
        console.log(`[Scrolls Client] Fetching policy from: ${targetUrl}`);
        
        const res = await axios.get(targetUrl, {
            timeout: 15000,
            headers: { 'Accept': 'application/json' },
            family: 4  // Force IPv4 to avoid IPv6 connection hang
        });
        
        return res.data;
    } catch (error: any) {
        console.error('[Scrolls Client] Failed to get Scroll policy:', error.message);
        throw new Error(`Scroll API error: ${error.message}`);
    }
}

/**
 * Verifies if a vault is properly funded for payroll.
 * 
 * @param appId - The application ID (hex string)
 * @returns The vault status including balance and funding requirements
 */
export async function getVaultStatus(appId: string): Promise<{
    vaultAddress: string;
    currentBalance: number;
    requiredFunding: number;
    isFullyFunded: boolean;
}> {
    const vaultAddress = await getVaultAddress(appId);
    const nonce = deriveNonceFromAppId(appId);
    const network = "testnet4";
    const targetUrl = `${SCROLL_BASE}/${network}/status/${nonce}`;
    
    try {
        console.log(`[Scrolls Client] Fetching vault status from: ${targetUrl}`);
        
        const res = await axios.get(targetUrl, {
            timeout: 15000,
            headers: { 'Accept': 'application/json' },
            family: 4  // Force IPv4 to avoid IPv6 connection hang
        });
        
        return {
            vaultAddress,
            currentBalance: res.data?.balance || 0,
            requiredFunding: res.data?.required || 0,
            isFullyFunded: (res.data?.balance || 0) >= (res.data?.required || 0)
        };
    } catch (error: any) {
        console.error('[Scrolls Client] Failed to get vault status:', error.message);
        // Return basic info without API data
        return {
            vaultAddress,
            currentBalance: 0,
            requiredFunding: 0,
            isFullyFunded: false
        };
    }
}

/**
 * Returns the current configuration of the Scrolls Bitcoin API.
 * Useful for fee calculation validation.
 * 
 * @returns Scroll configuration with fee_address, fee_per_input, fee_basis_points, fixed_cost
 */
export async function getScrollConfig(): Promise<{
    fee_address: { main: string; testnet4: string };
    fee_per_input: number;
    fee_basis_points: number;
    fixed_cost: number;
}> {
    const targetUrl = `${SCROLL_BASE}/config`;
    
    try {
        console.log(`[Scrolls Client] Fetching config from: ${targetUrl}`);
        
        const res = await axios.get(targetUrl, {
            timeout: 15000,
            headers: { 'Accept': 'application/json' },
            family: 4  // Force IPv4 to avoid IPv6 connection hang
        });
        
        return res.data;
    } catch (error: any) {
        console.error('[Scrolls Client] Failed to get Scroll config:', error.message);
        // Return defaults based on constants
        return {
            fee_address: {
                main: "bc1qxxxjm06n50uugxewxe5r5w5tskqwq4gkwrm0al",
                testnet4: "tb1qrk6da5g0592sx6lmgpchaf5qy2lgn8am7cuf3a"
            },
            fee_per_input: 64,
            fee_basis_points: 10,
            fixed_cost: 895
        };
    }
}