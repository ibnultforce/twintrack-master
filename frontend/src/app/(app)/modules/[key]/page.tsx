'use client';

import Link from 'next/link';
import { OpenAppLink } from '@/components/OpenAppLink';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ApiTryDialog, type TryTarget } from '@/components/ApiTryDialog';
import { ModuleApis, type ApiVerdict } from '@/components/ModuleApis';
import { SearchCombobox } from '@/components/SearchCombobox';
import { Card, Loaded, Notice, PageHead } from '@/components/ui';
import { getMyModuleAccess, getMyModules } from '@/lib/api/account';
import { describeError } from '@/lib/api/http';
import type { ApiGuide, ModuleAccess, User } from '@/lib/api/types';
import { endTestSession, getModuleAccessAs, listAllUsers, listUsers, startTestSession, type TestSession } from '@/lib/api/users';
import { SCOPE_LABELS, SCOPE_LEGEND } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile } from '@/session/SessionProvider';

const SEARCH_DELAY_MS = 250;
const PEOPLE_PAGE_SIZE = 20;
const TEST_PERSON_FIELD_ID = 'test-person';

/** Who the requests are sent as: the super admin, one person through a test session, or each person in turn. */
type Tester =
  | { kind: 'self' }
  | { kind: 'person'; session: TestSession; access: ModuleAccess | null }
  | { kind: 'everyone'; people: User[] };

/** Everyone a request can be sent as: active people who aren't super admins, since nobody can act as one. */
async function loadTestablePeople(): Promise<User[]> {
  return (await listAllUsers()).filter((person) => person.status === 'active' && !person.superAdmin);
}

function toTryTarget(tester: Tester): TryTarget {
  if (tester.kind === 'person') return { kind: 'person', name: tester.session.user.name, accessToken: tester.session.accessToken };
  if (tester.kind === 'everyone') return { kind: 'everyone', people: tester.people };
  return { kind: 'self' };
}

async function loadModule(moduleKey: string) {
  const [modules, access] = await Promise.all([getMyModules(), getMyModuleAccess(moduleKey)]);
  return { module: modules.find((candidate) => candidate.key === moduleKey), access };
}

/** Says, for each permission, whether the tested person's profile gives it and how far it reaches. */
function verdictsFrom(access: ModuleAccess | null): ApiVerdict {
  return (permission) => {
    const scope = access?.permissions[permission];
    return scope ? { isAllowed: true, label: `Allowed · ${SCOPE_LABELS[scope]}` } : { isAllowed: false, label: 'Not in their profile' };
  };
}

/** Searches active people to test as. Super admins are left out: nobody can act as one. */
function TestPersonSearch({ onChoose }: { onChoose: (person: User) => void }) {
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);
  const results = useLoad(() => listUsers({ page: 1, pageSize: PEOPLE_PAGE_SIZE, search, status: 'active' }), [search]);
  const people = (results.data?.users ?? []).filter((person) => !person.superAdmin);

  return (
    <div className="field">
      <label htmlFor={TEST_PERSON_FIELD_ID}>Someone else</label>
      <SearchCombobox
        id={TEST_PERSON_FIELD_ID}
        label="Person to test as"
        placeholder="Search name, email, title"
        query={query}
        onQueryChange={setQuery}
        items={people}
        keyOf={(person) => person.id}
        renderItem={(person) => (
          <>
            <span><span className="strong">{person.name}</span><span className="meta"> {person.email}</span></span>
            {person.title ? <span className="meta">{person.title}</span> : null}
          </>
        )}
        onSelect={(person) => {
          onChoose(person);
          setQuery('');
        }}
        emptyMessage={results.error ?? (results.data ? 'Nobody matches this search.' : 'Loading…')}
      />
    </div>
  );
}

/** The first step: who the requests should run as. Testing as someone else needs impersonation, so development only. */
function TesterChoice({ canTestAsOthers, isStarting, problem, onChooseSelf, onChoosePerson, onChooseEveryone }: {
  canTestAsOthers: boolean;
  isStarting: boolean;
  problem: string;
  onChooseSelf: () => void;
  onChoosePerson: (person: User) => void;
  onChooseEveryone: () => void;
}) {
  return (
    <Card title="Who should the requests run as?">
      <p className="note">Each request is sent with this person&apos;s access, so the answers show exactly what they would get.</p>
      <div className="tester-choice">
        <button type="button" className="btn" onClick={onChooseSelf}>Myself (super admin)</button>
        {canTestAsOthers ? (
          <button type="button" className="btn" onClick={onChooseEveryone} title="Each request is sent as every active person in turn, and lists each answer">
            Everyone, one by one
          </button>
        ) : null}
        <span className="meta">or</span>
      </div>
      {canTestAsOthers
        ? <TestPersonSearch onChoose={onChoosePerson} />
        : <p className="meta">Testing as someone else uses sign-in-as, which is only switched on in development.</p>}
      {isStarting ? <p className="loading" role="status">Starting a test session…</p> : null}
      {problem ? <Notice tone="danger">{problem}</Notice> : null}
    </Card>
  );
}

