import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { paginationQueryFields } from '../../../lib/query.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { QA_RESULTS, TASK_STATUSES } from '../models/task.js';
import {
  addTaskComment,
  approveTask,
  cancelTask,
  completeQa,
  completeTask,
  createTask,
  getTask,
  getTaskHistory,
  handOverToQa,
  listTaskComments,
  listTasks,
  pauseQa,
  pauseTask,
  revertTask,
  setTaskReferences,
  startQa,
  startTask,
  updateTask,
} from './task.service.js';
import { HOURS_BASES } from './taskLifecycle.js';

const MAX_ID_LENGTH = 100;
const MAX_TITLE_LENGTH = 300;
const MAX_TEXT_LENGTH = 10000;
const MAX_REFERENCES = 50;

const idField = z.string().min(1, 'is required').max(MAX_ID_LENGTH);
const hoursField = z.number().min(0, 'can not be below zero');
const dateField = z.iso.date('must be a date, such as 2026-12-01').transform((value) => new Date(value));
const versionField = z.number().int().min(0);
const textField = z.string().trim().min(1, 'is required').max(MAX_TEXT_LENGTH);

const listQuerySchema = z.object({
  ...paginationQueryFields,
  projectId: idField.optional(),
  status: z.enum(TASK_STATUSES).optional(),
  assignedDevId: idField.optional(),
  // Query strings carry text, so only the word true asks for overdue tasks.
  overdue: z.enum(['true', 'false']).optional().transform((value) => value === 'true'),
});

const pageQuerySchema = z.object(paginationQueryFields);

const createBodySchema = z.strictObject({
  projectId: idField,
  title: z.string().trim().min(1, 'is required').max(MAX_TITLE_LENGTH),
  description: z.string().max(MAX_TEXT_LENGTH).optional(),
  assignedDevId: idField,
  tlId: idField.optional(),
  estimatedHours: hoursField,
  dueDate: dateField.optional(),
});

const updateBodySchema = z
  .strictObject({
    title: z.string().trim().min(1, 'is required').max(MAX_TITLE_LENGTH).optional(),
    description: z.string().max(MAX_TEXT_LENGTH).optional(),
    assignedDevId: idField.optional(),
    tlId: idField.optional(),
    estimatedHours: hoursField.optional(),
    dueDate: dateField.optional(),
    version: versionField.optional(),
  })
  .refine(({ version: _version, ...changes }) => Object.keys(changes).length > 0, { message: 'send at least one field to change' });

const qaHandoverBodySchema = z.strictObject({ qaId: idField, qaEstimatedHours: hoursField.optional() });
const qaCompleteBodySchema = z.strictObject({ result: z.enum(QA_RESULTS) });

const hoursChoiceSchema = z.strictObject({ basis: z.enum(HOURS_BASES), customHours: z.number().optional() });
const approveBodySchema = z.strictObject({ hours: hoursChoiceSchema, qaHours: hoursChoiceSchema.optional(), version: versionField.optional() });

const revertBodySchema = z.strictObject({ comment: textField });
const commentBodySchema = z.strictObject({ body: textField });
const referencesBodySchema = z.strictObject({ taskIds: z.array(idField).max(MAX_REFERENCES) });

const taskIdOf = (params: Record<string, unknown>) => String(params.id);

const handleList: RequestHandler = async (req, res) => {
  res.json(await listTasks(getActor(req), scopeOf(req), parseRequestQuery(listQuerySchema, req.query)));
};

const handleGet: RequestHandler = async (req, res) => {
  res.json(await getTask(getActor(req), scopeOf(req), taskIdOf(req.params)));
};

const handleCreate: RequestHandler = async (req, res) => {
  res.status(201).json(await createTask(getActor(req), scopeOf(req), parseRequestBody(createBodySchema, req.body)));
};

const handleUpdate: RequestHandler = async (req, res) => {
  res.json(await updateTask(getActor(req), scopeOf(req), taskIdOf(req.params), parseRequestBody(updateBodySchema, req.body)));
};

/** For steps that take no body: the service decides everything from the task and who's asking. */
const handleStep = (step: typeof startTask): RequestHandler => async (req, res) => {
  res.json(await step(getActor(req), scopeOf(req), taskIdOf(req.params)));
};

const handleQaHandover: RequestHandler = async (req, res) => {
  res.json(await handOverToQa(getActor(req), scopeOf(req), taskIdOf(req.params), parseRequestBody(qaHandoverBodySchema, req.body)));
};

