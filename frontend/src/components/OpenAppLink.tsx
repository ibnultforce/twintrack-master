import Link from 'next/link';

/**
 * Opens a module's frontend. A module that takes a one-time sign-in code goes through /open/<key>, which signs the
 * person in to it; any other goes straight to its address, sharing the portal's cookie.
 */
export function OpenAppLink({ module, label, isPrimary = false }: {
  module: { key: string; frontendUrl: string | null; signsInWithCode: boolean };
  label: string;
  isPrimary?: boolean;
}) {
  const className = isPrimary ? 'btn btn-primary' : 'btn';
  if (module.signsInWithCode) return <Link className={className} href={`/open/${encodeURIComponent(module.key)}`}>{label}</Link>;
  if (!module.frontendUrl) return null;
  return <a className={className} href={module.frontendUrl}>{label}</a>;
}
