import crypto from 'crypto';

export interface EncryptedData {
  iv: string;
  content: string;
  tag: string;
  version: '1.0';
}

/**
 * Encrypts sensitive payroll data using AES-256-GCM.
 * Key should be derived from employer's wallet seed in production.
 */
export function encryptPayrollData(
  data: Record<string, any>, 
  encryptionKey: string  // In production: derived from wallet seed
): EncryptedData {
  // Generate random 12-byte IV for GCM
  const iv = crypto.randomBytes(12);
  
  // Derive 32-byte key using scrypt (adds salt for KDF)
  // For MVP, simple hash is acceptable
  const key = crypto.scryptSync(encryptionKey, 'payroll-salt', 32);
  
  // Create cipher
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  
  // Encrypt the JSON string
  const plaintext = JSON.stringify(data);
  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  // Get authentication tag
  const tag = cipher.getAuthTag();
  
  return {
    iv: iv.toString('hex'),
    content: encrypted,
    tag: tag.toString('hex'),
    version: '1.0'
  };
}

/**
 * Decrypt payroll data (for HR dashboard)
 */
export function decryptPayrollData(
  encrypted: EncryptedData,
  encryptionKey: string
): Record<string, any> {
  const key = crypto.scryptSync(encryptionKey, 'payroll-salt', 32);
  const iv = Buffer.from(encrypted.iv, 'hex');
  const tag = Buffer.from(encrypted.tag, 'hex');
  
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  
  let decrypted = decipher.update(encrypted.content, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return JSON.parse(decrypted);
}