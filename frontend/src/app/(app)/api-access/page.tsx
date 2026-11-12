'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmDialog, OneTimeSecretDialog } from '@/components/Dialog';
import { Card, Loaded, Notice, PageHead, Pill, TextField } from '@/components/ui';
import { createMyApiToken, disconnectApp, listMyApiTokens, listMyConnectedApps, revokeMyApiToken } from '@/lib/api/apiAccess';
import { describeError } from '@/lib/api/http';
import type { ApiToken, ConnectedApp } from '@/lib/api/types';
import { formatTime } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const CREATE_TOKEN_PERMISSION = 'apiToken.create';
const EXPIRY_CHOICES = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: 'A year' },
  { value: '', label: 'Never' },
];

function tokenState(token: ApiToken): { tone: 'good' | 'neutral' | 'danger'; label: string } {
  if (token.revokedAt) return { tone: 'neutral', label: 'Revoked' };
  if (token.expiresAt && new Date(token.expiresAt) <= new Date()) return { tone: 'danger', label: 'Expired' };
  return { tone: 'good', label: 'Active' };
}

function NewTokenForm({ onCreated }: { onCreated: (token: string) => void }) {
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const created = await createMyApiToken(name.trim(), expiresInDays ? Number(expiresInDays) : undefined);
      setName('');
      onCreated(created.token);
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <TextField id="token-name" label="What it's for" hint="Such as Claude Code on my laptop." required value={name} onChange={setName} />
      <div className="field">
        <label htmlFor="token-expiry">Expires after</label>
        <select className="input" id="token-expiry" value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)}>
          {EXPIRY_CHOICES.map((choice) => <option key={choice.label} value={choice.value}>{choice.label}</option>)}
        </select>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      <div><button type="submit" className="btn btn-primary" disabled={!name.trim()}>Make token</button></div>
    </form>
  );
}

/** Personal API tokens for tools such as Claude Code, and apps connected over OAuth, such as claude.ai. */
export default function ApiAccessPage() {
  const profile = useProfile();
  const { can } = useSession();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [disconnecting, setDisconnecting] = useState<ConnectedApp | null>(null);

  const access = useLoad(async () => {
    const [tokens, apps] = await Promise.all([listMyApiTokens(), listMyConnectedApps()]);
    return { tokens, apps };
  }, []);

  return (
    <>
      <PageHead title="Apps and API tokens" subtitle="Everything here acts as you, with exactly your access, which is checked on every call." />
      {profile.impersonatedBy ? <Notice tone="warning">You are signed in as someone else, so you can look but can&apos;t make tokens for them.</Notice> : null}
      <Loaded state={access}>
        {({ tokens, apps }) => (
          <div className="pair">
            <Card title="Personal API tokens">
              <p className="note">For tools such as Claude Code. Add TwinTrack as an MCP server at <code>{API_URL}/mcp</code>, with the token as a bearer token.</p>
              {tokens.length === 0 ? <p className="empty">No tokens yet.</p> : (
                <div className="table-box">
                  <table>
                    <thead><tr><th scope="col">Name</th><th scope="col">Starts with</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">State</th><th scope="col"><span className="visually-hidden">Revoke</span></th></tr></thead>
                    <tbody>
                      {tokens.map((token) => {
                        const state = tokenState(token);
                        return (
                          <tr key={token.id}>
                            <td className="strong">{token.name}</td>
                            <td><code>{token.prefix}…</code></td>
                            <td>{token.lastUsedAt ? formatTime(token.lastUsedAt) : 'Never'}</td>
                            <td>{token.expiresAt ? formatTime(token.expiresAt) : 'Never'}</td>
                            <td><Pill tone={state.tone}>{state.label}</Pill></td>
                            <td>{state.label === 'Active' ? <button type="button" className="link" onClick={() => setRevoking(token)}>Revoke</button> : null}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="spaced">
                {can(CREATE_TOKEN_PERMISSION) ? (
                  <NewTokenForm onCreated={(token) => { setNewToken(token); access.reload(); }} />
                ) : (
                  <Notice tone="warning">Your profile doesn&apos;t let you make tokens or connect apps. Ask an admin if you need API access. You can still revoke the ones you have.</Notice>
                )}
              </div>
            </Card>
            <Card title="Connected apps">
              <p className="note">Apps you allowed to connect, such as a claude.ai connector. Disconnecting one stops it at once.</p>
              {apps.length === 0 ? <p className="empty">No connected apps.</p> : (
                <ul className="result-list">
                  {apps.map((app) => (
                    <li key={app.id}>
                      <span>
                        <span className="strong">{app.clientName}</span>
                        <span className="meta"> · connected {formatTime(app.createdAt)}{app.lastUsedAt ? `, last used ${formatTime(app.lastUsedAt)}` : ''}</span>
                      </span>
                      <button type="button" className="link" onClick={() => setDisconnecting(app)}>Disconnect</button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        )}
      </Loaded>

      {newToken ? (
        <OneTimeSecretDialog title="Your new token" text="Copy it now. It won't be shown again, and anyone who has it can act as you." secret={newToken} onClose={() => setNewToken(null)} />
      ) : null}
      {revoking ? (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          text="Anything using it stops working at once. This can't be undone."
          confirmLabel="Revoke"
          isDanger
          onClose={() => setRevoking(null)}
          onConfirm={async () => { await revokeMyApiToken(revoking.id); access.reload(); }}
        />
      ) : null}
      {disconnecting ? (
        <ConfirmDialog
          title={`Disconnect ${disconnecting.clientName}?`}
          text="It stops working at once. You can connect it again from the app."
          confirmLabel="Disconnect"
          isDanger
          onClose={() => setDisconnecting(null)}
          onConfirm={async () => { await disconnectApp(disconnecting.id); access.reload(); }}
        />
      ) : null}
    </>
  );
}
