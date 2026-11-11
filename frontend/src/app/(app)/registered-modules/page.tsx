'use client';

import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { CustomObjectDialog } from '@/components/CustomObjectDialog';
import { ConfirmDialog, Dialog } from '@/components/Dialog';
import { Card, Loaded, Notice, PageHead, Pill, TextField } from '@/components/ui';
import { describeError } from '@/lib/api/http';
import { exportModule, importModule, listModules, removeModule, removeResource, saveResource } from '@/lib/api/modules';
import type { ModuleResource, RegisteredModule, ResourceAction } from '@/lib/api/types';
import { removeCustomObject } from '@/lib/api/records';
import { humanize } from '@/lib/format';
import { ALL_ACTIONS } from '@/lib/grants';
import { useLoad } from '@/lib/useLoad';
import { useSession } from '@/session/SessionProvider';

function ActionChecks({ legend, options, selected, locked = [], onChange }: { legend: string; options: ResourceAction[]; selected: ResourceAction[]; locked?: ResourceAction[]; onChange: (actions: ResourceAction[]) => void }) {
  const toggle = (action: ResourceAction) => onChange(selected.includes(action) ? selected.filter((held) => held !== action) : [...selected, action]);
  return (
    <fieldset>
      <legend>{legend}</legend>
      <div className="check-grid">
        {options.map((action) => (
          <label className="check" key={action}><input type="checkbox" checked={selected.includes(action)} disabled={locked.includes(action)} onChange={() => toggle(action)} />{humanize(action)}</label>
        ))}
      </div>
    </fieldset>
  );
}

function ResourceDialog({ module, resource, onSaved, onClose }: { module: RegisteredModule; resource?: ModuleResource; onSaved: () => void; onClose: () => void }) {
  const [key, setKey] = useState(resource?.key ?? '');
  const [label, setLabel] = useState(resource?.label ?? '');
  const [actions, setActions] = useState<ResourceAction[]>(resource?.actions ?? []);
  const [scoped, setScoped] = useState(resource?.scoped ?? false);
  const [error, setError] = useState('');
  const { profile } = useSession();
  const isSuperAdmin = profile?.superAdmin ?? false;
  const usersOf = (action: ResourceAction) => module.usedBy[`${resource?.key}.${action}`] ?? [];
  const actionsInUse = (resource?.actions ?? []).filter((action) => usersOf(action).length > 0);
  // A super admin may remove an action in use. Everyone else sees it locked.
  const lockedActions = isSuperAdmin ? [] : actionsInUse;
  const removedInUse = actionsInUse.filter((action) => !actions.includes(action));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      await saveResource(module.key, key.trim(), { label, actions, scoped });
      onSaved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title={resource ? `Edit ${resource.label}` : `Add a resource to ${module.name}`} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        {resource ? null : <TextField id="resource-key" label="Key" hint="Letters and numbers, starting with a lowercase letter, such as bonus." required value={key} onChange={setKey} />}
        <TextField id="resource-label" label="Label" required value={label} onChange={setLabel} />
        <ActionChecks legend="Actions" options={ALL_ACTIONS} selected={actions} locked={lockedActions} onChange={setActions} />
        {lockedActions.length > 0 ? (
          <div className="note">
            <p>Locked because they&apos;re in use. To stop one person doing something, change their profile instead.</p>
            <ul>{lockedActions.map((action) => <li key={action}>{humanize(action)}: {usersOf(action).join(', ')}</li>)}</ul>
          </div>
        ) : null}
        {isSuperAdmin && removedInUse.length > 0 ? (
          <Notice tone="danger">
            <p>These are in use. Saving takes them out of every profile, and the APIs listed can then be used only by super admins.</p>
            <ul>{removedInUse.map((action) => <li key={action}>{humanize(action)}: {usersOf(action).join(', ')}</li>)}</ul>
          </Notice>
        ) : null}
        <label className="check"><input type="checkbox" checked={scoped} onChange={(event) => setScoped(event.target.checked)} />Can be limited to own records or a team</label>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={actions.length === 0}>Save</button>
        </div>
      </form>
    </Dialog>
  );
}

function ImportManifestDialog({ manifest, fileName, onImported, onClose }: { manifest: unknown; fileName: string; onImported: (message: string) => void; onClose: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    try {
      const result = await importModule(manifest, password);
      onImported(`${result.key} was ${result.created ? 'added' : 'replaced'}.`);
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    }
  };

  return (
    <Dialog title="Confirm import" onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        <p>Enter your password to import <strong>{fileName}</strong>. Nothing is saved until it&apos;s confirmed.</p>
        <TextField id="import-password" label="Your password" type="password" autoComplete="current-password" required value={password} onChange={setPassword} />
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={!password}>Import</button>
        </div>
      </form>
    </Dialog>
  );
}

