'use client';

import Link from 'next/link';
import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Card, Loaded, Notice, PageHead, Row, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { createOrgRole, listOrgRoles, removeOrgRole, updateOrgRole } from '@/lib/api/modules';
import type { OrgRole, User } from '@/lib/api/types';
import { listAllUsers } from '@/lib/api/users';
import { formatTime, humanize, peopleCount } from '@/lib/format';
import { useLoad } from '@/lib/useLoad';
import { useProfile, useSession } from '@/session/SessionProvider';

/** The roles in tree order: each parent followed by its children, sorted by name at each level. */
function orderAsTree(roles: OrgRole[]): OrgRole[] {
  const childrenOf = (parentId: string | null) =>
    roles.filter((role) => role.parentId === parentId).sort((first, second) => first.name.localeCompare(second.name));
  const ordered: OrgRole[] = [];
  const visit = (role: OrgRole) => {
    ordered.push(role);
    childrenOf(role.id).forEach(visit);
  };
  childrenOf(null).forEach(visit);
  return ordered;
}

/** A role and every role below it, which can't become its new parent. */
function selfAndBelow(roles: OrgRole[], roleId: string): Set<string> {
  const found = new Set([roleId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const role of roles) {
      if (role.parentId && found.has(role.parentId) && !found.has(role.id)) {
        found.add(role.id);
        grew = true;
      }
    }
  }
  return found;
}

/** The roles from the top of the tree down to this one's parent. */
function rolesAbove(roles: OrgRole[], role: OrgRole): OrgRole[] {
  const above: OrgRole[] = [];
  let parentId = role.parentId;
  while (parentId) {
    const parent = roles.find((candidate) => candidate.id === parentId);
    if (!parent) break;
    above.unshift(parent);
    parentId = parent.parentId;
  }
  return above;
}

const indentedName = (role: OrgRole) => `${'— '.repeat(role.depth)}${role.name}`;

