// shared/encryption.ts (Cross-Platform Production Version)
import { scrypt } from '@noble/hashes/scrypt';
import { randomBytes } from '@noble/hashes/utils';

export interface EncryptedData {
    iv: string;
    content: string;
    tag: string;
    version: '1.0';
}

// Browser-compatible random bytes (returns Uint8Array)
function getRandomBytes(length: number): Uint8Array {
    return randomBytes(length);
}

// Browser-compatible AES-GCM requires Web Crypto API
async function getWebCryptoKey(key: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
    // Convert to standard Uint8Array to satisfy BufferSource type
    const standardKey = new Uint8Array(key);
    return await crypto.subtle.importKey(
        'raw',
        standardKey,
        { name: 'AES-GCM' },
        false,
        [usage === 'encrypt' ? 'encrypt' : 'decrypt']
    );
}

/**
 * Derives a 32-byte key from entropy.
 * CRITICAL FIX: Must be async because @noble/hashes scrypt is async.
 */
async function deriveKey(encryptionKey: string): Promise<Uint8Array> {
    // Use same parameters as Node's default scryptSync (N=16384, r=8, p=1)
    return await scrypt(encryptionKey, 'payroll-salt', { 
        N: 16384, 
        r: 8, 
        p: 1, 
        dkLen: 32 
    });
}

/**
 * Encrypts sensitive payroll data using AES-256-GCM.
 * Works in both Node.js and browser environments.
 */
export async function encryptPayrollData(
    data: Record<string, any>, 
    encryptionKey: string
): Promise<EncryptedData> {
    const iv = getRandomBytes(12);
    const key = await deriveKey(encryptionKey);  // CRITICAL: Added await
    
    // Convert to standard Uint8Array for Web Crypto API
    const standardKey = new Uint8Array(key);
    const standardIv = new Uint8Array(iv);
    
    const cryptoKey = await getWebCryptoKey(key, 'encrypt');
    const plaintext = new TextEncoder().encode(JSON.stringify(data));
    
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: standardIv },
        cryptoKey,
        plaintext
    );
    
    // Extract ciphertext and tag (last 16 bytes are the auth tag)
    const encryptedBytes = new Uint8Array(encrypted);
    const ciphertext = encryptedBytes.slice(0, -16);
    const tag = encryptedBytes.slice(-16);
    
    return { 
        iv: Buffer.from(iv).toString('hex'), 
        content: Buffer.from(ciphertext).toString('hex'), 
        tag: Buffer.from(tag).toString('hex'), 
        version: '1.0' 
    };
}

/**
 * Decrypts payroll data using AES-256-GCM.
 * Works in both Node.js and browser environments.
 */
export async function decryptPayrollData(
    encrypted: EncryptedData,
    encryptionKey: string
): Promise<Record<string, any>> {
    const key = await deriveKey(encryptionKey);  // CRITICAL: Added await
    const iv = Buffer.from(encrypted.iv, 'hex');
    const tag = Buffer.from(encrypted.tag, 'hex');
    const ciphertext = Buffer.from(encrypted.content, 'hex');
    
    // Convert to standard Uint8Array for Web Crypto API
    const standardKey = new Uint8Array(key);
    const standardIv = new Uint8Array(iv);
    const standardTag = new Uint8Array(tag);
    const standardCiphertext = new Uint8Array(ciphertext);
    
    // Combine ciphertext and tag for Web Crypto API
    const encryptedData = new Uint8Array(standardCiphertext.length + standardTag.length);
    encryptedData.set(standardCiphertext, 0);
    encryptedData.set(standardTag, standardCiphertext.length);
    
    const cryptoKey = await getWebCryptoKey(key, 'decrypt');
    
    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: standardIv },
        cryptoKey,
        encryptedData
    );
    
    const decryptedText = new TextDecoder().decode(decrypted);
    return JSON.parse(decryptedText);
}

// Keep sync versions for backend compatibility (using Node.js crypto)
// These will be used by the backend where Node crypto is available
let nodeCrypto: any = null;
if (typeof window === 'undefined') {
    nodeCrypto = require('crypto');
}

export function encryptPayrollDataSync(data: Record<string, any>, encryptionKey: string): EncryptedData {
    if (!nodeCrypto) {
        throw new Error('encryptPayrollDataSync only available in Node.js environment');
    }
    const iv = nodeCrypto.randomBytes(12);
    // For sync version, we need to use sync scrypt - but Node's crypto.scryptSync is used
    // This is a fallback - in practice backend uses this function
    const key = Buffer.from(require('crypto').scryptSync(encryptionKey, 'payroll-salt', 32));
    const cipher = nodeCrypto.createCipheriv('aes-256-gcm', key, iv);
    const plaintext = JSON.stringify(data);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return {
        iv: iv.toString('hex'),
        content: encrypted,
        tag: tag.toString('hex'),
        version: '1.0'
    };
}

export function decryptPayrollDataSync(encrypted: EncryptedData, encryptionKey: string): Record<string, any> {
    if (!nodeCrypto) {
        throw new Error('decryptPayrollDataSync only available in Node.js environment');
    }
    const key = Buffer.from(require('crypto').scryptSync(encryptionKey, 'payroll-salt', 32));
    const iv = Buffer.from(encrypted.iv, 'hex');
    const tag = Buffer.from(encrypted.tag, 'hex');
    const decipher = nodeCrypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(encrypted.content, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return JSON.parse(decrypted);
}