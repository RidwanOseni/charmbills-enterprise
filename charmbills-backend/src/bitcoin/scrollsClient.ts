import axios from 'axios';

const SCROLL_BASE = "https://scrolls-v15.charms.dev";

/**
 * v15 Simplified Scroll Routing
 * In v15, you no longer derive Scroll addresses manually via nonce.
 * The prover fills them when you leave dest empty and specify scrolls indexes.
 * Each company gets a unique Scroll address automatically based on their UTXO.
 */

/**
 * Helper function to fetch with retries and longer timeout
 */
async function fetchWithRetry(url: string, retries: number = 2, delayMs: number = 1500): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, { 
                timeout: 30000,
                headers: { 'Accept': 'application/json' },
                family: 4
            });
            return response;
        } catch (error: any) {
            if (attempt === retries) {
                throw error;
            }
            console.warn(`[Scrolls Client] Retry ${attempt + 1}/${retries} for ${url}: ${error.message}`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }
    }
    throw new Error('FetchWithRetry: Unexpected end of loop');
}

/**
 * Triggers the Scroll Settlement (Payment Release).
 * Scrolls will ONLY sign if the tx carries a correct spell (token spend).
 * 
 * v15: The prover handles address derivation. This function is only for
 * signing Scroll-controlled outputs after the prover has filled the addresses.
 * 
 * @param txToSign - The transaction hex string to be signed by Scroll
 * @param signInputs - Array of objects containing input index and nonce for each input to sign
 * @param prevTxs - Array of previous transaction hexes for context
 * @returns The signed transaction as a hex-encoded string
 */
export async function requestScrollSignature(
    txToSign: string, 
    signInputs: Array<{ index: number; nonce?: number }>, 
    prevTxs: string[]
): Promise<string> {
    const network = "testnet4";
    const targetUrl = `${SCROLL_BASE}/${network}/sign`;
    
    try {
        console.log(`[Scrolls Client] Requesting signature from: ${targetUrl}`);
        console.log(`[Scrolls Client] Sign inputs: ${JSON.stringify(signInputs)}`);
        
        const res = await axios.post(targetUrl, {
            tx_to_sign: txToSign,
            sign_inputs: signInputs,
            prev_txs: prevTxs
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            family: 4
        });
        
        if (!res.data || typeof res.data !== 'string') {
            throw new Error('Invalid response from Scroll sign API');
        }
        
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
            timeout: 30000,
            headers: { 'Accept': 'application/json' },
            family: 4
        });
        
        return res.data;
    } catch (error: any) {
        console.error('[Scrolls Client] Failed to get Scroll config:', error.message);
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