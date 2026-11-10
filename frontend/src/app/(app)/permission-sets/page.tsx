'use client';

import { useState, type FormEvent } from 'react';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { GrantsMatrix } from '@/components/GrantsMatrix';
import { Card, Chips, Loaded, Notice, PageHead, StatusPill } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { addPermissionSet, getManageablePermissionSets, removePermissionSet, updatePermissionSet } from '@/lib/api/modules';
import type { Grants, ModulePerson, ModuleResource, PermissionMap, PermissionSet } from '@/lib/api/types';
import { listModulePeople } from '@/lib/api/users';
import { buildGrants, isWiderScope, permissionKey, readResourceScopes, setKeyFromName } from '@/lib/grants';
import { useLoad } from '@/lib/useLoad';

/** The permissions a set holds that this person couldn't give, which stops them changing it. */
const holdsBeyond = (permissionSet: PermissionSet, assignable: PermissionMap) =>
  Object.entries(permissionSet.permissions).some(([permission, scope]) => !assignable[permission] || isWiderScope(scope, assignable[permission]));

function NameDialog({ title, submitLabel, initialName = '', initialDescription = '', onSubmit, onClose }: {
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
        <div className="field"><label htmlFor="set-name">Name</label><input className="input" id="set-name" autoComplete="off" required value={name} onChange={(event) => setName(event.target.value)} /></div>
        <div className="field"><label htmlFor="set-description">Who is this permission set for?</label><input className="input" id="set-description" autoComplete="off" value={description} onChange={(event) => setDescription(event.target.value)} /></div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!name.trim()}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}

type SetDialog = 'new' | 'edit' | 'duplicate' | 'delete' | null;

const grantsOf = (permissionSet: PermissionSet, resources: ModuleResource[]): Grants =>
  buildGrants(new Set(Object.keys(permissionSet.permissions)), readResourceScopes(permissionSet.permissions, resources), resources, permissionSet.fieldAccess);

