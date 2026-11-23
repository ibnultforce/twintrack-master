/** Digits only, so codes sort and group the way accountants expect (1000 Assets, 1200 Bank accounts). */
export const ACCOUNT_CODE_PATTERN = /^\d{3,10}$/;

export const ACCOUNT_CODE_MESSAGE = 'must be 3 to 10 digits';

const SHOWN_DIGITS = 4;

/**
 * A bank account number as screens and files show it: "•••• 7712". The full number is sent only by the reveal route,
 * which writes an activity log entry, so every look at a full number can be traced.
 */
export function maskBankAccountNumber(number: string): string {
  const characters = number.replace(/[\s-]/g, '');
  return `•••• ${characters.slice(-SHOWN_DIGITS)}`;
}

/** Masks a history value that may be a bank number; anything else, such as a removed number, passes unchanged. */
export const maskIfBankNumber = (value: unknown) => (typeof value === 'string' ? maskBankAccountNumber(value) : value);
