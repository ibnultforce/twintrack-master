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
import { OrgTree, OrgTreeLegend, type RoleRelation } from './OrgTree';

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

/** Everyone who reports to this person, directly or through others. This is what their team scope reaches. */
function reportingLineOf(people: User[], personId: string): User[] {
  const line: User[] = [];
  const seen = new Set([personId]);
  let managerIds = [personId];
  while (managerIds.length > 0) {
    const reports = people.filter((person) => person.managerId && managerIds.includes(person.managerId) && !seen.has(person.id));
    reports.forEach((report) => seen.add(report.id));
    line.push(...reports);
    managerIds = reports.map((report) => report.id);
  }
  return line;
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
            <p className="meta">Moving a role moves every role below it too. It changes nobody's reach: team reach follows who reports to whom.</p>
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

/** The organisation tree of job levels. Team reach follows each person's manager, not this tree, and the tree never gives permissions. */
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
  const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());

  return (
    <>
      <PageHead title="Org roles" subtitle="Your job levels. Team-scoped access reaches the people who report to someone, through their managers, not everyone in the roles below." />
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
          const holders = people?.filter((person) => person.orgRoleId === role.id) ?? [];
          const reachOfHolders = people ? holders.map((holder) => ({ holder, line: reportingLineOf(people, holder.id) })) : null;
          const isOwnRole = viewer.orgRoleId === role.id && !viewer.superAdmin;
          const isRoot = role.parentId === null;
          const aboveIds = new Set(above.map((step) => step.id));
          const relationOf = (roleId: string): RoleRelation =>
            roleId === role.id ? 'chosen' : aboveIds.has(roleId) ? 'above' : below.has(roleId) ? 'below' : 'other';
          // The chosen role always stays visible, even if a role above it was collapsed.
          const visibleCollapsedIds = new Set([...collapsedIds].filter((roleId) => !aboveIds.has(roleId)));

          return (
            <>
              <div className="split split-wide-side">
                <section className="side" aria-label="Org tree">
                  <div className="side-head">
                    <span>Tree</span>
                    {canCreate ? <button type="button" className="link" onClick={() => setDialog('add-child')}>+ Role below</button> : null}
                  </div>
                  <div className="org-tree-tools">
                    <button type="button" className="link" onClick={() => setCollapsedIds(new Set())}>Expand all</button>
                    <button type="button" className="link" onClick={() => setCollapsedIds(new Set(roles.filter((candidate) => candidate.depth > 0 && roles.some((child) => child.parentId === candidate.id)).map((candidate) => candidate.id)))}>Collapse all</button>
                  </div>
                  <OrgTreeLegend />
                  <OrgTree
                    roles={roles}
                    chosenId={role.id}
                    relationOf={relationOf}
                    collapsedIds={visibleCollapsedIds}
                    onChoose={setChosenId}
                    onToggle={(roleId) => setCollapsedIds((previous) => {
                      const next = new Set(previous);
                      if (next.has(roleId)) next.delete(roleId); else next.add(roleId);
                      return next;
                    })}
                  />
                  <p className="meta org-tree-summary">{peopleCount(peopleBelow)} in {rolesBelow.length} {rolesBelow.length === 1 ? 'level' : 'levels'} below {role.name}. Each person's team reaches only their own reporting line, so two people in {role.name} lead separate teams.</p>
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
                    <p className="note">Team-scoped permissions reach a person and everyone who reports to them, directly or through others, whatever their org role. The tree only names job levels. Permissions come from each person&apos;s profile.</p>
                    {reachOfHolders === null ? <p className="empty">Seeing each person&apos;s reporting line needs user.read.</p>
                      : reachOfHolders.length === 0 ? <p className="empty">Nobody is in this role, so it reaches nobody.</p>
                      : reachOfHolders.map(({ holder, line }) => (
                        <Row key={holder.id} label={holder.name}>
                          {line.length === 0 ? 'Nobody reports to them' : (
                            <span title={line.map((person) => person.name).join(', ')}>{peopleCount(line.length)}: {line.map((person, index) => <span key={person.id}>{index > 0 ? ', ' : ''}<Link className="link" href={`/people/${encodeURIComponent(person.id)}`}>{person.name}</Link></span>)}</span>
                          )}
                        </Row>
                      ))}
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