export default function PermissionSetsPage() {
  const data = useLoad(getManageablePermissionSets, []);
  const [moduleKey, setModuleKey] = useState('');
  const [setKey, setSetKey] = useState('');
  const [dialog, setDialog] = useState<SetDialog>(null);

  const modules = data.data ?? [];
  const module = modules.find((candidate) => candidate.key === moduleKey) ?? modules[0];
  const permissionSet = module?.permissionSets.find((candidate) => candidate.key === setKey) ?? module?.permissionSets[0];
  const isWithinOwnAccess = Boolean(permissionSet && module && !holdsBeyond(permissionSet, module.assignable));
  const canEditThisSet = isWithinOwnAccess && Boolean(module?.can.update);
  const canDuplicateThisSet = isWithinOwnAccess && Boolean(module?.can.create);
  const canDeleteThisSet = isWithinOwnAccess && Boolean(module?.can.delete);
  const holdsEveryPermission = Boolean(permissionSet && module?.resources.every((resource) => resource.actions.every((action) => permissionSet.permissions[permissionKey(resource.key, action)])));

  const holders = useLoad<ModulePerson[] | null>(async () => (module ? listModulePeople(module.key).catch(() => null) : null), [module?.key], module?.key);
  const holdersOf = (key: string) => (holders.data ?? []).filter((person) => person.permissionSets.includes(key));

  const saveNewSet = async (name: string, description: string, grants: Grants) => {
    if (!module) return;
    const key = setKeyFromName(name);
    await addPermissionSet(module.key, { key, name, description, grants });
    setSetKey(key);
    data.reload();
  };

  const explanation = (): string | null => {
    if (!permissionSet || !module) return null;
    if (!module.can.update) return 'You can read this permission set. Changing it needs permissionSet.update in this module.';
    if (!isWithinOwnAccess) return 'This permission set goes beyond your own access, so only someone who holds all of it can change it.';
    return holdsEveryPermission ? 'This set holds every permission. Saving changes turns it into a fixed list, so it won\'t pick up permissions added to the module later.' : null;
  };

  return (
    <>
      <PageHead title="Permission sets" subtitle="Named bundles given to people on top of their profile, one module at a time" />
      <Loaded state={data}>
        {() => (module ? (
          <>
            <Chips label="Choose a module" value={module.key} onChange={(key) => { setModuleKey(key); setSetKey(''); }} options={modules.map((candidate) => ({ value: candidate.key, label: candidate.name }))} />
            <div className="split">
              <section className="side" aria-label="Permission sets">
                <div className="side-head">
                  <span>Permission sets</span>
                  {module.can.create ? <button type="button" className="link" onClick={() => setDialog('new')}>+ New set</button> : null}
                </div>
                {module.permissionSets.length === 0 ? <p className="muted side-empty">No permission sets yet.</p> : null}
                {module.permissionSets.map((candidate) => (
                  <button type="button" key={candidate.key} className="item item-button" aria-current={candidate.key === permissionSet?.key} onClick={() => setSetKey(candidate.key)}>
                    <b>{candidate.name}</b>
                    <span className="count">{holdersOf(candidate.key).length}</span>
                    <small>{candidate.description || 'No description'}</small>
                  </button>
                ))}
              </section>
              <div className="pane">
                {permissionSet ? (
                  <>
                    <section className="card pane-top">
                      <div className="pane-row">
                        <div><h2>{permissionSet.name}</h2><p className="muted">{permissionSet.description || 'No description'}</p></div>
                        {canEditThisSet || canDuplicateThisSet || canDeleteThisSet ? (
                          <div className="page-actions">
                            {canEditThisSet ? <button type="button" className="btn" onClick={() => setDialog('edit')}>Edit name</button> : null}
                            {canDuplicateThisSet ? <button type="button" className="btn" onClick={() => setDialog('duplicate')}>Duplicate</button> : null}
                            {canDeleteThisSet ? <button type="button" className="btn btn-danger" onClick={() => setDialog('delete')}>Delete</button> : null}
                          </div>
                        ) : null}
                      </div>
                      {explanation() ? <p className="explain">{explanation()}</p> : null}
                    </section>
                    <Card title="What this permission set allows" aside={<span className="note">Changes apply on each person&apos;s next request</span>}>
                      <GrantsMatrix
                        key={`${module.key}:${permissionSet.key}`}
                        moduleKey={module.key}
                        permissions={permissionSet.permissions}
                        fieldAccess={permissionSet.fieldAccess}
                        assignableFields={module.assignableFields}
                        resources={module.resources}
                        apis={module.apis}
                        canEdit={canEditThisSet}
                        assignable={module.assignable}
                        onSave={async (grants) => { await updatePermissionSet(module.key, permissionSet.key, { grants }); data.reload(); }}
                      />
                    </Card>
                    {holders.data ? (
                      <Card title="People holding this set">
                        {holdersOf(permissionSet.key).length === 0 ? <p className="empty">Nobody holds this set yet.</p> : (
                          <div className="table-box">
                            <table>
                              <tbody>
                                {holdersOf(permissionSet.key).map((person) => (
                                  <tr key={person.id}><td><div className="strong">{person.name}</div><div className="meta">{person.email}</div></td><td><StatusPill status={person.status} /></td></tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                      </Card>
                    ) : null}
                  </>
                ) : <section className="card"><p className="empty">{module.name} has no permission sets yet.{module.can.create ? ' Select + New set to create the first one.' : ''}</p></section>}
              </div>
            </div>

            {dialog === 'new' ? <NameDialog title={`New permission set in ${module.name}`} submitLabel="Add set" onClose={() => setDialog(null)} onSubmit={(name, description) => saveNewSet(name, description, {})} /> : null}
            {dialog === 'duplicate' && permissionSet ? <NameDialog title={`Duplicate ${permissionSet.name}`} submitLabel="Duplicate" initialName={`${permissionSet.name} copy`} initialDescription={permissionSet.description} onClose={() => setDialog(null)} onSubmit={(name, description) => saveNewSet(name, description, grantsOf(permissionSet, module.resources))} /> : null}
            {dialog === 'edit' && permissionSet ? <NameDialog title={`Edit ${permissionSet.name}`} submitLabel="Save" initialName={permissionSet.name} initialDescription={permissionSet.description} onClose={() => setDialog(null)} onSubmit={async (name, description) => { await updatePermissionSet(module.key, permissionSet.key, { name, description }); data.reload(); }} /> : null}
            {dialog === 'delete' && permissionSet ? <ConfirmDialog title={`Delete ${permissionSet.name}?`} text="A permission set someone still holds can't be deleted." confirmLabel="Delete" isDanger onClose={() => setDialog(null)} onConfirm={async () => { await removePermissionSet(module.key, permissionSet.key); setSetKey(''); data.reload(); }} /> : null}
          </>
        ) : <section className="card"><p className="empty">There are no modules whose permission sets you can see.</p></section>)}
      </Loaded>
    </>
  );
}