function downloadJson(fileName: string, content: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

type ModulesDialog =
  | { kind: 'import-manifest'; manifest: unknown; fileName: string }
  | { kind: 'remove-module' }
  | { kind: 'add-resource' }
  | { kind: 'edit-resource' | 'remove-resource' | 'edit-object' | 'remove-object'; resource: ModuleResource }
  | { kind: 'add-object' }
  | null;

const permissionTotal = (module: RegisteredModule) => module.resources.reduce((total, resource) => total + resource.actions.length, 0);

export default function RegisteredModulesPage() {
  const { can } = useSession();
  const canAddResources = can('module.create');
  const canEditResources = can('module.update');
  const canRemoveResources = can('module.delete');
  const canChangeAnyResource = canEditResources || canRemoveResources;
  const modules = useLoad(listModules, []);
  const [chosenKey, setChosenKey] = useState('');
  const [dialog, setDialog] = useState<ModulesDialog>(null);
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'danger'; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const closeDialog = () => setDialog(null);
  const selectedModule = modules.data?.find((candidate) => candidate.key === chosenKey) ?? modules.data?.[0];

  const importManifestFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const manifest: unknown = JSON.parse(await file.text());
      setOutcome(null);
      setDialog({ kind: 'import-manifest', manifest, fileName: file.name });
    } catch {
      setOutcome({ tone: 'danger', text: 'That file isn\'t a valid JSON manifest.' });
    }
  };

  const exportManifest = async (moduleKey: string) => {
    try {
      downloadJson(`${moduleKey}.manifest.json`, await exportModule(moduleKey));
    } catch (failure) {
      setOutcome({ tone: 'danger', text: describeError(failure) });
    }
  };

  return (
    <>
      <PageHead
        title="Modules"
        subtitle="The modules loaded into Master"
        actions={(
          <>
            {selectedModule ? <button type="button" className="btn" onClick={() => void exportManifest(selectedModule.key)}>Export {selectedModule.name} manifest</button> : null}
            {can('module.create') ? (
              <>
                <input ref={fileInput} className="visually-hidden" type="file" accept=".json,application/json" tabIndex={-1} aria-label="Manifest file" onChange={(event) => void importManifestFile(event)} />
                <button type="button" className="btn btn-primary" onClick={() => fileInput.current?.click()}>Import manifest</button>
              </>
            ) : null}
          </>
        )}
      />
      {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}
      {dialog?.kind === 'import-manifest' ? <ImportManifestDialog manifest={dialog.manifest} fileName={dialog.fileName} onImported={(text) => { setOutcome({ tone: 'good', text }); modules.reload(); }} onClose={closeDialog} /> : null}
      <Loaded state={modules}>
        {(list) => {
          const module = list.find((candidate) => candidate.key === chosenKey) ?? list[0];
          if (!module) return <section className="card"><p className="empty">No modules are loaded.</p></section>;
          return (
            <>
              <div className="split">
                <section className="side" aria-label="Loaded modules">
                  <div className="side-head"><span>Loaded modules</span></div>
                  {list.map((candidate) => (
                    <button type="button" key={candidate.key} className="item item-button" aria-current={candidate.key === module.key} onClick={() => setChosenKey(candidate.key)}>
                      <b>{candidate.name}</b>
                      <span className="count">v{candidate.version}</span>
                      <small>{candidate.core ? 'Built in' : 'Add-on'} · {permissionTotal(candidate)} permissions</small>
                    </button>
                  ))}
                </section>
                <div className="pane">
                  <section className="card pane-top">
                    <div className="pane-row">
                      <div><h2>{module.name} <span className="muted">v{module.version}</span></h2><p className="muted">{module.description}</p></div>
                      {can('module.delete') && !module.core ? <button type="button" className="btn btn-danger" onClick={() => setDialog({ kind: 'remove-module' })}>Remove</button> : null}
                    </div>
                    <div className="role-meta">{module.core ? <Pill tone="accent">Core</Pill> : <Pill tone="neutral">Add-on</Pill>}<span>Frontend: {module.frontendUrl ?? 'not set'}</span></div>
                  </section>
                  <Card title="Permissions" aside={canAddResources ? <button type="button" className="link" onClick={() => setDialog({ kind: 'add-resource' })}>+ Add resource</button> : <span className="note">{permissionTotal(module)} total</span>}>
                    <div className="table-box">
                      <table>
                        <thead>
                          <tr><th scope="col">Resource</th><th scope="col">Actions</th><th scope="col">Whose records</th>{canChangeAnyResource ? <th scope="col"><span className="visually-hidden">Change</span></th> : null}</tr>
                        </thead>
                        <tbody>
                          {module.resources.map((resource) => (
                            <tr key={resource.key}>
                              <td><div className="strong">{resource.label}</div><div className="meta">{module.key}.{resource.key}</div></td>
                              <td><div className="pills">{resource.actions.map((action) => <Pill tone="neutral" key={action}>{humanize(action)}</Pill>)}</div></td>
                              <td>{resource.scoped ? 'Own, team or everyone' : 'Everyone'}</td>
                              {canChangeAnyResource ? (
                                <td>
                                  <div className="resource-actions">
                                    {canEditResources ? <button type="button" className="link" aria-label={`Edit ${resource.label}`} onClick={() => setDialog({ kind: 'edit-resource', resource })}>Edit</button> : null}
                                    {canRemoveResources ? <button type="button" className="link" aria-label={`Remove ${resource.label}`} onClick={() => setDialog({ kind: 'remove-resource', resource })}>Remove</button> : null}
                                  </div>
                                </td>
                              ) : null}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </Card>
                  <Card title="Custom objects" aside={canAddResources ? <button type="button" className="link" onClick={() => setDialog({ kind: 'add-object' })}>+ New object</button> : undefined}>
                    {module.resources.filter((resource) => resource.custom).length === 0 ? <p className="empty">No custom objects in {module.name} yet. People reach their records from the Records screen.</p> : (
                      <div className="table-box">
                        <table>
                          <thead><tr><th scope="col">Object</th><th scope="col">Fields</th><th scope="col">Sharing</th>{canChangeAnyResource ? <th scope="col"><span className="visually-hidden">Change</span></th> : null}</tr></thead>
                          <tbody>
                            {module.resources.filter((resource) => resource.custom).map((resource) => (
                              <tr key={resource.key}>
                                <td><div className="strong">{resource.label}</div><div className="meta">{module.key}.{resource.key}</div></td>
                                <td>{(resource.fields ?? []).map((field) => `${field.label}${field.protected ? ' (protected)' : ''}`).join(', ')}</td>
                                <td>{humanize(resource.sharingModel ?? 'private')}</td>
                                {canChangeAnyResource ? (
                                  <td>
                                    <div className="resource-actions">
                                      {canEditResources ? <button type="button" className="link" aria-label={`Edit ${resource.label}`} onClick={() => setDialog({ kind: 'edit-object', resource })}>Edit</button> : null}
                                      {canRemoveResources ? <button type="button" className="link" aria-label={`Remove ${resource.label}`} onClick={() => setDialog({ kind: 'remove-object', resource })}>Remove</button> : null}
                                    </div>
                                  </td>
                                ) : null}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </Card>
                </div>
              </div>

              {dialog?.kind === 'add-object' ? <CustomObjectDialog moduleKey={module.key} onSaved={modules.reload} onClose={closeDialog} /> : null}
              {dialog?.kind === 'edit-object' ? <CustomObjectDialog moduleKey={module.key} existing={dialog.resource} onSaved={modules.reload} onClose={closeDialog} /> : null}
              {dialog?.kind === 'remove-object' ? <ConfirmDialog title={`Remove ${dialog.resource.label}?`} text="It can't be removed while it has records, even in the recycle bin." confirmLabel="Remove" isDanger onClose={closeDialog} onConfirm={async () => { await removeCustomObject(module.key, dialog.resource.key); modules.reload(); }} /> : null}
              {dialog?.kind === 'remove-module' ? <ConfirmDialog title={`Remove ${module.name}?`} text="Profiles keep their part for it, which gives nothing until it is imported again." confirmLabel="Remove" isDanger onClose={closeDialog} onConfirm={async () => { await removeModule(module.key); setChosenKey(''); modules.reload(); }} /> : null}
              {dialog?.kind === 'add-resource' ? <ResourceDialog module={module} onSaved={modules.reload} onClose={closeDialog} /> : null}
              {dialog?.kind === 'edit-resource' ? <ResourceDialog module={module} resource={dialog.resource} onSaved={modules.reload} onClose={closeDialog} /> : null}
              {dialog?.kind === 'remove-resource' ? <ConfirmDialog title={`Remove ${dialog.resource.label}?`} text="It can't be removed while a profile or route still uses it." confirmLabel="Remove" isDanger onClose={closeDialog} onConfirm={async () => { await removeResource(module.key, dialog.resource.key); modules.reload(); }} /> : null}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
