import type { ClientSession } from 'mongoose';
import { ApiError } from '../../../lib/errors.js';
import { pageOffset, type PageRequest } from '../../../lib/query.js';
import { changeRecord } from '../../../lib/records/recordWrites.js';
import { Project, type ProjectDoc, type ProjectStatus } from '../models/project.js';

export type NewProjectRecord = Pick<ProjectDoc, '_id' | 'name' | 'description' | 'totalAllocatedHours' | 'deadline' | 'leadId' | 'memberIds'>;
export type ProjectChanges = Partial<Pick<ProjectDoc, 'name' | 'description' | 'totalAllocatedHours' | 'deadline' | 'leadId' | 'status' | 'memberIds'>>;

export const projectNotFound = () => new ApiError(404, 'unknown_project', 'No such project.');

interface WriteContext {
  actorId: string;
  expectedVersion?: number;
  session: ClientSession;
}

interface ProjectListFilter {
  /** Projects led by, or with a member among, these people. Missing means every project. */
  peopleIds?: string[];
  sharedIds?: string[];
  status?: ProjectStatus;
}

/** A project's lead and members both reach it, so a scope over any of them does too. */
export const projectReachFilter = (peopleIds: string[], sharedIds: string[] = []) => ({
  $or: [{ leadId: { $in: peopleIds } }, { memberIds: { $in: peopleIds } }, { _id: { $in: sharedIds } }],
});

export async function findProjectsPage({ peopleIds, sharedIds, status, ...page }: PageRequest & ProjectListFilter) {
  const filter = { ...(peopleIds && projectReachFilter(peopleIds, sharedIds)), ...(status && { status }) };
  const [projects, total] = await Promise.all([
    Project.find(filter).sort({ createdAt: -1, _id: 1 }).skip(pageOffset(page)).limit(page.pageSize).lean(),
    Project.countDocuments(filter),
  ]);
  return { projects, total };
}

export const findProjectById = (projectId: string) => Project.findById(projectId).lean();

export function findProjectsByIds(projectIds: string[]) {
  return Project.find({ _id: { $in: projectIds } }).lean();
}

/** Ids of the projects these people lead, whose tasks a scope over the lead reaches. */
export function findProjectIdsLedBy(peopleIds: string[]): Promise<string[]> {
  return Project.find({ leadId: { $in: peopleIds } }).distinct('_id');
}

export async function insertProject(record: NewProjectRecord, createdBy: string, session: ClientSession): Promise<ProjectDoc> {
  const [created] = await Project.create([{ ...record, createdBy, updatedBy: createdBy }], { session });
  if (!created) throw new Error('Creating the project returned nothing.');
  return created.toObject();
}

export function updateProject(projectId: string, changes: ProjectChanges, context: WriteContext) {
  return changeRecord(Project, projectId, { $set: changes }, context, projectNotFound);
}
