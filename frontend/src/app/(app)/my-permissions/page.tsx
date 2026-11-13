'use client';

import { useState } from 'react';
import { ApiTryDialog } from '@/components/ApiTryDialog';
import { ModuleApis } from '@/components/ModuleApis';
import { FIELD_LEVEL_LABELS } from '@/components/FieldAccessPanel';
import { Card, Chips, Loaded, PageHead } from '@/components/ui';
import { getMyModuleAccess, getMyModules } from '@/lib/api/account';
import type { ApiGuide, FieldAccessMap } from '@/lib/api/types';
import { humanize, SCOPE_LEGEND } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

async function loadMyAccess() {
  const modules = await getMyModules();
  const access = await Promise.all(modules.map((module) => getMyModuleAccess(module.key)));
  return modules.map((module, index) => ({ module, access: access[index]! }));
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
                <ModuleApis moduleKey={current.module.key} access={current.access} emptyMessage="Your profile gives nothing in this module." onTry={(api, permission) => setTrying({ api, permission, guide: current.access.guides?.[api] })} />
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
