import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import type { PageRequest } from '../../../lib/query.js';
import { actorFields, type Actor } from '../../master/access/caller.js';
import { peopleInScope } from '../../master/access/scope.js';
import { recordAudit } from '../../master/audit/audit.repository.js';
import type { Scope } from '../../master/moduleRegistry/manifest.js';
import { assertCanReachRecord, findSharedRecordIds, findSharingModel } from '../../master/records/recordAccess.service.js';
import { writeRecordHistory } from '../../master/records/recordHistory.service.js';
import type { ProjectDoc, ProjectStatus } from '../models/project.js';
import { countOpenTasksAssignedTo } from '../task/task.repository.js';
import { assertPeopleExist, findPeopleNames, TASKS_MODULE_KEY } from '../tasksModule.js';
import {
  findProjectById,
  findProjectsPage,
  insertProject,
  projectNotFound,
  updateProject as saveProjectChanges,
  type NewProjectRecord,
  type ProjectChanges,
} from './project.repository.js';

const PROJECT_RESOURCE = 'project';

export type NewProjectDetails = Omit<NewProjectRecord, '_id' | 'leadId' | 'memberIds'> & { leadId?: string; memberIds?: string[] };

const historyRef = (projectId: string) => ({ module: TASKS_MODULE_KEY, object: PROJECT_RESOURCE, recordId: projectId });

/** The people a project belongs to, whose place in the org tree decides whose scope reaches it. */
export const projectPeople = (project: Pick<ProjectDoc, 'leadId' | 'memberIds'>) => [project.leadId, ...project.memberIds];

const scopedProject = (project: ProjectDoc) => ({ ...historyRef(project._id), peopleIds: projectPeople(project) });

/** Whether someone may be given tasks in this project. The lead counts as a member. */
export const isProjectMember = (project: Pick<ProjectDoc, 'leadId' | 'memberIds'>, personId: string) => projectPeople(project).includes(personId);

/** Members without the lead, each listed once. */
const distinctMembers = (memberIds: string[], leadId: string) => [...new Set(memberIds)].filter((memberId) => memberId !== leadId);

export async function requireProject(projectId: string): Promise<ProjectDoc> {
  const project = await findProjectById(projectId);
  if (!project) throw projectNotFound();
  return project;
}

/** Refuses someone whose scope doesn't reach the project's lead or any member, unless it was shared with them. */
export const assertCanReachProject = (actor: Actor, scope: Scope, project: ProjectDoc, need: 'read' | 'edit') =>
  assertCanReachRecord(actor, scope, scopedProject(project), need);

function toProjectView(project: ProjectDoc, names: Map<string, string>) {
  return {
    id: project._id,
    name: project.name,
    description: project.description,
    status: project.status,
    totalAllocatedHours: project.totalAllocatedHours,
    deadline: project.deadline,
    leadId: project.leadId,
    leadName: names.get(project.leadId),
    members: project.memberIds.map((memberId) => ({ id: memberId, name: names.get(memberId) })),
    version: project.version,
    createdBy: project.createdBy,
    createdAt: project.createdAt,
    updatedBy: project.updatedBy,
    updatedAt: project.updatedAt,
  };
}

const projectAuditFields = (actor: Actor, project: ProjectDoc) => ({
  ...actorFields(actor),
  targetType: PROJECT_RESOURCE,
  targetId: project._id,
  targetName: project.name,
  module: TASKS_MODULE_KEY,
});

export async function listProjects(actor: Actor, scope: Scope, page: PageRequest & { status?: ProjectStatus }) {
  const sharingModel = await findSharingModel(TASKS_MODULE_KEY, PROJECT_RESOURCE);
  const peopleIds = sharingModel === 'private' ? await peopleInScope(actor.user._id, scope) : null;
  const sharedIds = peopleIds ? await findSharedRecordIds(actor.user, TASKS_MODULE_KEY, PROJECT_RESOURCE, 'read') : [];
  const { projects, total } = await findProjectsPage({ ...page, ...(peopleIds && { peopleIds, sharedIds }) });
  const names = await findPeopleNames(projects.flatMap(projectPeople));
  return { scope, total, projects: projects.map((project) => toProjectView(project, names)) };
}

