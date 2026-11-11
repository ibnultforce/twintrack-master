/**
 * Where to go after signing in, from a ?next= value. Only paths on this site are followed, so a crafted link can't send
 * someone to another site straight after they enter their password.
 */
export function safeNextPath(next: string | null, fallback = '/modules'): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
