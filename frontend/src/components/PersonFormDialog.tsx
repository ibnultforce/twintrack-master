'use client';

import { useState, type FormEvent } from 'react';
import { describeError } from '@/lib/api/http';
import type { Contract, OrgRole, User, UserDetails } from '@/lib/api/types';
import { listOrgRoles } from '@/lib/api/modules';
import { listAllUsers } from '@/lib/api/users';
import { useLoad } from '@/lib/useLoad';
import { Dialog } from './Dialog';
import { Notice, TextField } from './ui';

const CONTRACTS: Contract[] = ['permanent', 'intern', 'contractor'];

/** Every org role below the given one, at any depth. */
function findRolesBelow(orgRoles: OrgRole[], ancestorId: string): OrgRole[] {
  const belowIds = new Set<string>([ancestorId]);
  let isGrowing = true;
  while (isGrowing) {
    isGrowing = false;
    for (const orgRole of orgRoles) {
      if (orgRole.parentId && belowIds.has(orgRole.parentId) && !belowIds.has(orgRole.id)) {
        belowIds.add(orgRole.id);
        isGrowing = true;
      }
    }
  }
  return orgRoles.filter((orgRole) => orgRole.id !== ancestorId && belowIds.has(orgRole.id));
}

/**
 * The shared form for adding and editing a person. Submits every field, with blank optional ones as null. The employee
 * number is handed out when someone is added, so it only shows when editing, and is sent only when changed.
 */
export function PersonFormDialog({ title, submitLabel, intro, person, onSubmit, onClose }: {
  title: string;
  submitLabel: string;
  intro?: string;
  person?: User;
  onSubmit: (details: UserDetails) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(person?.name ?? '');
  const [email, setEmail] = useState(person?.email ?? '');
  const [jobTitle, setJobTitle] = useState(person?.title ?? '');
  const [department, setDepartment] = useState(person?.department ?? '');
  const [team, setTeam] = useState(person?.team ?? '');
  const [contract, setContract] = useState<Contract>(person?.contract ?? 'permanent');
  const [managerId, setManagerId] = useState(person?.managerId ?? '');
  const [orgRoleId, setOrgRoleId] = useState(person?.orgRoleId ?? '');
  const [employeeNumber, setEmployeeNumber] = useState(person?.employeeNumber ? String(person.employeeNumber) : '');
  const [error, setError] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const everyone = useLoad(listAllUsers, []);
  const orgRoles = useLoad(listOrgRoles, []);

  // With a manager chosen, the person's place in the org tree must be below the manager's org role. A manager whose org
  // role isn't known here (none set, or the tree can't be read) leaves every org role open.
  const managerOrgRoleId = (managerId && everyone.data?.find((candidate) => candidate.id === managerId)?.orgRoleId) || '';
  const managerOrgRole = orgRoles.data?.find((orgRole) => orgRole.id === managerOrgRoleId);
  const allowedOrgRoles = managerOrgRole ? findRolesBelow(orgRoles.data ?? [], managerOrgRole.id) : (orgRoles.data ?? []);
  const isOrgRoleKnown = orgRoles.data?.some((orgRole) => orgRole.id === orgRoleId) ?? false;
  const isOrgRoleBelowManager = !isOrgRoleKnown || allowedOrgRoles.some((orgRole) => orgRole.id === orgRoleId);

  const changeManager = (nextManagerId: string) => {
    setManagerId(nextManagerId);
    const nextManagerOrgRoleId = everyone.data?.find((candidate) => candidate.id === nextManagerId)?.orgRoleId;
    const nextManagerOrgRole = orgRoles.data?.find((orgRole) => orgRole.id === nextManagerOrgRoleId);
    if (nextManagerOrgRole && orgRoleId && !findRolesBelow(orgRoles.data ?? [], nextManagerOrgRole.id).some((orgRole) => orgRole.id === orgRoleId)) {
      setOrgRoleId('');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setIsBusy(true);
    setError('');
    try {
      await onSubmit({
        name,
        email,
        title: jobTitle.trim() || null,
        department: department.trim() || null,
        team: team.trim() || null,
        contract,
        managerId: managerId || null,
        orgRoleId,
        ...(employeeNumber && Number(employeeNumber) !== person?.employeeNumber && { employeeNumber: Number(employeeNumber) }),
      });
      onClose();
    } catch (failure) {
      setError(describeError(failure));
      setIsBusy(false);
    }
  };

  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={(event) => void submit(event)}>
        {intro ? <p className="note">{intro}</p> : null}
        <p className="required-legend">Fields marked <span aria-hidden="true">*</span> are required.</p>
        <TextField id="person-name" label="Name" required value={name} onChange={setName} />
        <TextField id="person-email" label="Email" type="email" required value={email} onChange={setEmail} />
        <TextField id="person-title" label="Job title" value={jobTitle} onChange={setJobTitle} />
        <TextField id="person-department" label="Department" value={department} onChange={setDepartment} />
        <TextField id="person-team" label="Team" value={team} onChange={setTeam} />
        {person ? (
          <TextField id="person-number" label="Employee number" type="number" hint="Must be unique. New people get the next one." value={employeeNumber} onChange={setEmployeeNumber} />
        ) : null}
        <div className="field">
          <label htmlFor="person-contract">Contract</label>
          <select className="input" id="person-contract" value={contract} onChange={(event) => setContract(event.target.value as Contract)}>
            {CONTRACTS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="person-manager">Manager</label>
          <select className="input" id="person-manager" value={managerId} onChange={(event) => changeManager(event.target.value)}>
            <option value="">None</option>
            {(everyone.data ?? []).filter((candidate) => candidate.id !== person?.id).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
            {/* A manager outside the viewer's reach isn't listed, but stays set unless changed. */}
            {managerId && !everyone.data?.some((candidate) => candidate.id === managerId) ? <option value={managerId}>Current manager</option> : null}
          </select>
        </div>
        <div className="field">
          <label htmlFor="person-org-role">Place in the org tree</label>
          <select className="input" id="person-org-role" required value={orgRoleId} onChange={(event) => setOrgRoleId(event.target.value)}>
            <option value="" disabled>Choose an org role</option>
            {allowedOrgRoles.map((orgRole) => <option key={orgRole.id} value={orgRole.id}>{`${'— '.repeat(orgRole.depth)}${orgRole.name}`}</option>)}
            {/* Without orgRole.read the list is empty, and a required select with no matching option would block saving. */}
            {orgRoleId && !isOrgRoleKnown ? <option value={orgRoleId}>Current org role</option> : null}
            {/* An existing person whose org role isn't below their manager's keeps it listed, so the problem is visible. */}
            {isOrgRoleKnown && !isOrgRoleBelowManager ? <option value={orgRoleId}>{orgRoles.data?.find((orgRole) => orgRole.id === orgRoleId)?.name}</option> : null}
          </select>
          {managerOrgRole ? <p className="meta">Only org roles below {managerOrgRole.name}, the manager&apos;s org role.</p> : null}
          {managerOrgRole && allowedOrgRoles.length === 0 ? <p className="meta">{managerOrgRole.name} has no org roles below it. Add one in Roles, or choose another manager.</p> : null}
          {!isOrgRoleBelowManager ? <Notice tone="danger">This org role isn&apos;t below the manager&apos;s. Choose one below {managerOrgRole?.name}.</Notice> : null}
          {orgRoles.error ? <p className="meta">The org tree could not be read, which needs orgRole.read.</p> : null}
        </div>
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={isBusy || !orgRoleId || !isOrgRoleBelowManager}>{submitLabel}</button>
        </div>
      </form>
    </Dialog>
  );
}
