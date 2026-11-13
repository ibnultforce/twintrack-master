'use client';

import type { PersonTryResult } from '@/lib/api/users';

export const statusTone = (status: number) => (status < 300 ? 'good' : status < 500 ? 'warning' : 'danger');
/** The answer as it's shown, so what's copied matches what's on screen. */
export const responseText = (body: unknown) => (typeof body === 'string' ? body : JSON.stringify(body, null, 2));

/** A short reason for a refusal, such as "out_of_scope", read from the API's error answer. */
function refusalCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || !('error' in body)) return undefined;
  const error = (body as { error?: { code?: unknown } }).error;
  return typeof error?.code === 'string' ? error.code : undefined;
}

/**
 * The same request's answer for each person, in the order they were sent, with a count of each status. Each row
 * opens to show that person's full response.
 */
export function EveryoneResults({ answers, total, isRunning }: { answers: PersonTryResult[]; total: number; isRunning: boolean }) {
  const counts = new Map<string, number>();
  for (const answer of answers) {
    const label = answer.result ? String(answer.result.status) : 'not sent';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }

  return (
    <div className="try-result">
      <div className="try-result-head">
        <p>
          <b>{answers.length} of {total}</b> people{isRunning ? ' so far…' : ''}
          {[...counts].map(([label, count]) => (
            <span key={label} className={`try-status ${label === 'not sent' ? 'danger' : statusTone(Number(label))} everyone-count`}>{label} × {count}</span>
          ))}
        </p>
      </div>
      <ul className="everyone-results">
        {answers.map(({ person, result, problem }) => (
          <li key={person.id}>
            <details>
              <summary>
                {result
                  ? <span className={`try-status ${statusTone(result.status)}`}>{result.status}</span>
                  : <span className="try-status danger">Not sent</span>}
                <span className="strong">{person.name}</span>
                <span className="meta">{person.email}</span>
                <span className="meta everyone-detail">{result ? refusalCode(result.body) ?? `${result.durationMs} ms` : problem}</span>
              </summary>
              {result && result.body !== null ? <pre className="try-response">{responseText(result.body)}</pre> : <p className="meta">No body.</p>}
            </details>
          </li>
        ))}
      </ul>
    </div>
  );
}
