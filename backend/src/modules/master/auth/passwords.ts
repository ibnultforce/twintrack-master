import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

export const MIN_PASSWORD_LENGTH = 8;
// Hashing is slow by design, so very long input could be used to overload the server.
export const MAX_PASSWORD_LENGTH = 256;

let unmatchablePasswordHash: Promise<string> | undefined;

const TEMPORARY_PASSWORD_BYTES = 12;

export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

/** A random password for an admin to pass on once. The person must replace it before they can do anything else. */
export function generateTemporaryPassword(): string {
  return `tmp-${randomBytes(TEMPORARY_PASSWORD_BYTES).toString('base64url')}`;
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
