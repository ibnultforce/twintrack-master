'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Card, Chips, Loaded, Notice, PageHead, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { addRole, getManageableRoles, listModules, listRoles, removeRole, updateRole } from '@/lib/api/modules';
import type { ModulePerson, ModuleResource, PermissionMap, RoleGrants, RoleTemplate, Scope } from '@/lib/api/types';
import { listModulePeople } from '@/lib/api/users';
import { humanize, SCOPE_LABELS } from '@/lib/format';
import { ALL_ACTIONS, buildRoleGrants, isWiderScope, permissionKey, readResourceScopes, roleKeyFromName } from '@/lib/roleGrants';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

const SCOPES: Scope[] = ['own', 'team', 'all'];

interface RoleModule {
  key: string;
  name: string;
  /** Missing when this person can read roles but not the module's resources. */
  resources?: ModuleResource[];
  apis: Record<string, string[]>;
  roles: RoleTemplate[];
  /** What this person may put in a role. Null means they can only read this module's roles. */
  assignable: PermissionMap | null;
}

async function loadRoleModules(canEditRoles: boolean, canReadRoles: boolean, canReadModules: boolean): Promise<RoleModule[]> {
  const [manageable, roles, registered] = await Promise.all([
    canEditRoles ? getManageableRoles() : Promise.resolve([]),
    canReadRoles ? listRoles() : Promise.resolve([]),
    canReadModules ? listModules() : Promise.resolve([]),
  ]);

  const modules = new Map<string, RoleModule>();
  for (const module of registered) {
    modules.set(module.key, { key: module.key, name: module.name, resources: module.resources, apis: module.apis, roles: [], assignable: null });
  }
  for (const role of roles) {
    const module = modules.get(role.module) ?? { key: role.module, name: role.moduleName, apis: {}, roles: [], assignable: null };
    module.roles.push(role);
    modules.set(role.module, module);
  }
  for (const module of manageable) modules.set(module.key, module);
  return [...modules.values()];
}

/** The permissions a role holds that this person couldn't give, which stops them changing it. */
const holdsBeyond = (role: RoleTemplate, assignable: PermissionMap) =>
  Object.entries(role.permissions).some(([permission, scope]) => !assignable[permission] || isWiderScope(scope, assignable[permission]));

function ApiList({ resource, apis }: { resource: ModuleResource; apis: Record<string, string[]> }) {
  const lines = resource.actions.flatMap((action) => (apis[permissionKey(resource.key, action)] ?? []).map((api) => ({ action, api })));
  if (lines.length === 0) return null;
  return (
    <ul className="api-list">
      {lines.map(({ action, api }) => <li key={`${action}:${api}`}><span>{humanize(action)}</span> <code>{api}</code></li>)}
    </ul>
  );
}