/**
 * Super admin only: every API of one module, each one ready to try with sample data, sent as the super admin, as a
 * person they choose, or as every active person one by one, to check what each person's access lets through.
 */
export default function ModuleApiExplorerPage() {
  const { key: moduleKey } = useParams<{ key: string }>();
  const profile = useProfile();
  const loaded = useLoad(() => loadModule(moduleKey), [moduleKey]);
  const [tester, setTester] = useState<Tester | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [problem, setProblem] = useState('');
  const [trying, setTrying] = useState<{ api: string; permission: string; guide?: ApiGuide } | null>(null);

  // A test session is ended when it's replaced or the page closes, so it doesn't stay usable until it expires.
  const openSession = useRef<TestSession | null>(null);
  const endOpenSession = () => {
    const session = openSession.current;
    openSession.current = null;
    if (session) void endTestSession(session).catch(() => undefined);
  };
  useEffect(() => endOpenSession, []);

  const chooseSelf = () => {
    endOpenSession();
    setProblem('');
    setTester({ kind: 'self' });
  };

  const choosePerson = async (person: User) => {
    endOpenSession();
    setProblem('');
    setIsStarting(true);
    try {
      const session = await startTestSession(person.id);
      openSession.current = session;
      setTester({ kind: 'person', session, access: await getModuleAccessAs(session, moduleKey) });
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setIsStarting(false);
    }
  };

  const chooseEveryone = async () => {
    endOpenSession();
    setProblem('');
    setIsStarting(true);
    try {
      setTester({ kind: 'everyone', people: await loadTestablePeople() });
    } catch (failure) {
      setProblem(describeError(failure));
    } finally {
      setIsStarting(false);
    }
  };

  const changeTester = () => {
    endOpenSession();
    setTester(null);
  };

  if (!profile.superAdmin) {
    return (
      <>
        <PageHead title="API explorer" />
        <Notice tone="warning">Only a super admin can explore a module&apos;s APIs. Your own APIs are under Your permissions.</Notice>
      </>
    );
  }

  return (
    <Loaded state={loaded}>
      {({ module, access }) => {
        const apiCount = new Set(Object.values(access.apis).flat()).size;
        const testedName = tester?.kind === 'person' ? tester.session.user.name : null;
        return (
          <>
            <PageHead
              title={`${module?.name ?? moduleKey} APIs`}
              subtitle={`Every private API in this module, ${apiCount} in all: the ones a profile permission opens. Choose who to test as, then select Try on any API.`}
              actions={<>
                {module ? <OpenAppLink module={module} label="Open app" /> : null}
                <Link className="btn" href="/modules">Back to modules</Link>
              </>}
            />
            {tester === null ? (
              <TesterChoice
                canTestAsOthers={profile.canImpersonate}
                isStarting={isStarting}
                problem={problem}
                onChooseSelf={chooseSelf}
                onChoosePerson={(person) => void choosePerson(person)}
                onChooseEveryone={() => void chooseEveryone()}
              />
            ) : (
              <>
                <div className="tester-bar" role="status">
                  <span>
                    {tester.kind === 'everyone'
                      ? <>Testing as <b>everyone, one by one</b><span className="meta"> · {tester.people.length} active people. Each Try sends the request as each of them and lists every answer.</span></>
                      : <>Testing as <b>{testedName ?? `${profile.name} (you, super admin)`}</b></>}
                    {tester.kind === 'person' ? <span className="meta"> · Profile: {tester.access?.profileName ?? 'none'}</span> : null}
                  </span>
                  <button type="button" className="btn btn-small" onClick={changeTester}>Change</button>
                </div>
                {tester.kind === 'person' && !tester.access?.hasAccess
                  ? <Notice tone="warning">{testedName} has no access to this module, so every request should be refused.</Notice>
                  : null}
                <Card title={module?.name ?? moduleKey}>
                  <ModuleApis
                    moduleKey={moduleKey}
                    access={access}
                    emptyMessage="This module has no APIs yet."
                    verdictFor={tester.kind === 'person' ? verdictsFrom(tester.access) : undefined}
                    onTry={(api, permission) => setTrying({ api, permission, guide: access.guides?.[api] })}
                  />
                </Card>
                <p className="note spaced">{SCOPE_LEGEND}</p>
              </>
            )}
            {trying && tester ? (
              <ApiTryDialog
                api={trying.api}
                permission={trying.permission}
                guide={trying.guide}
                references={access.references}
                target={toTryTarget(tester)}
                onClose={() => setTrying(null)}
              />
            ) : null}
          </>
        );
      }}
    </Loaded>
  );
}
