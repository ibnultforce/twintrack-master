'use client';

import { useState, type FormEvent } from 'react';
import { Dialog } from '@/components/Dialog';
import { describeConnectionProblem, tryApiRequest, type TryResult } from '@/lib/api/http';
import type { ApiExample, ApiGuide } from '@/lib/api/types';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
const METHODS_WITH_BODY = new Set<Method>(['POST', 'PUT', 'PATCH']);
const PATH_PARAMETER = /:([A-Za-z]\w*)/g;

/** Splits "PATCH /hr/salaries/:id" into its method, path and the names of its path parameters. */
function parseApi(api: string): { method: Method; path: string; parameters: string[] } {
  const [method, path = ''] = api.split(' ') as [Method, string];
  return { method, path, parameters: [...path.matchAll(PATH_PARAMETER)].map((match) => match[1]!) };
}

/** Puts the filled-in parameters into the path, each encoded, and adds the query text if there is any. */
function buildPath(path: string, values: Record<string, string>, query: string): string {
  const filled = path.replace(PATH_PARAMETER, (_match, name: string) => encodeURIComponent(values[name] ?? ''));
  const queryText = query.trim().replace(/^\?/, '');
  return queryText ? `${filled}?${queryText}` : filled;
}

const statusTone = (status: number) => (status < 300 ? 'good' : status < 500 ? 'warning' : 'danger');
const COPIED_MESSAGE_MS = 2000;

/** The answer as it's shown, so what's copied matches what's on screen. */
const responseText = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body, null, 2));

/** Copies the response to the clipboard, and says so for a moment. */
function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      // The clipboard can be refused, such as on a page not served over HTTPS or localhost.
      setState('failed');
    }
    setTimeout(() => setState('idle'), COPIED_MESSAGE_MS);
  };
  const label = state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy';
  return (
    <button type="button" className="btn btn-small copy-button" onClick={() => void copy()} aria-live="polite">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {state === 'copied' ? <path d="M20 6 9 17l-5-5" /> : <><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>}
      </svg>
      {label}
    </button>
  );
}

/** The answer a sample expects, such as "201" or "403 out_of_scope". */
const expectedAnswer = (example: ApiExample) => `${example.expectedStatus}${example.expectedCode ? ` ${example.expectedCode}` : ''}`;

