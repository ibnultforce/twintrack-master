const LOCALE = 'en-GB';

/** "Friday, 6 November 2026" */
export function formatLongDate(date: Date): string {
  return date.toLocaleDateString(LOCALE, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

/** "6 Nov, 14:20" */
export function formatDateTime(isoDate: string): string {
  const date = new Date(isoDate);
  const day = date.toLocaleDateString(LOCALE, { day: 'numeric', month: 'short' });
  const time = date.toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return `${day}, ${time}`;
}

/** "Rahim Uddin" becomes "RU". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return `${first}${last}`.toUpperCase();
}

/** Turns stored keys into words: "people-ops" becomes "People ops". */
export function humanizeKey(key: string | undefined): string {
  if (!key) return '·';
  const words = key.replace(/[-_.]/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Shows only the network part of an address, as the portal designs do: "103.44.x.x". */
export function maskIpAddress(ipAddress: string | undefined): string {
  if (!ipAddress) return '·';
  const parts = ipAddress.split('.');
  return parts.length === 4 ? `${parts[0]}.${parts[1]}.x.x` : 'Hidden';
}
