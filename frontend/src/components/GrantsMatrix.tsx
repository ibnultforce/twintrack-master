'use client';

import { Fragment, useState } from 'react';
import { describeError } from '@/lib/api/http';
import { type FieldAccessMap, type Grants, type ModuleResource, type PermissionMap, type Scope } from '@/lib/api/types';
import { humanize, SCOPE_LABELS } from '@/lib/format';
import { ALL_ACTIONS, buildGrants, isWiderScope, permissionKey, readResourceScopes } from '@/lib/grants';
import { FieldAccessPanel } from './FieldAccessPanel';
import { Notice, Tabs } from './ui';

const SCOPES: Scope[] = ['own', 'team', 'all'];

function ApiList({ resource, apis }: { resource: ModuleResource; apis: Record<string, string[]> }) {
  const lines = resource.actions.flatMap((action) => (apis[permissionKey(resource.key, action)] ?? []).map((api) => ({ action, api })));
  if (lines.length === 0) return null;
  return (
    <ul className="api-list">
      {lines.map(({ action, api }) => <li key={`${action}:${api}`}><span>{humanize(action)}</span> <code>{api}</code></li>)}
    </ul>
  );
}

/**
 * Ticks which actions a profile allows in one module, and how far each resource reaches.
 * Anything this person doesn't hold is disabled. The API checks the same rule.
 */
export function GrantsMatrix({ moduleKey, permissions, fieldAccess: initialFieldAccess = {}, resources, apis, canEdit, assignable, assignableFields = null, onSave }: {
  moduleKey: string;
  permissions: PermissionMap;
  fieldAccess?: FieldAccessMap;
  resources: ModuleResource[];
  apis: Record<string, string[]>;
  canEdit: boolean;
  /** What this person may give. Null means anything, for a super admin. */
  assignable: PermissionMap | null;
  /** The protected fields this person may give access to. Null means any, for a super admin. */
  assignableFields?: FieldAccessMap | null;
  onSave: (grants: Grants) => Promise<void>;
}) {
  const [fieldAccess, setFieldAccess] = useState<FieldAccessMap>(initialFieldAccess);
  const [selected, setSelected] = useState(() => new Set(Object.keys(permissions)));
  const [scopes, setScopes] = useState(() => readResourceScopes(permissions, resources));
  const [outcome, setOutcome] = useState<{ tone: 'good' | 'danger'; text: string } | null>(null);
  // One object at a time, so a module with many objects stays short. Ticks on other tabs are kept, and Save covers all.
  const [activeKey, setActiveKey] = useState(resources[0]?.key ?? '');
  const shownResources = resources.filter((resource) => resource.key === activeKey);
  const actions = ALL_ACTIONS.filter((action) => shownResources.some((resource) => resource.actions.includes(action)));
  const tickedCount = (resource: ModuleResource) => resource.actions.filter((action) => selected.has(permissionKey(resource.key, action))).length;

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
      await onSave(buildGrants(selected, scopes, resources, fieldAccess));
      setOutcome({ tone: 'good', text: 'Saved. It applies on each person\'s next request.' });
    } catch (failure) {
      setOutcome({ tone: 'danger', text: describeError(failure) });
    }
  };

  return (
    <>
      {resources.length > 1 ? (
        <Tabs
          id={`grants-${moduleKey}`}
          label={`Objects in ${moduleKey}`}
          value={activeKey}
          onChange={setActiveKey}
          options={resources.map((resource) => ({ value: resource.key, label: resource.label, count: tickedCount(resource) }))}
        />
      ) : null}
      <div className="table-box" id={`grants-${moduleKey}-panel`} role={resources.length > 1 ? 'tabpanel' : undefined}>
        <table className="matrix">
          <thead>
            <tr><th scope="col">Resource and its APIs</th>{actions.map((action) => <th scope="col" key={action}>{humanize(action)}</th>)}<th scope="col">Whose records</th></tr>
          </thead>
          <tbody>
            {shownResources.map((resource) => {
              const holdsAny = resource.actions.some((action) => selected.has(permissionKey(resource.key, action)));
              return (
                <Fragment key={resource.key}>
                <tr>
                  <td>
                    <div className="strong">{resource.label}</div>
                    <div className="meta">{moduleKey}.{resource.key}</div>
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
                <FieldAccessPanel
                  resource={resource}
                  columnCount={actions.length + 2}
                  selectedActions={resource.actions.filter((action) => selected.has(permissionKey(resource.key, action)))}
                  fieldAccess={fieldAccess}
                  assignableFields={assignableFields}
                  canEdit={canEdit}
                  onChange={setFieldAccess}
                />
                </Fragment>
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
