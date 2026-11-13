'use client';

import { useState } from 'react';
import { describeError } from '@/lib/api/http';
import { changeRouteAccess } from '@/lib/api/modules';
import type { ApiAccessRule, ModuleApiRoute, ModuleResource } from '@/lib/api/types';
import { Dialog } from './Dialog';
import { Card, Chips, Notice, Pill } from './ui';

type AccessFilter = ApiAccessRule | 'any';

const ACCESS_RULE_LABELS: Record<ApiAccessRule, string> = {
  public: 'Public',
  signed: 'Signed in',
  private: 'Private',
};

const ACCESS_RULE_TONES = { public: 'warning', signed: 'neutral', private: 'good' } as const;

const ACCESS_RULE_HINTS: Record<ApiAccessRule, string> = {
  public: 'Anyone, without signing in.',
  signed: 'Any signed-in person. Someone without the permission it was built with reaches only their own records.',
  private: 'Only people whose profile gives the permission below.',
};

const ACCESS_RULE_LEGEND = 'Public: anyone, without signing in. Signed in: any signed-in person. Private: only people whose profile gives one of the permissions shown. A super admin can change a rule with Change; it applies from the next request.';

const PUBLIC_LOCKED_REASON = 'This API works before anyone signs in, such as signing in itself, so it stays public.';
const NOT_PUBLIC_REASON = 'Its code needs to know who is calling, so it can be signed in or private, but not public.';

const describePermissions = (permissions: string[]) => permissions.join(' or ');

/** Lets a super admin choose who may call one API. Only the rules its code can work with are offered. */
function RouteAccessDialog({ moduleKey, route, resources, onSaved, onClose }: {
  moduleKey: string;
  route: ModuleApiRoute;
  resources: ModuleResource[];
  onSaved: () => void;
  onClose: () => void;
}) {
  const permissionOptions = resources.flatMap((resource) => resource.actions.map((action) => `${resource.key}.${action}`));
  const [access, setAccess] = useState<ApiAccessRule>(route.access);
  const [permission, setPermission] = useState(route.permissions.length === 1 ? route.permissions[0]! : '');
  const [error, setError] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  // Several built permissions can't be picked as one, so leaving the field empty keeps them.
  const keepsBuiltPermissions = access === 'private' && !permission && route.declaredPermissions.length > 0;
  const needsPermission = access === 'private' && !permission && !keepsBuiltPermissions;

  const save = async (rule: ApiAccessRule, chosenPermission?: string) => {
    setError('');
    setIsSaving(true);
    try {
      await changeRouteAccess(moduleKey, { method: route.method, path: route.path, access: rule, ...(rule === 'private' && chosenPermission ? { permission: chosenPermission } : {}) });
      onSaved();
      onClose();
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Dialog title={`Who may call ${route.method} ${route.path}?`} onClose={onClose}>
      <form className="form" onSubmit={(event) => { event.preventDefault(); void save(access, permission); }}>
        <p className="note">
          Built as <b>{ACCESS_RULE_LABELS[route.declaredAccess]}</b>
          {route.declaredPermissions.length > 0 ? <> with <code>{describePermissions(route.declaredPermissions)}</code></> : null}. A change applies to everyone from the next request.
        </p>
        <fieldset>
          <legend>Access</legend>
          {(['public', 'signed', 'private'] as const).map((rule) => {
            const isAllowed = route.allowedAccess.includes(rule);
            return (
              <label className="check route-access-option" key={rule}>
                <input type="radio" name="route-access" value={rule} checked={access === rule} disabled={!isAllowed} onChange={() => setAccess(rule)} />
                <span>
                  <b>{ACCESS_RULE_LABELS[rule]}</b> <span className="meta">{isAllowed ? ACCESS_RULE_HINTS[rule] : rule === 'public' ? NOT_PUBLIC_REASON : PUBLIC_LOCKED_REASON}</span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {access === 'private' ? (
          <div className="field">
            <label htmlFor="route-permission">Permission that opens it</label>
            <select className="input" id="route-permission" value={permission} onChange={(event) => setPermission(event.target.value)}>
              {route.declaredPermissions.length > 1 ? <option value="">As built: {describePermissions(route.declaredPermissions)}</option> : <option value="" disabled>Choose a permission</option>}
              {permissionOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>
        ) : null}
        {access === 'signed' && route.declaredAccess === 'private' ? (
          <Notice tone="warning">Every signed-in person will be able to call this API. Anyone without {describePermissions(route.declaredPermissions)} reaches only their own records.</Notice>
        ) : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          {route.isChanged ? <button type="button" className="btn" disabled={isSaving} onClick={() => void save(route.declaredAccess, route.declaredPermissions.length === 1 ? route.declaredPermissions[0] : undefined)}>Back to as built</button> : null}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isSaving || needsPermission}>{isSaving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Every API of a module and who may call it, filterable by its access rule. A super admin can change a rule, within
 * what the API's code can work with.
 */
export function ModuleRoutes({ moduleKey, routes, resources, canChange, onChanged }: {
  moduleKey: string;
  routes: ModuleApiRoute[];
  resources: ModuleResource[];
  canChange: boolean;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState<AccessFilter>('any');
  const [editing, setEditing] = useState<ModuleApiRoute | null>(null);
  const countOf = (rule: ApiAccessRule) => routes.filter((route) => route.access === rule).length;
  const shown = filter === 'any' ? routes : routes.filter((route) => route.access === filter);

  return (
    <Card title="APIs" aside={<span className="note">{routes.length} total</span>}>
      {routes.length === 0 ? <p className="empty">This module has no APIs yet.</p> : (
        <>
          <Chips
            label="Filter by access"
            value={filter}
            onChange={setFilter}
            options={[
              { value: 'any', label: `All ${routes.length}` },
              ...(['public', 'signed', 'private'] as const).map((rule) => ({ value: rule, label: `${ACCESS_RULE_LABELS[rule]} ${countOf(rule)}` })),
            ]}
          />
          {shown.length === 0 ? <p className="empty module-routes-list">No {ACCESS_RULE_LABELS[filter as ApiAccessRule]?.toLowerCase()} APIs in this module.</p> : null}
          <ul className="api-rows api-rows-scroll module-routes-list" hidden={shown.length === 0} tabIndex={0} aria-label="APIs and their access rules">
            {shown.map((route) => (
              <li className="api-row api-row-access" key={`${route.method} ${route.path}`}>
                <span className={`method-badge method-${route.method.toLowerCase()}`}>{route.method}</span>
                <code className="api-path">{route.path}</code>
                <span className="api-permission">
                  {describePermissions(route.permissions)}
                  {route.isChanged ? <span className="meta"> · changed, built {ACCESS_RULE_LABELS[route.declaredAccess].toLowerCase()}</span> : null}
                </span>
                <Pill tone={ACCESS_RULE_TONES[route.access]}>{ACCESS_RULE_LABELS[route.access]}</Pill>
                {canChange ? (
                  route.allowedAccess.length > 1
                    ? <button type="button" className="btn btn-small" onClick={() => setEditing(route)}>Change</button>
                    : <span className="meta route-locked" title={PUBLIC_LOCKED_REASON}>Fixed</span>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="note spaced">{ACCESS_RULE_LEGEND}</p>
        </>
      )}
      {editing ? <RouteAccessDialog moduleKey={moduleKey} route={editing} resources={resources} onSaved={onChanged} onClose={() => setEditing(null)} /> : null}
    </Card>
  );
}
