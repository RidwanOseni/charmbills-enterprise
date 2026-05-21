import axios from 'axios';
import * as constants from '../shared/constants';

/**
 * Fetches an encrypted metadata blob from the IPFS gateway.
 * This is used by the dashboard to retrieve the "lockbox" before decryption.
 */
export async function getFromIPFS(cid: string): Promise<any> {
  try {
    // Uses the gateway defined in your shared constants (e.g., Pinata)
    const url = `${constants.IPFS_GATEWAY}/${cid}`;
    console.log(`[IPFS] Fetching from gateway: ${cid.substring(0, 10)}...`);
    
    const response = await axios.get(url, { timeout: 10000 });
    return response.data;
  } catch (error: any) {
    console.error(`[IPFS] Failed to fetch CID ${cid}:`, error.message);
    throw new Error(`IPFS Fetch Error: ${error.message}`);
  }
}