'use client';

import { useState, type FormEvent } from 'react';
import { Dialog } from '@/components/Dialog';
import { ModuleAccessEditor } from '@/components/ModuleAccessEditor';
import { PersonPicker } from '@/components/PersonPicker';
import { Card, Chips, Loaded, Notice, PageHead, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import type { AccessOption, AddablePerson, ModulePerson } from '@/lib/api/types';
import { getAccessOptions, listModulePeople, setUserRole } from '@/lib/api/users';
import { humanize, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile } from '@/session/SessionProvider';

function AddPersonForm({ option, onAdded }: { option: AccessOption; onAdded: () => void }) {
  const [person, setPerson] = useState<AddablePerson | null>(null);
  const [role, setRole] = useState(option.roles[0]?.key ?? '');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!person) return;
    setError('');
    try {
      await setUserRole(person.id, option.key, role);
      onAdded();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <form className="form" onSubmit={(event) => void submit(event)}>
      <div className="inline-form">
        <PersonPicker id="add-person" label="Person" moduleKey={option.key} selected={person} onChange={setPerson} />
        <div className="field">
          <label htmlFor="add-role">Role</label>
          <select className="input" id="add-role" value={role} onChange={(event) => setRole(event.target.value)}>
            {option.roles.map((candidate) => <option key={candidate.key} value={candidate.key}>{candidate.name}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!person || !role}>Add</button>
      </div>
      {error ? <Notice tone="danger">{error}</Notice> : null}
    </form>
  );
}

/** For module admins, who can change access in their module without being able to open the People screen. */
export default function AccessPage() {
  const viewer = useProfile();
  const [chosenKey, setChosenKey] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const options = useLoad(async () => (await getAccessOptions()).filter((option) => option.canChange), []);
  const option = options.data?.find((candidate) => candidate.key === chosenKey) ?? options.data?.[0];
  const people = useLoad(async () => (option ? listModulePeople(option.key) : []), [option?.key], option?.key);

  const roleName = (person: ModulePerson) => option?.roles.find((role) => role.key === person.role)?.name ?? humanize(person.role);
  const editing = people.data?.find((person) => person.id === editingId);

  return (
    <>
      <PageHead title="Access" subtitle="Who has access to each module you manage" />
      <Loaded state={options}>
        {(list) => (option ? (
          <>
            <Chips label="Choose a module" value={option.key} onChange={setChosenKey} options={list.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
            <Loaded state={people}>
              {(moduleList) => (
                <Card title={`People in ${option.name}`} aside={<span className="note">{peopleCount(moduleList.length)}</span>}>
                  {moduleList.length === 0 ? <p className="empty">Nobody has access to this module yet.</p> : (
                    <div className="table-box">
                      <table>
                        <thead><tr><th scope="col">Person</th><th scope="col">Role</th><th scope="col">Special privileges</th><th scope="col">Status</th><th scope="col"><span className="visually-hidden">Change</span></th></tr></thead>
                        <tbody>
                          {moduleList.map((person) => (
                            <tr key={person.id}>
                              <td><div className="strong">{person.name}</div><div className="meta">{person.email}</div></td>
                              <td>{person.role ? roleName(person) : <span className="muted">No role</span>}</td>
                              <td>{[...person.privileges, ...person.superAdminGrants].join(', ') || <span className="muted">None</span>}</td>
                              <td><StatusPill status={person.status} /></td>
                              <td>{person.id !== viewer.id || viewer.superAdmin ? <button type="button" className="link" aria-label={`Change access for ${person.name}`} onClick={() => setEditingId(person.id)}>Change</button> : null}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </Card>
              )}
            </Loaded>
            <Card title={`Add someone to ${option.name}`}>
              <AddPersonForm key={`${option.key}:${people.data?.length ?? 0}`} option={option} onAdded={people.reload} />
            </Card>
          </>
        ) : <section className="card"><p className="empty">You don&apos;t manage access in any module.</p></section>)}
      </Loaded>

      {editing && option ? (
        <Dialog title={`${editing.name} in ${option.name}`} onClose={() => setEditingId(null)}>
          <ModuleAccessEditor
            key={`${editing.role ?? ''}:${editing.privileges.join()}:${editing.superAdminGrants.join()}`}
            option={option}
            userId={editing.id}
            holding={editing}
            canEdit
            isViewerSuperAdmin={viewer.superAdmin}
            onChanged={people.reload}
          />
          <div className="dialog-actions"><button type="button" className="btn" onClick={() => setEditingId(null)}>Done</button></div>
        </Dialog>
      ) : null}
    </>
  );
}
