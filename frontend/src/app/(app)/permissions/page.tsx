'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Card, Chips, Loaded, PageHead, Pill } from '@/components/ui';
import { listModules, listProfiles } from '@/lib/api/modules';
import type { AccessProfile, PermissionMap, Scope } from '@/lib/api/types';
import { humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { permissionKey } from '@/lib/grants';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const SCOPE_TONES = { own: 'neutral', team: 'warning', all: 'accent' } as const;

const NotGranted = () => <span className="not-granted" aria-label="Not granted">–</span>;

interface Column {
  key: string;
  label: string;
  permissions: PermissionMap;
}

export default function PermissionsPage() {
  const { can } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const [chosenKey, setChosenKey] = useState('');

  const data = useLoad(async () => {
    const [modules, profiles] = await Promise.all([
      listModules(),
      canReadProfiles ? listProfiles() : Promise.resolve<AccessProfile[]>([]),
    ]);
    return { modules, profiles };
  }, [canReadProfiles]);

  const scopeCell = (scope?: Scope) => (scope ? <Pill tone={SCOPE_TONES[scope]}>{SCOPE_LABELS[scope]}</Pill> : <NotGranted />);

  return (
    <>
      <PageHead title="Permissions" subtitle="What each profile allows, in one view" />
      <Loaded state={data}>
        {({ modules, profiles }) => {
          const module = modules.find((candidate) => candidate.key === chosenKey) ?? modules[0];
          if (!module) return <section className="card"><p className="empty">No modules are loaded.</p></section>;
          const columns: Column[] = profiles.flatMap((profile) => {
            const part = profile.modules.find((candidate) => candidate.key === module.key);
            return part ? [{ key: profile.id, label: profile.name, permissions: part.permissions }] : [];
          });
          return (
            <>
              <div className="toolbar">
                <Chips label="Choose a module" value={module.key} onChange={setChosenKey} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
                <span className="note">Super admins have every permission.</span>
              </div>
              <Card title={`${module.name} permissions by profile`}>
                {module.resources.length === 0 ? <p className="empty">This module lists no permissions yet.</p> : (
                  <>
                    <div className="table-box">
                      <table className="matrix">
                        <thead>
                          <tr>
                            <th scope="col">Permission</th>
                            {columns.map((column) => (
                              <th scope="col" key={column.key}>
                                <Link href="/profiles">{column.label}</Link>
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {module.resources.map((resource) => (
                            <Fragment key={resource.key}>
                              <tr><th scope="rowgroup" colSpan={columns.length + 1}>{resource.label}</th></tr>
                              {resource.actions.map((action) => {
                                const permission = permissionKey(resource.key, action);
                                return (
                                  <tr key={permission}>
                                    <td><div>{humanize(action)}</div><div className="meta">{permission}</div></td>
                                    {columns.map((column) => <td key={column.key}>{scopeCell(column.permissions[permission])}</td>)}
                                  </tr>
                                );
                              })}
                            </Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {columns.length === 0 ? <p className="note spaced">No profile you can see gives anything in {module.name}.</p> : null}
                    <p className="note spaced">{SCOPE_LEGEND} A person gets what their one profile allows.</p>
                  </>
                )}
              </Card>
            </>
          );
        }}
      </Loaded>
    </>
  );
}
