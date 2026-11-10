'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Card, Chips, Loaded, PageHead, Pill } from '@/components/ui';
import { ApiRequestError } from '@/lib/api/http';
import { getManageablePermissionSets, listModules, listProfiles } from '@/lib/api/modules';
import type { AccessProfile, ManageableModule, PermissionMap, Scope } from '@/lib/api/types';
import { humanize, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { permissionKey } from '@/lib/grants';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const SCOPE_TONES = { own: 'neutral', team: 'warning', all: 'accent' } as const;

const NotGranted = () => <span className="not-granted" aria-label="Not granted">–</span>;

/** A refusal means this person can't see permission sets anywhere, which is a normal answer here. */
async function readManageableSets(): Promise<ManageableModule[]> {
  try {
    return await getManageablePermissionSets();
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 403) return [];
    throw error;
  }
}

interface Column {
  key: string;
  label: string;
  kind: 'profile' | 'set';
  permissions: PermissionMap;
}

export default function PermissionsPage() {
  const { can } = useSession();
  const canReadProfiles = can('accessProfile.read');
  const [chosenKey, setChosenKey] = useState('');

  const data = useLoad(async () => {
    const [modules, manageable, profiles] = await Promise.all([
      listModules(),
      readManageableSets(),
      canReadProfiles ? listProfiles() : Promise.resolve<AccessProfile[]>([]),
    ]);
    return { modules, manageable, profiles };
  }, [canReadProfiles]);

  const scopeCell = (scope?: Scope) => (scope ? <Pill tone={SCOPE_TONES[scope]}>{SCOPE_LABELS[scope]}</Pill> : <NotGranted />);

  return (
    <>
      <PageHead title="Permissions" subtitle="What each profile and permission set allows, in one view" />
      <Loaded state={data}>
        {({ modules, manageable, profiles }) => {
          const module = modules.find((candidate) => candidate.key === chosenKey) ?? modules[0];
          if (!module) return <section className="card"><p className="empty">No modules are loaded.</p></section>;
          const columns: Column[] = [
            ...profiles.flatMap((profile) => {
              const part = profile.modules.find((candidate) => candidate.key === module.key);
              return part ? [{ key: `profile:${profile.id}`, label: profile.name, kind: 'profile' as const, permissions: part.permissions }] : [];
            }),
            ...(manageable.find((candidate) => candidate.key === module.key)?.permissionSets ?? []).map((permissionSet) => ({
              key: `set:${permissionSet.key}`,
              label: permissionSet.name,
              kind: 'set' as const,
              permissions: permissionSet.permissions,
            })),
          ];
          return (
            <>
              <div className="toolbar">
                <Chips label="Choose a module" value={module.key} onChange={setChosenKey} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
                <span className="note">Super admins have every permission.</span>
              </div>
              <Card title={`${module.name} permissions by profile and permission set`}>
                {module.resources.length === 0 ? <p className="empty">This module lists no permissions yet.</p> : (
                  <>
                    <div className="table-box">
                      <table className="matrix">
                        <thead>
                          <tr>
                            <th scope="col">Permission</th>
                            {columns.map((column) => (
                              <th scope="col" key={column.key}>
                                <Link href={column.kind === 'profile' ? '/profiles' : '/permission-sets'}>{column.label}</Link>
                                <div className="meta">{column.kind === 'profile' ? 'Profile' : 'Permission set'}</div>
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
                    {columns.length === 0 ? <p className="note spaced">No profile or permission set you can see gives anything in {module.name}.</p> : null}
                    <p className="note spaced">{SCOPE_LEGEND} A person gets their profile plus every permission set they hold, and the widest reach wins.</p>
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
