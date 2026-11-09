'use client';

import Link from 'next/link';
import { Fragment, useState } from 'react';
import { Card, Chips, Loaded, PageHead, Pill } from '@/components/ui';
import { listModules, listRoles } from '@/lib/api/modules';
import type { ModulePerson, RegisteredModule, RoleTemplate, Scope } from '@/lib/api/types';
import { listModulePeople } from '@/lib/api/users';
import { humanize, peopleCount, SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { permissionKey } from '@/lib/roleGrants';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const SCOPE_TONES = { own: 'neutral', team: 'warning', all: 'accent' } as const;

const NotGranted = () => <span className="not-granted" aria-label="Not granted">–</span>;

export default function PermissionsPage() {
  const { can } = useSession();
  const canReadModules = can('module.read');
  const [chosenKey, setChosenKey] = useState('');

  const data = useLoad(async () => {
    const [roles, modules] = await Promise.all([listRoles(), canReadModules ? listModules() : Promise.resolve<RegisteredModule[]>([])]);
    return { roles, modules };
  }, [canReadModules]);

  const module = data.data?.modules.find((candidate) => candidate.key === chosenKey) ?? data.data?.modules[0];
  const people = useLoad<ModulePerson[] | null>(async () => (module ? listModulePeople(module.key).catch(() => null) : null), [module?.key]);
  const moduleRoles: RoleTemplate[] = (data.data?.roles ?? []).filter((role) => role.module === module?.key);
  const withPrivileges = (people.data ?? []).filter((person) => person.privileges.length + person.superAdminGrants.length > 0);

  const scopeCell = (scope?: Scope) => (scope ? <Pill tone={SCOPE_TONES[scope]}>{SCOPE_LABELS[scope]}</Pill> : <NotGranted />);

  return (
    <>
      <PageHead title="Permissions" subtitle="Which role can do what, in one view" />
      <Loaded state={data}>
        {({ modules }) => (module ? (
          <>
            <div className="toolbar">
              <Chips label="Choose a module" value={module.key} onChange={setChosenKey} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
              <span className="note">Super admins have every permission.</span>
            </div>
            {people.data ? (
              <Card title={`Who has what in ${module.name}`}>
                <div className="who-has">
                  {moduleRoles.map((role) => (
                    <Link key={role.key} href="/roles"><span>{role.name}</span><b>{people.data!.filter((person) => person.role === role.key).length}</b></Link>
                  ))}
                </div>
              </Card>
            ) : null}
            <Card title={`${module.name} permissions by role`}>
              {module.resources.length === 0 ? <p className="empty">This module lists no permissions yet.</p> : (
                <>
                  <div className="table-box">
                    <table className="matrix">
                      <thead>
                        <tr><th scope="col">Permission</th>{moduleRoles.map((role) => <th scope="col" key={role.key}>{role.name}</th>)}<th scope="col">Special privilege</th></tr>
                      </thead>
                      <tbody>
                        {module.resources.map((resource) => (
                          <Fragment key={resource.key}>
                            <tr><th scope="rowgroup" colSpan={moduleRoles.length + 2}>{resource.label}</th></tr>
                            {resource.actions.map((action) => {
                              const permission = permissionKey(resource.key, action);
                              return (
                                <tr key={permission}>
                                  <td><div>{humanize(action)}</div><div className="meta">{permission}</div></td>
                                  {moduleRoles.map((role) => <td key={role.key}>{scopeCell(role.permissions[permission])}</td>)}
                                  <td>{resource.grantable?.includes(action) ? <Pill tone="good">Allowed</Pill> : <NotGranted />}</td>
                                </tr>
                              );
                            })}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="note spaced">{SCOPE_LEGEND} The last column shows what can be given to one person without changing their role.</p>
                </>
              )}
            </Card>
            {people.data ? (
              <Card title="People with special privileges" aside={<Pill tone="neutral">{peopleCount(withPrivileges.length)}</Pill>}>
                {withPrivileges.length === 0 ? <p className="empty">Nobody in this module has a special privilege.</p> : (
                  <div className="table-box">
                    <table>
                      <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Privileges</th></tr></thead>
                      <tbody>
                        {withPrivileges.map((person) => (
                          <tr key={person.id}>
                            <td><Link className="link" href={`/people/${encodeURIComponent(person.id)}`}>{person.name}</Link></td>
                            <td>{moduleRoles.find((role) => role.key === person.role)?.name ?? 'No role'}</td>
                            <td>{[...person.privileges, ...person.superAdminGrants].map((permission) => <div key={permission}><code>{permission}</code></div>)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            ) : null}
          </>
        ) : <section className="card"><p className="empty">This view also needs permission to read modules.</p></section>)}
      </Loaded>
    </>
  );
}