function RoleMatrix({ role, resources, apis, canEdit, assignable, onSaved }: {
  role: RoleTemplate;
  resources: ModuleResource[];
  apis: Record<string, string[]>;
  canEdit: boolean;
  assignable: PermissionMap | null;
  onSaved: () => void;
}) {
  const [selected, setSelected] = useState(() => new Set(Object.keys(role.permissions)));
  const [scopes, setScopes] = useState(() => readResourceScopes(role.permissions, resources));
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'danger'; text: string } | null>(null);
  const actions = ALL_ACTIONS.filter((action) => resources.some((resource) => resource.actions.includes(action)));

  const toggle = (resource: ModuleResource, permission: string) => {
    const next = new Set(selected);
    if (next.has(permission)) {
      next.delete(permission);
    } else {
      next.add(permission);
      // One reach covers the whole resource, so ticking something held more narrowly has to narrow it.
      const heldScope = assignable?.[permission];
      const chosenScope = scopes[resource.key];
      if (resource.scoped && heldScope && chosenScope && isWiderScope(chosenScope, heldScope)) setScopes({ ...scopes, [resource.key]: heldScope });
    }
    setSelected(next);
  };

  /** One reach applies to a whole resource, so it can't exceed what this person holds for any action ticked there. */
  const isScopeAvailable = (resource: ModuleResource, scope: Scope) =>
    !assignable || resource.actions.every((action) => {
      const permission = permissionKey(resource.key, action);
      return !selected.has(permission) || (assignable[permission] !== undefined && !isWiderScope(scope, assignable[permission]));
    });

  const save = async () => {
    try {
      await updateRole(role.module, role.key, { grants: buildRoleGrants(selected, scopes, resources) });
      setOutcome({ tone: 'good', text: 'Saved. It applies on each person\'s next request.' });
      onSaved();
    } catch (failure) {
      setOutcome({ tone: 'danger', text: describeError(failure) });
    }
  };

  return (
    <>
      <div className="table-box">
        <table className="matrix">
          <thead>
            <tr><th scope="col">Resource and its APIs</th>{actions.map((action) => <th scope="col" key={action}>{humanize(action)}</th>)}<th scope="col">Whose records</th></tr>
          </thead>
          <tbody>
            {resources.map((resource) => {
              const holdsAny = resource.actions.some((action) => selected.has(permissionKey(resource.key, action)));
              return (
                <tr key={resource.key}>
                  <td>
                    <div className="strong">{resource.label}</div>
                    <div className="meta">{role.module}.{resource.key}</div>
                    <ApiList resource={resource} apis={apis} />
                  </td>
                  {actions.map((action) => {
                    if (!resource.actions.includes(action)) return <td className="muted" key={action} aria-hidden="true">–</td>;
                    const permission = permissionKey(resource.key, action);
                    const isAssignable = !assignable || assignable[permission] !== undefined;
                    return <td key={action}><input type="checkbox" className="grant-box" aria-label={`${humanize(action)} ${resource.label}`} checked={selected.has(permission)} disabled={!canEdit || !isAssignable} onChange={() => toggle(resource, permission)} /></td>;
                  })}
                  <td>
                    {resource.scoped ? (
                      <div className="segmented" role="group" aria-label={`Whose ${resource.label}`}>
                        {SCOPES.map((scope) => (
                          <button key={scope} type="button" aria-pressed={holdsAny && scopes[resource.key] === scope} disabled={!canEdit || !holdsAny || !isScopeAvailable(resource, scope)} onClick={() => setScopes({ ...scopes, [resource.key]: scope })}>{SCOPE_LABELS[scope]}</button>
                        ))}
                      </div>
                    ) : <span className="muted">Everyone</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {outcome ? <div className="spaced"><Notice tone={outcome.tone}>{outcome.text}</Notice></div> : null}
      {canEdit ? <div className="actions"><button type="button" className="btn btn-primary" onClick={() => void save()}>Save permissions</button></div> : null}
    </>
  );
}

function RoleFormDialog({ title, submitLabel, initialName = '', initialDescription = '', onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  initialName?: string;
  initialDescription?: string;
  onSubmit: (name: string, description: string) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await onSubmit(name.trim(), description.trim());
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <div className="field"><label htmlFor="role-name">Role name</label><input className="input" id="role-name" autoComplete="off" required value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="role-description">Who is this role for?</label><input className="input" id="role-description" autoComplete="off" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

type RoleDialog = 'new' | 'edit' | 'duplicate' | 'delete' | null;

function grantsFromRole(role: RoleTemplate, resources: ModuleResource[]): RoleGrants {
  return buildRoleGrants(new Set(Object.keys(role.permissions)), readResourceScopes(role.permissions, resources), resources);
}

export default function RolesPage() {
  const { can, canEditRoles } = useSession();
  const canReadRoles = can('role.read');
  const canReadModules = can('module.read');
  const data = useLoad(() => loadRoleModules(canEditRoles, canReadRoles, canReadModules), [canEditRoles, canReadRoles, canReadModules]);
  const [moduleKey, setModuleKey] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [dialog, setDialog] = useState<RoleDialog>(null);

  const modules = data.data ?? [];
  const module = modules.find((candidate) => candidate.key === moduleKey) ?? modules[0];
  const role = module?.roles.find((candidate) => candidate.key === roleKey) ?? module?.roles[0];
  const resources = module?.resources;
  const canCreateRoles = Boolean(module?.assignable && resources);
  const canEditThisRole = Boolean(role && module?.assignable && !holdsBeyond(role, module.assignable));
  const holdsEveryPermission = Boolean(role && resources?.every((resource) => resource.actions.every((action) => role.permissions[permissionKey(resource.key, action)])));

  const holders = useLoad<ModulePerson[] | null>(async () => (module ? listModulePeople(module.key).catch(() => null) : null), [module?.key], module?.key);
  const holdersOf = (key: string) => (holders.data ?? []).filter((person) => person.role === key);

  const saveNewRole = async (name: string, description: string, grants: RoleGrants) => {
    if (!module) return;
    const key = roleKeyFromName(name);
    await addRole(module.key, { key, name, description, grants });
    setRoleKey(key);
    data.reload();
  };

  const explanation = (): string | null => {
    if (!role || !module) return null;
    if (!module.assignable) return 'You can read this role. Changing it needs role.update in this module.';
    if (!canEditThisRole) return 'This role goes beyond your own access, so only someone who holds all of it can change it.';
    return holdsEveryPermission ? 'This role holds every permission. Saving changes turns it into a fixed list, so it won\'t pick up permissions added to the module later.' : null;
  };

  return (
    <>
      <PageHead title="Roles" subtitle="What each role can do, and who has it" />
      <Loaded state={data}>
        {() => (module ? (
          <>
            <Chips label="Choose a module" value={module.key} onChange={setModuleKey} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
            <div className="split">
              <section className="side" aria-label="Roles">
                <div className="side-head">
                  <span>Roles</span>
                  {canCreateRoles ? <button type="button" className="link" onClick={() => setDialog('new')}>+ New role</button> : null}
                </div>
                {module.roles.length === 0 ? <p className="muted side-empty">No roles yet.</p> : null}
                {module.roles.map((candidate) => (
                  <button type="button" key={candidate.key} className="item item-button" aria-current={candidate.key === role?.key} onClick={() => setRoleKey(candidate.key)}>
                    <b>{candidate.name}</b>
                    <span className="count">{holdersOf(candidate.key).length}</span>
                    <small>{candidate.description || 'No description'}</small>
                  </button>
                ))}
              </section>
              <div className="pane">
                {role ? (
                  <>
                    <section className="card pane-top">
                      <div className="pane-row">
                        <div><h2>{role.name}</h2><p className="muted">{role.description || 'No description'}</p></div>
                        {canEditThisRole ? (
                          <div className="page-actions">
                            <button type="button" className="btn" onClick={() => setDialog('edit')}>Edit name</button>
                            {resources ? <button type="button" className="btn" onClick={() => setDialog('duplicate')}>Duplicate</button> : null}
                            <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button>
                          </div>
                        ) : null}
                      </div>
                      {explanation() ? <p className="explain">{explanation()}</p> : null}
                    </section>
                    <Card title="What this role can do" aside={<span className="note">Changes apply on each person&apos;s next request</span>}>
                      {resources
                        ? <RoleMatrix key={`${role.module}:${role.key}`} role={role} resources={resources} apis={module.apis} canEdit={canEditThisRole} assignable={module.assignable} onSaved={data.reload} />
                        : <ul className="field-list">{role.grants.map((grant) => <li key={grant}><code>{grant}</code></li>)}</ul>}
                    </Card>
                    {holders.data ? (
                      <Card title="People with this role">
                        {holdersOf(role.key).length === 0 ? <p className="empty">Nobody has this role yet.</p> : (
                          <div className="table-box">
                            <table>
                              <tbody>
                                {holdersOf(role.key).map((person) => (
                                  <tr key={person.id}><td><div className="strong">{person.name}</div><div className="meta">{person.email}</div></td><td><StatusPill status={person.status} /></td></tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </Card>
                    ) : null}
                  </>
                ) : <section className="card"><p className="empty">{module.name} has no roles yet.{canCreateRoles ? ' Select + New role to create the first one.' : ''}</p></section>}
              </div>
            </div>

            {dialog === 'new' ? <RoleFormDialog title={`New role in ${module.name}`} submitLabel="Add role" onClose={() => setDialog(null)} onSubmit={(name, description) => saveNewRole(name, description, {})} /> : null}
            {dialog === 'duplicate' && role && resources ? <RoleFormDialog title={`Duplicate ${role.name}`} submitLabel="Duplicate" initialName={`${role.name} copy`} initialDescription={role.description} onClose={() => setDialog(null)} onSubmit={(name, description) => saveNewRole(name, description, grantsFromRole(role, resources))} /> : null}
            {dialog === 'edit' && role ? <RoleFormDialog title={`Edit ${role.name}`} submitLabel="Save" initialName={role.name} initialDescription={role.description} onClose={() => setDialog(null)} onSubmit={async (name, description) => { await updateRole(role.module, role.key, { name, description }); data.reload(); }} /> : null}
            {dialog === 'delete' && role ? <ConfirmDialog title={`Delete ${role.name}?`} text="A role someone still holds can't be deleted." confirmLabel="Delete" isDanger onClose={() => setDialog(null)} onConfirm={async () => { await removeRole(role.module, role.key); setRoleKey(''); data.reload(); }} /> : null}
          </>
        ) : <section className="card"><p className="empty">There are no modules you can see roles for.</p></section>)}
      </Loaded>
    </>
  );
}