const handleQaComplete: RequestHandler = async (req, res) => {
  const { result } = parseRequestBody(qaCompleteBodySchema, req.body);
  res.json(await completeQa(getActor(req), scopeOf(req), taskIdOf(req.params), result));
};

const handleApprove: RequestHandler = async (req, res) => {
  res.json(await approveTask(getActor(req), scopeOf(req), taskIdOf(req.params), parseRequestBody(approveBodySchema, req.body)));
};

const handleRevert: RequestHandler = async (req, res) => {
  const { comment } = parseRequestBody(revertBodySchema, req.body);
  res.json(await revertTask(getActor(req), scopeOf(req), taskIdOf(req.params), comment));
};

const handleHistory: RequestHandler = async (req, res) => {
  res.json(await getTaskHistory(getActor(req), scopeOf(req), taskIdOf(req.params), parseRequestQuery(pageQuerySchema, req.query)));
};

const handleListComments: RequestHandler = async (req, res) => {
  res.json(await listTaskComments(getActor(req), scopeOf(req), taskIdOf(req.params), parseRequestQuery(pageQuerySchema, req.query)));
};

const handleAddComment: RequestHandler = async (req, res) => {
  const { body } = parseRequestBody(commentBodySchema, req.body);
  res.status(201).json(await addTaskComment(getActor(req), scopeOf(req), taskIdOf(req.params), body));
};

const handleSetReferences: RequestHandler = async (req, res) => {
  const { taskIds } = parseRequestBody(referencesBodySchema, req.body);
  res.json(await setTaskReferences(getActor(req), scopeOf(req), taskIdOf(req.params), taskIds));
};

// Timer and QA steps need only task.read: the service lets just the assignee or the QA person take them.
export const taskRoutes: ApiRoute[] = [
  { method: 'GET', path: '/tasks/tasks', access: 'private', permission: 'task.read', handler: handleList },
  { method: 'POST', path: '/tasks/tasks', access: 'private', permission: 'task.create', handler: handleCreate },
  { method: 'GET', path: '/tasks/tasks/:id', access: 'private', permission: 'task.read', handler: handleGet },
  { method: 'PATCH', path: '/tasks/tasks/:id', access: 'private', permission: 'task.update', handler: handleUpdate },
  { method: 'POST', path: '/tasks/tasks/:id/start', access: 'private', permission: 'task.read', handler: handleStep(startTask) },
  { method: 'POST', path: '/tasks/tasks/:id/pause', access: 'private', permission: 'task.read', handler: handleStep(pauseTask) },
  { method: 'POST', path: '/tasks/tasks/:id/complete', access: 'private', permission: 'task.read', handler: handleStep(completeTask) },
  { method: 'POST', path: '/tasks/tasks/:id/qa-handover', access: 'private', permission: 'task.update', handler: handleQaHandover },
  { method: 'POST', path: '/tasks/tasks/:id/qa-start', access: 'private', permission: 'task.read', handler: handleStep(startQa) },
  { method: 'POST', path: '/tasks/tasks/:id/qa-pause', access: 'private', permission: 'task.read', handler: handleStep(pauseQa) },
  { method: 'POST', path: '/tasks/tasks/:id/qa-complete', access: 'private', permission: 'task.read', handler: handleQaComplete },
  { method: 'POST', path: '/tasks/tasks/:id/approve', access: 'private', permission: 'task.approve', handler: handleApprove },
  { method: 'POST', path: '/tasks/tasks/:id/revert', access: 'private', permission: 'task.approve', handler: handleRevert },
  // Tasks are never deleted. Cancelling is the closest thing, so it needs task.delete.
  { method: 'POST', path: '/tasks/tasks/:id/cancel', access: 'private', permission: 'task.delete', handler: handleStep(cancelTask) },
  { method: 'GET', path: '/tasks/tasks/:id/history', access: 'private', permission: 'task.read', handler: handleHistory },
  { method: 'GET', path: '/tasks/tasks/:id/comments', access: 'private', permission: 'task.read', handler: handleListComments },
  { method: 'POST', path: '/tasks/tasks/:id/comments', access: 'private', permission: 'task.read', handler: handleAddComment },
  { method: 'PUT', path: '/tasks/tasks/:id/references', access: 'private', permission: 'task.update', handler: handleSetReferences },
];
