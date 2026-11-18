/** Digits only, so codes sort and group the way accountants expect (1000 Assets, 1200 Bank accounts). */
export const ACCOUNT_CODE_PATTERN = /^\d{3,10}$/;

export const ACCOUNT_CODE_MESSAGE = 'must be 3 to 10 digits';
