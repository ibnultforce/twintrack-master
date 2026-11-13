/** Words that say what kind of company it is, not which one, so they don't make initials. */
const GENERIC_SUFFIXES = new Set(['corp', 'corporation', 'inc', 'incorporated', 'llc', 'ltd', 'limited', 'co', 'company', 'group', 'plc', 'gmbh']);
const FALLBACK_INITIALS = 'CL';

/** Initials for a client with none set: the first letters of its first two meaningful words, such as MW for Momentum Worldwide Corp. */
export function deriveClientInitials(clientName: string): string {
  const words = clientName.split(/\s+/).filter(Boolean);
  const meaningful = words.filter((word) => !GENERIC_SUFFIXES.has(word.toLowerCase().replace(/[.,]/g, '')));
  const source = meaningful.length > 0 ? meaningful : words;
  const initials = source
    .slice(0, 2)
    .map((word) => word.replace(/[^A-Za-z0-9]/g, '')[0]?.toUpperCase() ?? '')
    .join('');
  return initials || FALLBACK_INITIALS;
}

const twoDigits = (value: number) => String(value).padStart(2, '0');

/**
 * An invoice number such as INV-MW-02-10-26: the prefix, the client's initials, and the date as day, month and
 * two-digit year. The nth invoice for a client on one day gets -n added, from the second on.
 */
export function invoiceNumberFor(prefix: string, initials: string, date: Date, sameDayCount: number): string {
  const base = `${prefix}-${initials}-${twoDigits(date.getUTCDate())}-${twoDigits(date.getUTCMonth() + 1)}-${String(date.getUTCFullYear()).slice(-2)}`;
  return sameDayCount <= 1 ? base : `${base}-${sameDayCount}`;
}
