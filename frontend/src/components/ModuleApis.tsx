'use client';

import { useState } from 'react';
import type { ModuleAccess, Scope } from '@/lib/api/types';
import { humanize, SCOPE_LABELS } from '@/lib/format';
import { Pill, Tabs } from './ui';

const SCOPE_TONES = { own: 'neutral', team: 'warning', all: 'accent' } as const;

interface ApiLine {
  api: string;
  method: string;
  path: string;
  permission: string;
  scope: Scope;
}

interface RecordGroup {
  resource: string;
  apis: ApiLine[];
  /** Permissions held here that no API names, because a service checks them. */
  withoutApi: { permission: string; scope: Scope }[];
  /** The widest reach among this record's permissions, for its heading. */
  widestScope: Scope;
}

const SCOPE_ORDER: Scope[] = ['own', 'team', 'all'];

/** Groups a module's permissions by record, listing each API once under the permission that opens it. */
function groupByRecord(access: ModuleAccess): RecordGroup[] {
  const groups = new Map<string, RecordGroup>();
  for (const [permission, scope] of Object.entries(access.permissions)) {
    const resource = permission.slice(0, permission.lastIndexOf('.'));
    const group = groups.get(resource) ?? { resource, apis: [], withoutApi: [], widestScope: scope };
    if (SCOPE_ORDER.indexOf(scope) > SCOPE_ORDER.indexOf(group.widestScope)) group.widestScope = scope;
    const apis = access.apis[permission] ?? [];
    if (apis.length === 0) group.withoutApi.push({ permission, scope });
    for (const api of apis) {
      const [method = '', path = ''] = api.split(' ');
      group.apis.push({ api, method, path, permission, scope });
    }
    groups.set(resource, group);
  }
  return [...groups.values()];
}

/** Whether the person being tested may call an API, shown beside each one. Undefined shows nothing. */
export type ApiVerdict = (permission: string) => { isAllowed: boolean; label: string } | undefined;

/**
 * One module: a tab for each object, showing that object's APIs and a Try button for each. With verdictFor, each API
 * also says whether the person being tested may call it.
 */
export function ModuleApis({ moduleKey, access, emptyMessage, onTry, verdictFor }: {
  moduleKey: string;
  access: ModuleAccess;
  emptyMessage: string;
  onTry: (api: string, permission: string) => void;
  verdictFor?: ApiVerdict;
}) {
  const purposeOf = (api: string) => access.guides?.[api]?.purpose;
  const groups = groupByRecord(access);
  const [chosen, setChosen] = useState('');
  const group = groups.find((candidate) => candidate.resource === chosen) ?? groups[0];
  if (!group) return <p className="empty">{emptyMessage}</p>;
  const tabsId = `objects-${moduleKey}`;

  return (
    <>
      <Tabs
        id={tabsId}
        label="Objects"
        value={group.resource}
        onChange={setChosen}
        options={groups.map((candidate) => ({ value: candidate.resource, label: humanize(candidate.resource), count: candidate.apis.length }))}
      />
      <section className="api-group" id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${group.resource}`}>
        <header className="api-group-head">
          <h3>{humanize(group.resource)}</h3>
          {/* While testing as someone else, each API's verdict shows their reach instead of the signed-in person's. */}
          {verdictFor ? null : <Pill tone={SCOPE_TONES[group.widestScope]}>{SCOPE_LABELS[group.widestScope]}</Pill>}
        </header>
        {group.apis.length > 0 ? (
          <ul className="api-rows">
            {group.apis.map((line) => {
              const verdict = verdictFor?.(line.permission);
              return (
              <li className={`api-row${verdictFor ? ' api-row-verdict' : ''}`} key={`${line.permission} ${line.api}`}>
                <span className={`method-badge method-${line.method.toLowerCase()}`}>{line.method}</span>
                <span className="api-what">
                  <code className="api-path">{line.path}</code>
                  {purposeOf(line.api) ? <span className="api-purpose">{purposeOf(line.api)}</span> : null}
                </span>
                <span className="api-permission" title={`Reaches: ${SCOPE_LABELS[line.scope]}`}>{line.permission}</span>
                {verdictFor ? <span className="api-verdict">{verdict ? <Pill tone={verdict.isAllowed ? 'good' : 'neutral'}>{verdict.label}</Pill> : null}</span> : null}
                <button type="button" className="btn btn-small" aria-label={`Try ${line.api}`} onClick={() => onTry(line.api, line.permission)}>Try</button>
              </li>
              );
            })}
          </ul>
        ) : <p className="meta">No API of its own.</p>}
        {group.withoutApi.length > 0 ? (
          <p className="meta api-group-extra">Also held, checked by a service rather than one API: {group.withoutApi.map((held) => held.permission).join(', ')}</p>
        ) : null}
      </section>
    </>
  );
}

