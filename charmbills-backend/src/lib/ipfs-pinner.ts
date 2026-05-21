import axios from 'axios';
import crypto from 'crypto';

export interface PinResult {
  cid: string;          // IPFS Content Identifier
  metadataHash: string; // SHA256 of CID (32 bytes, hex)
  size: number;
  timestamp: string;
}

/**
 * Pins encrypted JSON to IPFS via Pinata
 * Returns CID and its SHA256 hash for on-chain storage
 */
export async function pinToIPFS(
  encryptedData: Record<string, any>
): Promise<PinResult> {
  const JWT = process.env.PINATA_JWT;
  
  if (!JWT) {
    throw new Error('PINATA_JWT environment variable not set');
  }
  
  try {
    const response = await axios.post(
      'https://api.pinata.cloud/pinning/pinJSONToIPFS',
      encryptedData,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${JWT}`
        }
      }
    );
    
    const cid = response.data.IpfsHash;
    const size = response.data.PinSize;
    
    // Calculate SHA256 of the CID string
    // This 32-byte hash goes into the Plan NFT
    const metadataHash = crypto
      .createHash('sha256')
      .update(cid)
      .digest('hex');
    
    return {
      cid,
      metadataHash,
      size,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`IPFS pin failed: ${error.response?.data?.error || error.message}`);
    }
    throw error;
  }
}

/**
 * Retrieve encrypted data from IPFS by CID
 */
export async function getFromIPFS(cid: string): Promise<Record<string, any>> {
  try {
    // Use public IPFS gateway
    const response = await axios.get(`https://gateway.pinata.cloud/ipfs/${cid}`);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error)) {
      throw new Error(`IPFS fetch failed: ${error.message}`);
    }
    throw error;
  }
}