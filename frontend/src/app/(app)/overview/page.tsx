'use client';

import Link from 'next/link';
import { ActivityTable } from '@/components/ActivityTable';
import { Card, Loaded, PageHead } from '@/components/ui';
import { listActivity, listProfiles } from '@/lib/api/modules';
import type { AccessModule, AccessProfile, AuditEntry, User } from '@/lib/api/types';
import { listAccessModules, listAllUsers } from '@/lib/api/users';
import { longDate, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const RECENT_ACTIVITY_SIZE = 6;

interface OverviewData {
  people: User[];
  modules: AccessModule[];
  profiles: AccessProfile[];
  activity: AuditEntry[];
}

/** Access through a profile that gives something in the module. */
function hasAccessIn(person: User, moduleKey: string, profiles: AccessProfile[]): boolean {
  const profile = profiles.find((candidate) => candidate.id === person.profileId);
  return Boolean(profile?.modules.some((module) => module.key === moduleKey));
}

function listAttentionItems({ people, modules, profiles }: OverviewData): { tone: 'danger' | 'warning'; text: string }[] {
  const holdsAnything = (person: User) => modules.some((module) => hasAccessIn(person, module.key, profiles));
  const active = people.filter((person) => person.status === 'active');
  const deactivatedWithRoles = people.filter((person) => person.status === 'inactive' && holdsAnything(person)).length;
  const noAccess = active.filter((person) => !person.superAdmin && !holdsAnything(person)).length;
  const neverSignedIn = active.filter((person) => !person.lastSignedInAt).length;

  const items: { tone: 'danger' | 'warning'; text: string }[] = [];
  if (deactivatedWithRoles) items.push({ tone: 'danger', text: `${peopleCount(deactivatedWithRoles)} deactivated but still holding access` });
  if (neverSignedIn) items.push({ tone: 'warning', text: `${peopleCount(neverSignedIn)} never signed in, so their invitation may need sending again` });
  if (noAccess) items.push({ tone: 'warning', text: `${peopleCount(noAccess)} with no access to any module` });
  return items;
}

export default function OverviewPage() {
  const { can } = useSession();
  const canReadActivity = can('audit.read');
  const canReadProfiles = can('accessProfile.read');

  const overview = useLoad<OverviewData>(async () => {
    const [people, modules, profiles, activity] = await Promise.all([
      listAllUsers(),
      listAccessModules(),
      canReadProfiles ? listProfiles() : Promise.resolve<AccessProfile[]>([]),
      canReadActivity ? listActivity({ page: 1, pageSize: RECENT_ACTIVITY_SIZE }) : Promise.resolve({ entries: [], total: 0 }),
    ]);
    return { people, modules, profiles, activity: activity.entries };
  }, [canReadActivity, canReadProfiles]);

  return (
    <>
      <PageHead title="Overview" subtitle={longDate()} />
      <Loaded state={overview}>
        {(data) => {
          const active = data.people.filter((person) => person.status === 'active');
          const attention = listAttentionItems(data);
          return (
            <>
              <div className="tiles">
                <div className="tile"><span>People</span><b>{data.people.length}</b></div>
                <div className="tile"><span>Active</span><b className="is-good">{active.length}</b></div>
                <div className="tile"><span>Deactivated</span><b>{data.people.length - active.length}</b></div>
                <div className="tile"><span>Modules loaded</span><b>{data.modules.length}</b></div>
                <div className="tile"><span>Super admins</span><b>{active.filter((person) => person.superAdmin).length}</b></div>
              </div>
              <div className="columns">
                {canReadActivity ? (
                  <Card title="Recent activity" aside={<Link className="link" href="/activity">View all</Link>}><ActivityTable entries={data.activity} /></Card>
                ) : (
                  <Card title="Recent activity"><p className="empty">Your access doesn&apos;t include the activity log.</p></Card>
                )}
                <div className="stack">
                  <Card title="Needs attention">
                    {attention.length === 0 ? <p className="muted">Nothing right now.</p> : (
                      <ul className="attention">
                        {attention.map((item) => <li key={item.text}><span className={`dot dot-${item.tone}`} aria-hidden="true" />{item.text}</li>)}
                      </ul>
                    )}
                  </Card>
                  <Card title="Active people with access, by module">
                    {data.modules.map((module) => {
                      const count = active.filter((person) => person.superAdmin || hasAccessIn(person, module.key, data.profiles)).length;
                      return (
                        <div className="meter" key={module.key}>
                          <div className="meter-text"><span>{module.name}</span><b>{count}</b></div>
                          <div className="meter-track" aria-hidden="true"><div className="meter-fill" style={{ width: `${active.length ? (count / active.length) * 100 : 0}%` }} /></div>
                        </div>
                      );
                    })}
                  </Card>
                </div>
              </div>
            </>
          );
        }}
      </Loaded>
    </>
  );
}
