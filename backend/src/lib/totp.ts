import { createHmac } from 'node:crypto';

/** Time-based one-time passwords (RFC 6238), the six-digit codes authenticator apps show. */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const CODE_DIGITS = 6;

/**
 * The base32 secret from what someone pastes: an otpauth:// link from a QR code, or the secret itself with any
 * spaces. Null when it's neither.
 */
export function parseOtpSecret(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.toLowerCase().startsWith('otpauth://')) {
    if (!URL.canParse(trimmed)) return null;
    const secret = new URL(trimmed).searchParams.get('secret');
    return secret ? parseOtpSecret(secret) : null;
  }
  const compact = trimmed.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  return compact.length >= 16 && [...compact].every((character) => BASE32_ALPHABET.includes(character)) ? compact : null;
}

function decodeBase32(secret: string): Buffer {
  let bits = '';
  for (const character of secret) bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, '0');
  const bytes = bits.match(/.{8}/g) ?? [];
  return Buffer.from(bytes.map((byte) => Number.parseInt(byte, 2)));
}

/** The code for a moment, and how many seconds it stays valid. */
export function totpCode(secret: string, now = Date.now()): { code: string; secondsRemaining: number } {
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', decodeBase32(secret)).update(counterBytes).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  const code = String(binary % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
  return { code, secondsRemaining: STEP_SECONDS - (Math.floor(now / 1000) % STEP_SECONDS) };
}
