'use client';

import { Card, Loaded, PageHead, Pill } from '@/components/ui';
import { getMyModuleAccess, getMyModules } from '@/lib/api/account';
import { SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';

async function loadMyAccess() {
  const modules = await getMyModules();
  const access = await Promise.all(modules.map((module) => getMyModuleAccess(module.key)));
  return modules.map((module, index) => ({ module, access: access[index]! }));
}

export default function YourPermissionsPage() {
  const access = useLoad(loadMyAccess, []);

  return (
    <>
      <PageHead title="Your permissions" subtitle="What you can do in each module" />
      <Loaded state={access}>
        {(list) => (
          <Card>
            {list.length === 0 ? <p className="empty">You don&apos;t have access to any modules yet.</p> : null}
            {list.map(({ module, access: moduleAccess }) => (
              <div className="module-access" key={module.key}>
                <h3>{module.name}{moduleAccess.roleName ? `: ${moduleAccess.roleName}` : ''}</h3>
                <div className="table-box table-box-scroll">
                  <table>
                    <thead><tr><th scope="col">Permission</th><th scope="col">Applies to</th><th scope="col">Comes from</th></tr></thead>
                    <tbody>
                      {Object.entries(moduleAccess.permissions).map(([permission, scope]) => (
                        <tr key={permission}>
                          <td><code>{permission}</code></td>
                          <td>{SCOPE_LABELS[scope]}</td>
                          <td>{moduleAccess.specialPrivileges.includes(permission) ? <Pill tone="warning">Special privilege</Pill> : 'Role'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
            {list.length > 0 ? <p className="note spaced">{SCOPE_LEGEND}</p> : null}
          </Card>
        )}
      </Loaded>
    </>
  );
}