function RoleFormDialog({ title, submitLabel, role, parentChoices, initialParentId, needsParent, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  role?: OrgRole;
  parentChoices: OrgRole[];
  initialParentId: string | null;
  /** Every role except the root has a parent. */
  needsParent: boolean;
  onSubmit: (details: { name: string; description: string; parentId: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [parentId, setParentId] = useState(initialParentId ?? '');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await onSubmit({ name: name.trim(), description: description.trim(), parentId: parentId || null });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="field"><label htmlFor="org-role-name">Name</label><input className="input" id="org-role-name" autoComplete="off" required value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="org-role-description">Description</label><input className="input" id="org-role-description" autoComplete="off" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        {needsParent ? (
          <div className="field">
            <label htmlFor="org-role-parent">Reports to</label>
            <select className="input" id="org-role-parent" required value={parentId} onChange={(event) => setParentId(event.target.value)}>
              <option value="" disabled>Choose a parent role</option>
              {parentChoices.map((choice) => <option key={choice.id} value={choice.id}>{indentedName(choice)}</option>)}
            </select>
            <p className="meta">Moving a role moves every role below it too. People above see the records of everyone below them.</p>
          </div>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim() || (needsParent && !parentId)}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

type OrgRoleDialog = 'add-child' | 'add-root' | 'edit' | 'delete' | null;

/** The organisation tree. It decides whose records someone's team scope reaches. It never gives permissions. */
export default function OrgRolesPage() {
  const viewer = useProfile();
  const { can } = useSession();
  const canCreate = can('orgRole.create');
  const canUpdate = can('orgRole.update');
  const canDelete = can('orgRole.delete');
  const canReadPeople = can('user.read');

  const data = useLoad(async () => {
    const [roles, people] = await Promise.all([listOrgRoles(), canReadPeople ? listAllUsers() : Promise.resolve<User[] | null>(null)]);
    return { roles: orderAsTree(roles), people };
  }, [canReadPeople]);
  const [chosenId, setChosenId] = useState('');
  const [dialog, setDialog] = useState<OrgRoleDialog>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  return (
    <>
      <PageHead title="Org roles" subtitle="Your organisation tree. People see the records of everyone in the roles below theirs." />
      {outcome ? <Notice tone="good">{outcome}</Notice> : null}
      <Loaded state={data}>
        {({ roles, people }) => {
          const role = roles.find((candidate) => candidate.id === chosenId) ?? roles[0];
          if (!role) {
            return (
              <section className="card">
                <p className="empty">The tree is empty. Start it with the role at the top, such as Founder or CEO.</p>
                {canCreate ? <div className="actions"><button type="button" className="btn btn-primary" onClick={() => setDialog('add-root')}>Add the top role</button></div> : null}
                {dialog === 'add-root' ? (
                  <RoleFormDialog title="Top role" submitLabel="Add role" parentChoices={[]} initialParentId={null} needsParent={false} onClose={() => setDialog(null)}
                    onSubmit={async ({ name, description }) => { await createOrgRole({ name, ...(description && { description }) }); setOutcome('Added the top role.'); data.reload(); }} />
                ) : null}
              </section>
            );
          }

          const parent = roles.find((candidate) => candidate.id === role.parentId);
          const children = roles.filter((candidate) => candidate.parentId === role.id);
          const below = selfAndBelow(roles, role.id);
          const parentChoices = roles.filter((candidate) => !below.has(candidate.id));
          const above = rolesAbove(roles, role);
          const rolesBelow = roles.filter((candidate) => candidate.id !== role.id && below.has(candidate.id));
          const peopleBelow = rolesBelow.reduce((total, candidate) => total + candidate.peopleCount, 0);
          const peopleAbove = above.reduce((total, candidate) => total + candidate.peopleCount, 0);
          const holders = people?.filter((person) => person.orgRoleId === role.id) ?? [];
          const holderIds = new Set(holders.map((holder) => holder.id));
          const directReports = people?.filter((person) => person.managerId && holderIds.has(person.managerId)).length ?? null;
          const isOwnRole = viewer.orgRoleId === role.id && !viewer.superAdmin;
          const isRoot = role.parentId === null;

          return (
            <>
              <div className="split">
                <section className="side" aria-label="Org tree">
                  <div className="side-head">
                    <span>Tree</span>
                    {canCreate ? <button type="button" className="link" onClick={() => setDialog('add-child')}>+ Role below</button> : null}
                  </div>
                  {roles.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.id}
                      className="item item-button org-role-item"
                      style={{ paddingLeft: `${12 + candidate.depth * 18}px` }}
                      aria-current={candidate.id === role.id}
                      onClick={() => setChosenId(candidate.id)}
                    >
                      <b>{candidate.depth > 0 ? '└ ' : ''}{candidate.name}</b>
                      <span className="count">{candidate.peopleCount}</span>
                    </button>
                  ))}
                </section>
                <div className="pane">
                  <section className="card pane-top">
                    <div className="pane-row">
                      <div><h2>{role.name}</h2><p className="muted">{role.description || 'No description'}</p></div>
                      {canUpdate || canDelete ? (
                        <div className="page-actions">
                          {canUpdate ? <button type="button" className="btn" onClick={() => setDialog('edit')}>{isRoot ? 'Rename' : 'Rename or move'}</button> : null}
                          {canDelete && !isRoot ? <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button> : null}
                        </div>
                      ) : null}
                    </div>
                    {isOwnRole ? <p className="explain">This is your own role. Only a super admin can move it.</p> : null}
                  </section>

                  <Card title="Details">
                    <Row label="Path">{[...above, role].map((step, index) => <span key={step.id}>{index > 0 ? ' › ' : ''}{step.id === role.id ? <b>{step.name}</b> : <button type="button" className="link" onClick={() => setChosenId(step.id)}>{step.name}</button>}</span>)}</Row>
                    <Row label="Level">{role.depth === 0 ? 'Top' : `${role.depth} below the top`}</Row>
                    <Row label="Role ID"><code>{role.id}</code></Row>
                    <Row label="Created">{formatTime(role.createdAt)}</Row>
                    <Row label="Last changed">{formatTime(role.updatedAt)}</Row>
                  </Card>

                  <Card title="Place in the tree">
                    <Row label="Reports to">{parent ? <button type="button" className="link" onClick={() => setChosenId(parent.id)}>{parent.name}</button> : 'Nobody. This is the top of the tree.'}</Row>
                    <Row label="Roles directly below">{children.length > 0 ? children.map((child, index) => <span key={child.id}>{index > 0 ? ', ' : ''}<button type="button" className="link" onClick={() => setChosenId(child.id)}>{child.name}</button></span>) : 'None'}</Row>
                    <Row label="All roles below">{rolesBelow.length > 0 ? `${rolesBelow.length} ${rolesBelow.length === 1 ? 'role' : 'roles'}` : 'None'}</Row>
                  </Card>

                  <Card title="Who it reaches">
                    <Row label="People below this role">{peopleCount(peopleBelow)}</Row>
                    <Row label="People above who can see this role">{peopleCount(peopleAbove)}</Row>
                    {directReports !== null ? <Row label="Direct reports of people in this role">{peopleCount(directReports)}</Row> : null}
                    <p className="note spaced">Someone in {role.name} with a team-scoped permission reaches their direct reports and the records of the {peopleCount(peopleBelow)} in the {rolesBelow.length} {rolesBelow.length === 1 ? 'role' : 'roles'} below it. The tree only decides visibility. Permissions come from each person's profile.</p>
                  </Card>

                  <Card title="People in this role" aside={<span className="note">{peopleCount(role.peopleCount)}</span>}>
                    {people === null ? <p className="empty">Seeing who is in each role needs user.read.</p> : holders.length === 0 ? <p className="empty">Nobody is in this role yet. Place people from their page in People.</p> : (
                      <div className="table-box">
                        <table>
                          <thead><tr><th>Person</th><th>Job title</th><th>Department</th><th>Contract</th><th>Status</th></tr></thead>
                          <tbody>
                            {holders.map((person) => (
                              <tr key={person.id}>
                                <td><Link className="link" href={`/people/${encodeURIComponent(person.id)}`}>{person.name}</Link><div className="meta">{person.email}</div></td>
                                <td>{person.title ?? '—'}</td>
                                <td>{person.department ?? '—'}</td>
                                <td>{humanize(person.contract)}</td>
                                <td><StatusPill status={person.status} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              </div>

              {dialog === 'add-child' ? (
                <RoleFormDialog title="New org role" submitLabel="Add role" parentChoices={roles} initialParentId={role.id} needsParent onClose={() => setDialog(null)}
                  onSubmit={async ({ name, description, parentId }) => {
                    const created = await createOrgRole({ name, ...(description && { description }), parentId: parentId ?? undefined });
                    setChosenId(created.id);
                    setOutcome(`Added ${name}.`);
                    data.reload();
                  }} />
              ) : null}
              {dialog === 'edit' ? (
                <RoleFormDialog title={`Edit ${role.name}`} submitLabel="Save" role={role} parentChoices={parentChoices} initialParentId={role.parentId} needsParent={!isRoot} onClose={() => setDialog(null)}
                  onSubmit={async ({ name, description, parentId }) => {
                    await updateOrgRole(role.id, {
                      name,
                      description: description || null,
                      ...(parentId && parentId !== role.parentId && { parentId }),
                    });
                    setOutcome(parentId && parentId !== role.parentId ? `Moved ${name} and everything below it.` : `Saved ${name}.`);
                    data.reload();
                  }} />
              ) : null}
              {dialog === 'delete' ? (
                <ConfirmDialog title={`Delete ${role.name}?`} text="Only a role with nobody in it and no roles below it can be deleted." confirmLabel="Delete" isDanger onClose={() => setDialog(null)}
                  onConfirm={async () => { await removeOrgRole(role.id); setChosenId(role.parentId ?? ''); setOutcome(`Deleted ${role.name}.`); data.reload(); }} />
              ) : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
