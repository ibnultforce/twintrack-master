import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 12;
// Hashing is slow by design, so very long input could be used to overload the server.
export const MAX_PASSWORD_LENGTH = 256;

let unmatchablePasswordHash: Promise<string> | undefined;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/**
 * Checks a password. With no stored hash it still does the same work and returns false, so response
 * time doesn't reveal whether an email address has an account.
 */
export async function isPasswordCorrect(password: string, storedHash: string | undefined): Promise<boolean> {
  unmatchablePasswordHash ??= hash(randomBytes(32).toString('hex'));
  const hashToCheck = storedHash ?? (await unmatchablePasswordHash);
  const isMatch = await verify(hashToCheck, password);
  return storedHash !== undefined && isMatch;
}
