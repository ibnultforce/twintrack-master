'use client';

import { useState } from 'react';
import { ApiTryDialog } from '@/components/ApiTryDialog';
import { FIELD_LEVEL_LABELS } from '@/components/FieldAccessPanel';
import { Card, Chips, Loaded, PageHead, Pill, Tabs } from '@/components/ui';
import { getMyModuleAccess, getMyModules } from '@/lib/api/account';
import type { ApiGuide, FieldAccessMap, ModuleAccess, Scope } from '@/lib/api/types';
import { humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

const SCOPE_TONES = { own: 'neutral', team: 'warning', all: 'accent' } as const;

async function loadMyAccess() {
  const modules = await getMyModules();
  const access = await Promise.all(modules.map((module) => getMyModuleAccess(module.key)));
  return modules.map((module, index) => ({ module, access: access[index]! }));
}

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

/** Each field you can reach in a module and how far. Hidden fields are left out. Folded away until opened. */
function FieldAccessDetails({ fieldAccess }: { fieldAccess: FieldAccessMap }) {
  const visible = Object.entries(fieldAccess).filter(([, level]) => level !== 'hidden');
  if (visible.length === 0) return null;
  return (
    <details className="field-details">
      <summary>Field access · {visible.length} fields</summary>
      <div className="table-box">
        <table>
          <thead><tr><th scope="col">Record</th><th scope="col">Field</th><th scope="col">Access</th></tr></thead>
          <tbody>
            {visible.map(([key, level]) => {
              const [resource, field] = key.split('.');
              return (
                <tr key={key}>
                  <td>{humanize(resource ?? '')}</td>
                  <td>{humanize(field ?? '')}</td>
                  <td>{FIELD_LEVEL_LABELS[level]}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** One module: a tab for each object, showing that object's APIs. */
function ModuleApis({ moduleKey, access, onTry }: { moduleKey: string; access: ModuleAccess; onTry: (api: string, permission: string) => void }) {
  const groups = groupByRecord(access);
  const [chosen, setChosen] = useState('');
  const group = groups.find((candidate) => candidate.resource === chosen) ?? groups[0];
  if (!group) return <p className="empty">Your profile gives nothing in this module.</p>;
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
          <Pill tone={SCOPE_TONES[group.widestScope]}>{SCOPE_LABELS[group.widestScope]}</Pill>
        </header>
        {group.apis.length > 0 ? (
          <ul className="api-rows">
            {group.apis.map((line) => (
              <li className="api-row" key={`${line.permission} ${line.api}`}>
                <span className={`method-badge method-${line.method.toLowerCase()}`}>{line.method}</span>
                <code className="api-path">{line.path}</code>
                <span className="api-permission" title={`Reaches: ${SCOPE_LABELS[line.scope]}`}>{line.permission}</span>
                <button type="button" className="btn btn-small" aria-label={`Try ${line.api}`} onClick={() => onTry(line.api, line.permission)}>Try</button>
              </li>
            ))}
          </ul>
        ) : <p className="meta">No API of its own.</p>}
        {group.withoutApi.length > 0 ? (
          <p className="meta api-group-extra">Also held, checked by a service rather than one API: {group.withoutApi.map((held) => held.permission).join(', ')}</p>
        ) : null}
      </section>
    </>
  );
}

export default function YourPermissionsPage() {
  const access = useLoad(loadMyAccess, []);
  const [chosenModule, setChosenModule] = useState('');
  const [trying, setTrying] = useState<{ api: string; permission: string; guide?: ApiGuide } | null>(null);

  return (
    <>
      <PageHead title="Your permissions" subtitle="The APIs you can use in each module. Select Try to send one as yourself." />
      <Loaded state={access}>
        {(list) => {
          const current = list.find((entry) => entry.module.key === chosenModule) ?? list[0];
          if (!current) return <section className="card"><p className="empty">You don&apos;t have access to any modules yet.</p></section>;
          const apiCount = Object.values(current.access.apis).reduce((total, apis) => total + apis.length, 0);
          return (
            <>
              <Chips label="Choose a module" value={current.module.key} onChange={setChosenModule} options={list.map((entry) => ({ value: entry.module.key, label: entry.module.name }))} />
              <Card
                key={current.module.key}
                title={current.module.name}
                aside={<span className="note">{current.access.profileName ? `Profile: ${current.access.profileName}` : 'No profile'} · {apiCount} {apiCount === 1 ? 'API' : 'APIs'}</span>}
              >
                <ModuleApis moduleKey={current.module.key} access={current.access} onTry={(api, permission) => setTrying({ api, permission, guide: current.access.guides?.[api] })} />
                <FieldAccessDetails fieldAccess={current.access.fieldAccess} />
              </Card>
              <p className="note spaced">{SCOPE_LEGEND}</p>
            </>
          );
        }}
      </Loaded>
      {trying ? (
        <ApiTryDialog
          api={trying.api}
          permission={trying.permission}
          guide={trying.guide}
          onClose={() => setTrying(null)}
        />
      ) : null}
    </>
  );
}
