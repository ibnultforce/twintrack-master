import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const FORMAT_VERSION = 'v1';

/** Encrypts secrets that must be read back later. Anything that only needs checking should be hashed instead. */
export interface SecretCipher {
  encrypt(plainText: string): string;
  decrypt(stored: string): string;
}

/**
 * AES-256-GCM, which also detects a changed value. Each value gets its own random IV, and is stored as
 * "v1:iv:tag:ciphertext" in base64url, so the format can change later without losing old values.
 */
export function createSecretCipher(key: Buffer): SecretCipher {
  if (key.length !== 32) throw new Error('The encryption key must be 32 bytes.');
  return {
    encrypt(plainText) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      return [FORMAT_VERSION, iv, cipher.getAuthTag(), encrypted].map((part) => (Buffer.isBuffer(part) ? part.toString('base64url') : part)).join(':');
    },
    decrypt(stored) {
      const [version, iv, tag, encrypted] = stored.split(':');
      if (version !== FORMAT_VERSION || !iv || !tag || encrypted === undefined) throw new Error('This value was not encrypted by this app.');
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}
