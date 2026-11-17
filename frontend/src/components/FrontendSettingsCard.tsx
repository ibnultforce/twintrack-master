'use client';

import { useState, type FormEvent } from 'react';
import { describeError } from '@/lib/api/http';
import { saveFrontendSettings } from '@/lib/api/modules';
import type { FrontendSettings } from '@/lib/api/types';
import { Dialog } from './Dialog';
import { Card, Notice, Row, TextField } from './ui';

const CALLBACK_PATH = '/auth/callback';

const toLines = (values: string[]) => values.join('\n');
const fromLines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean);

function AddressList({ values, empty }: { values: string[]; empty: string }) {
  if (values.length === 0) return <span className="muted">{empty}</span>;
  return <div>{values.map((value) => <div key={value}><code>{value}</code></div>)}</div>;
}

function FrontendSettingsDialog({ moduleKey, moduleName, settings, onSaved, onClose }: {
  moduleKey: string;
  moduleName: string;
  settings: FrontendSettings;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [frontendUrl, setFrontendUrl] = useState(settings.frontendUrl ?? '');
  const [redirectText, setRedirectText] = useState(toLines(settings.redirectUrls));
  const [originsText, setOriginsText] = useState(toLines(settings.allowedOrigins));
  const [error, setError] = useState('');

  const exampleAddress = `https://${moduleKey}.twintrack.com`;
  const suggestedRedirect = frontendUrl.trim() ? `${frontendUrl.trim().replace(/\/+$/, '')}${CALLBACK_PATH}` : null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await saveFrontendSettings(moduleKey, {
        frontendUrl: frontendUrl.trim() || null,
        redirectUrls: fromLines(redirectText),
        allowedOrigins: fromLines(originsText),
      });
      onSaved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={`${moduleName} sign-in`} size="wide" onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <TextField
          id="frontend-url"
          label="Frontend address"
          value={frontendUrl}
          onChange={setFrontendUrl}
          placeholder={exampleAddress}
          hint="Where Open sends people. Leave empty to use MODULE_FRONTEND_URLS."
        />
        <div className="field">
          <label htmlFor="redirect-urls">Redirect URLs</label>
          <textarea className="input" id="redirect-urls" rows={3} spellCheck={false} placeholder={`${exampleAddress}${CALLBACK_PATH}
http://localhost:3000${CALLBACK_PATH}`} value={redirectText} onChange={(event) => setRedirectText(event.target.value)} />
          <span className="hint">
            One per line. Where one-time sign-in codes may be sent; the first is the default. Each must be on the frontend address or an allowed origin.
            {suggestedRedirect && !fromLines(redirectText).includes(suggestedRedirect) ? (
              <> <button type="button" className="link" onClick={() => setRedirectText(toLines([...fromLines(redirectText), suggestedRedirect]))}>Add {suggestedRedirect}</button></>
            ) : null}
          </span>
        </div>
        <div className="field">
          <label htmlFor="allowed-origins">Allowed origins</label>
          <textarea className="input" id="allowed-origins" rows={3} spellCheck={false} placeholder={`http://localhost:3000
https://${moduleKey}-staging.twintrack.com`} value={originsText} onChange={(event) => setOriginsText(event.target.value)} />
          <span className="hint">One per line. Pages on these addresses may call the API, on top of ALLOWED_ORIGINS. The frontend address is always allowed.</span>
        </div>
        <Notice tone="warning">Whoever controls a redirect URL receives people&apos;s sign-ins. Add only addresses you run.</Notice>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Dialog>
  );
}

/** A module's frontend address, redirect URLs and allowed origins. Only a super admin can change them. */
export function FrontendSettingsCard({ moduleKey, moduleName, settings, canChange, onChanged }: {
  moduleKey: string;
  moduleName: string;
  settings: FrontendSettings;
  canChange: boolean;
  onChanged: () => void;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const source = settings.frontendUrlSource === 'environment' ? ' (from MODULE_FRONTEND_URLS)' : '';

  return (
    <Card title="Sign-in" aside={canChange ? <button type="button" className="link" onClick={() => setIsEditing(true)}>Edit</button> : undefined}>
      <Row label="Frontend address">{settings.frontendUrl ? <><code>{settings.frontendUrl}</code><span className="muted">{source}</span></> : <span className="muted">Not set</span>}</Row>
      <Row label="Redirect URLs"><AddressList values={settings.redirectUrls} empty="None: Open goes straight to the frontend address" /></Row>
      <Row label="Allowed origins"><AddressList values={settings.allowedOrigins} empty="Only ALLOWED_ORIGINS and the frontend address" /></Row>
      {isEditing ? <FrontendSettingsDialog moduleKey={moduleKey} moduleName={moduleName} settings={settings} onSaved={onChanged} onClose={() => setIsEditing(false)} /> : null}
    </Card>
  );
}