/** Sample requests to fill the form from, each saying what the API should answer and who sends it in the example data. */
function SampleList({ examples, chosen, onChoose }: { examples: ApiExample[]; chosen: ApiExample | null; onChoose: (example: ApiExample) => void }) {
  return (
    <div className="field">
      <span className="label-text">Samples</span>
      <ul className="try-samples">
        {examples.map((example) => (
          <li key={example.title}>
            <button type="button" className="try-sample" aria-pressed={example === chosen} onClick={() => onChoose(example)}>
              <span className={`try-status ${example.outcome === 'accepted' ? 'good' : 'warning'}`}>{expectedAnswer(example)}</span>
              <span>{example.title}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** What the chosen sample needs and expects, so a different answer when sent as yourself makes sense. */
function SampleNotes({ example }: { example: ApiExample }) {
  return (
    <div className="try-sample-notes">
      <p>
        Expected: <span className={`try-status ${example.outcome === 'accepted' ? 'good' : 'warning'}`}>{expectedAnswer(example)}</span>
        {example.sentBy ? <> when {example.sentBy} sends it in the example data. Sent as you, your own access decides.</> : null}
      </p>
      {example.sendFirst.length > 0 ? (
        <p>The example sends first: {example.sendFirst.map((step, index) => <span key={`${step}-${index}`}>{index > 0 ? ', then ' : ''}<code>{step}</code></span>)}.</p>
      ) : null}
      {example.needs.length > 0 ? (
        <p>Fill in first: {example.needs.map((need, index) => (
          <span key={need.value}>{index > 0 ? ', ' : ''}<code>{need.value}</code> from <code>{need.madeBy}</code></span>
        ))}.</p>
      ) : null}
      {example.changesData ? <p>This sample changes data.</p> : null}
    </div>
  );
}

/**
 * Sends one API as the signed-in person, with their own access token, and shows the answer. Requests run for real,
 * so a change it makes is saved. Samples from the API's tested scenarios can fill the form.
 */
export function ApiTryDialog({ api, permission, guide, onClose }: { api: string; permission: string; guide?: ApiGuide; onClose: () => void }) {
  const { method, path, parameters } = parseApi(api);
  const hasBody = METHODS_WITH_BODY.has(method);
  const [values, setValues] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [bodyText, setBodyText] = useState(hasBody ? '{\n  \n}' : '');
  const [result, setResult] = useState<TryResult | null>(null);
  const [problem, setProblem] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [chosen, setChosen] = useState<ApiExample | null>(null);

  const applySample = (example: ApiExample) => {
    setChosen(example);
    setValues(example.parameters);
    setQuery(example.query);
    if (hasBody) setBodyText(example.body || '{\n  \n}');
    setResult(null);
    setProblem('');
  };

  const missing = parameters.filter((name) => !values[name]?.trim());
  const finalPath = buildPath(path, values, query);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setProblem('');
    let body: unknown;
    if (hasBody && bodyText.trim()) {
      try {
        body = JSON.parse(bodyText);
      } catch {
        setProblem('The body isn\'t valid JSON.');
        return;
      }
    }
    setIsSending(true);
    try {
      setResult(await tryApiRequest(method, finalPath, body));
    } catch {
      setProblem(describeConnectionProblem());
    } finally {
      setIsSending(false);
    }
  };

  return (
    <Dialog title={`Try ${api}`} onClose={onClose}>
      <form className="form" onSubmit={(event) => void send(event)}>
        <p className="note">Opened by <code>{permission}</code>. This sends a real request with your access, so anything it changes is saved.</p>
        {guide?.purpose ? <p>{guide.purpose}{guide.input ? <span className="meta"> Takes: {guide.input}.</span> : null}</p> : null}
        {guide && guide.examples.length > 0 ? <SampleList examples={guide.examples} chosen={chosen} onChoose={applySample} /> : null}
        {chosen ? <SampleNotes example={chosen} /> : null}
        {parameters.map((name) => (
          <div className="field" key={name}>
            <label htmlFor={`try-${name}`}>{name}</label>
            <input className="input" id={`try-${name}`} autoComplete="off" required value={values[name] ?? ''} onChange={(event) => setValues({ ...values, [name]: event.target.value })} />
          </div>
        ))}
        <div className="field">
          <label htmlFor="try-query">Query, optional</label>
          <input className="input" id="try-query" autoComplete="off" placeholder="page=1&pageSize=5" value={query} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {hasBody ? (
          <div className="field">
            <label htmlFor="try-body">JSON body</label>
            <textarea className="input try-body" id="try-body" spellCheck={false} rows={7} value={bodyText} onChange={(event) => setBodyText(event.target.value)} />
          </div>
        ) : null}
        <p className="try-request"><span className="try-method">{method}</span> <code>{finalPath}</code></p>
        {problem ? <p className="field-error">{problem}</p> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Close</button>
          <button type="submit" className="btn btn-primary" disabled={isSending || missing.length > 0}>{isSending ? 'Sending…' : 'Send request'}</button>
        </div>
      </form>
      {result ? (
        <div className="try-result">
          <div className="try-result-head">
            <p><span className={`try-status ${statusTone(result.status)}`}>{result.status}</span> <span className="meta">in {result.durationMs} ms</span></p>
            {result.body === null ? null : <CopyButton text={responseText(result.body)} />}
          </div>
          {result.body === null ? <p className="meta">No body.</p> : <pre className="try-response">{responseText(result.body)}</pre>}
        </div>
      ) : null}
    </Dialog>
  );
}