export async function getProject(actor: Actor, scope: Scope, projectId: string) {
  const project = await requireProject(projectId);
  await assertCanReachProject(actor, scope, project, 'read');
  return toProjectView(project, await findPeopleNames(projectPeople(project)));
}

export async function createProject(actor: Actor, scope: Scope, details: NewProjectDetails) {
  const leadId = details.leadId ?? actor.user._id;
  const memberIds = distinctMembers(details.memberIds ?? [], leadId);
  await assertPeopleExist({ leadId, ...Object.fromEntries(memberIds.map((memberId, index) => [`memberIds.${index}`, memberId])) });

  const record: NewProjectRecord = { ...details, _id: `p_${randomUUID()}`, leadId, memberIds };
  // A new project has no shares, so this checks the caller's scope reaches its people.
  await assertCanReachRecord(actor, scope, { ...historyRef(record._id), peopleIds: projectPeople(record) }, 'edit');

  const project = await runInTransaction(async (session) => {
    const created = await insertProject(record, actor.user._id, session);
    await writeRecordHistory(historyRef(created._id), { action: 'created', actor, after: created }, session);
    await recordAudit({ action: 'project.created', ...projectAuditFields(actor, created) }, session);
    return created;
  });
  return toProjectView(project, await findPeopleNames(projectPeople(project)));
}

async function changeProject(actor: Actor, scope: Scope, projectId: string, auditAction: string, save: (existing: ProjectDoc, session: ClientSession) => Promise<ProjectDoc>) {
  const existing = await requireProject(projectId);
  await assertCanReachProject(actor, scope, existing, 'edit');
  const saved = await runInTransaction(async (session) => {
    const result = await save(existing, session);
    await writeRecordHistory(historyRef(projectId), { action: 'updated', actor, before: existing, after: result }, session);
    await recordAudit({ action: auditAction, ...projectAuditFields(actor, result) }, session);
    return result;
  });
  return toProjectView(saved, await findPeopleNames(projectPeople(saved)));
}

export async function updateProject(actor: Actor, scope: Scope, projectId: string, changes: Omit<ProjectChanges, 'memberIds'> & { version?: number }) {
  const { version, ...fields } = changes;
  if (fields.leadId) await assertPeopleExist({ leadId: fields.leadId });
  return changeProject(actor, scope, projectId, 'project.updated', (existing, session) => {
    // A new lead stops being listed as a member, because the lead always counts as one.
    const memberIds = fields.leadId ? distinctMembers(existing.memberIds, fields.leadId) : existing.memberIds;
    return saveProjectChanges(projectId, { ...fields, memberIds }, { actorId: actor.user._id, expectedVersion: version, session });
  });
}

/** Replaces the member list. Someone with open tasks in the project stays until those tasks are reassigned. */
export async function setProjectMembers(actor: Actor, scope: Scope, projectId: string, request: { memberIds: string[]; version?: number }) {
  const existing = await requireProject(projectId);
  const memberIds = distinctMembers(request.memberIds, existing.leadId);
  await assertPeopleExist(Object.fromEntries(memberIds.map((memberId, index) => [`memberIds.${index}`, memberId])));

  const removedIds = existing.memberIds.filter((memberId) => !memberIds.includes(memberId));
  if (removedIds.length > 0 && (await countOpenTasksAssignedTo(projectId, removedIds)) > 0) {
    throw new ApiError(409, 'member_has_open_tasks', 'Someone you removed still has open tasks in this project. Reassign or cancel them first.');
  }
  return changeProject(actor, scope, projectId, 'project.members_changed', (_existing, session) =>
    saveProjectChanges(projectId, { memberIds }, { actorId: actor.user._id, expectedVersion: request.version, session }),
  );
}
