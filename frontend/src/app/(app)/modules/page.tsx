'use client';

import Link from 'next/link';
import { firstConsoleHref } from '@/components/AppShell';
import { Loaded, PageHead, Pill } from '@/components/ui';
import { getMyModules } from '@/lib/api/account';
import type { MyModule } from '@/lib/api/types';
import { longDate } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

const MASTER_MODULE_KEY = 'master';

export default function YourModulesPage() {
  const { can, canChangeAccess } = useSession();
  const profile = useProfile();
  const modules = useLoad(getMyModules, []);
  const consoleHref = firstConsoleHref({ can, canChangeAccess });

  const openAction = (module: MyModule) => {
    // A super admin goes to the module's API explorer, with the app a secondary link.
    if (profile.superAdmin) {
      return (
        <>
          <Link className="btn btn-primary" href={`/modules/${encodeURIComponent(module.key)}`}>Explore APIs</Link>
          {module.frontendUrl ? <a className="btn" href={module.frontendUrl}>Open app</a> : null}
        </>
      );
    }
    if (module.key === MASTER_MODULE_KEY) return consoleHref ? <Link className="btn btn-primary" href={consoleHref}>Open</Link> : null;
    if (!module.frontendUrl) return <button type="button" className="btn" disabled>Not available yet</button>;
    return <a className="btn btn-primary" href={module.frontendUrl}>Open</a>;
  };

  return (
    <>
      <PageHead title="Your modules" subtitle={longDate()} />
      <Loaded state={modules}>
        {(list) => (list.length === 0
          ? <section className="card"><p className="empty">You don&apos;t have access to any modules yet. Ask HR to give you access.</p></section>
          : (
            <div className="grid-cards">
              {list.map((module) => (
                <article className="card module-card" key={module.key}>
                  <div className="card-head">
                    <h2>{module.name}</h2>
                    <Pill tone={module.profileName ? 'accent' : 'neutral'}>{module.profileName ?? 'Super admin'}</Pill>
                  </div>
                  <p>{module.description}</p>
                  <div className="bottom">{openAction(module)}</div>
                </article>
              ))}
            </div>
          ))}
      </Loaded>
    </>
  );
}
