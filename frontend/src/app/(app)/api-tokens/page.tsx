'use client';

import { useState } from 'react';
import { ConfirmDialog } from '@/components/Dialog';
import { Card, Loaded, PageHead, Pagination, Pill } from '@/components/ui';
import { disconnectAppInScope, listApiTokensInScope, listConnectedAppsInScope, revokeApiTokenInScope } from '@/lib/api/apiAccess';
import type { OwnedApiToken, OwnedConnectedApp } from '@/lib/api/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const PAGE_SIZE = 20;
const REVOKE_PERMISSION = 'apiToken.delete';

function isActive(token: OwnedApiToken): boolean {
  return !token.revokedAt && !(token.expiresAt && new Date(token.expiresAt) <= new Date());
}

/**
 * Everyone's API tokens and connected apps that the viewer's apiToken.read scope reaches, so an admin can find and
 * stop a credential when someone leaves or a token leaks. Revoking needs apiToken.delete.
 */
export default function ApiTokensAdminPage() {
  const { can } = useSession();
  const canRevoke = can(REVOKE_PERMISSION);
  const [tokenPage, setTokenPage] = useState(1);
  const [appPage, setAppPage] = useState(1);
  const [revoking, setRevoking] = useState<OwnedApiToken | null>(null);
  const [disconnecting, setDisconnecting] = useState<OwnedConnectedApp | null>(null);

  const tokens = useLoad(() => listApiTokensInScope(tokenPage, PAGE_SIZE), [tokenPage]);
  const apps = useLoad(() => listConnectedAppsInScope(appPage, PAGE_SIZE), [appPage]);

  return (
    <>
      <PageHead title="API tokens" subtitle="Tokens and connected apps of the people your access reaches. Each acts as its owner, with their access." />
      <Card title="Personal API tokens">
        <Loaded state={tokens}>
          {({ tokens: rows, total }) => rows.length === 0 ? <p className="empty">No tokens.</p> : (
            <>
              <div className="table-box">
                <table>
                  <thead><tr><th scope="col">Owner</th><th scope="col">Name</th><th scope="col">Starts with</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">State</th><th scope="col"><span className="visually-hidden">Revoke</span></th></tr></thead>
                  <tbody>
                    {rows.map((token) => (
                      <tr key={token.id}>
                        <td className="strong">{token.owner.name}</td>
                        <td>{token.name}</td>
                        <td><code>{token.prefix}…</code></td>
                        <td>{token.lastUsedAt ? formatTime(token.lastUsedAt) : 'Never'}</td>
                        <td>{token.expiresAt ? formatTime(token.expiresAt) : 'Never'}</td>
                        <td><Pill tone={isActive(token) ? 'good' : 'neutral'}>{token.revokedAt ? 'Revoked' : isActive(token) ? 'Active' : 'Expired'}</Pill></td>
                        <td>{canRevoke && isActive(token) ? <button type="button" className="link" onClick={() => setRevoking(token)}>Revoke</button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination page={tokenPage} pageSize={PAGE_SIZE} total={total} onChange={setTokenPage} />
            </>
          )}
        </Loaded>
      </Card>
      <div className="spaced">
        <Card title="Connected apps">
          <Loaded state={apps}>
            {({ apps: rows, total }) => rows.length === 0 ? <p className="empty">No connected apps.</p> : (
              <>
                <ul className="result-list">
                  {rows.map((app) => (
                    <li key={app.id}>
                      <span>
                        <span className="strong">{app.clientName}</span>
                        <span className="meta"> · {app.owner.name} · connected {formatTime(app.createdAt)}{app.lastUsedAt ? `, last used ${formatTime(app.lastUsedAt)}` : ''}</span>
                      </span>
                      {canRevoke ? <button type="button" className="link" onClick={() => setDisconnecting(app)}>Disconnect</button> : null}
                    </li>
                  ))}
                </ul>
                <Pagination page={appPage} pageSize={PAGE_SIZE} total={total} onChange={setAppPage} />
              </>
            )}
          </Loaded>
        </Card>
      </div>

      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.owner.name}'s token "${revoking.name}"?`}
          text="Anything using it stops working at once. This can't be undone."
          confirmLabel="Revoke"
          isDanger
          onClose={() => setRevoking(null)}
          onConfirm={async () => { await revokeApiTokenInScope(revoking.id); tokens.reload(); }}
        />
      ) : null}
      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.clientName} for ${disconnecting.owner.name}?`}
          text="It stops working at once. They can connect it again only if their profile allows it."
          confirmLabel="Disconnect"
          isDanger
          onClose={() => setDisconnecting(null)}
          onConfirm={async () => { await disconnectAppInScope(disconnecting.id); apps.reload(); }}
        />
      ) : null}
    </>
  );
}
