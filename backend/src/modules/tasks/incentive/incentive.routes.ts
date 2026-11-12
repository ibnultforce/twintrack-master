import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody, parseRequestQuery } from '../../../lib/validation.js';
import { getActor } from '../../master/access/caller.js';
import { getPermissionScope as scopeOf } from '../../master/access/scope.js';
import { createIncentiveService } from './incentive.service.js';

const MAX_ID_LENGTH = 100;
const MAX_NOTES_LENGTH = 2000;
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;

const idField = z.string().min(1, 'is required').max(MAX_ID_LENGTH);
const monthField = z.coerce.number().int().min(1).max(12);
const yearField = z.coerce.number().int().min(FIRST_YEAR).max(LAST_YEAR);
const moneyField = z.number().min(0, 'can not be below zero');

// Missing means this month.
const monthQuerySchema = z.object({ month: monthField.optional(), year: yearField.optional() }).refine(
  ({ month, year }) => (month === undefined) === (year === undefined),
  { message: 'send month and year together' },
);
const ledgerQuerySchema = z.object({ userId: idField.optional(), month: monthField.optional(), year: yearField.optional() });
const monthBodySchema = z.strictObject({ month: z.number().int().min(1).max(12), year: z.number().int().min(FIRST_YEAR).max(LAST_YEAR) });
const disburseBodySchema = monthBodySchema.extend({ userId: idField });
const settingBodySchema = z.strictObject({
  earnsMonthlyIncentive: z.boolean(),
  // null uses the default rate from the API's settings.
  hourlyRate: moneyField.nullable(),
  eligibleForProjectIncentives: z.boolean(),
});
const projectIncentiveBodySchema = z.strictObject({
  enabled: z.boolean(),
  amount: moneyField.nullable().default(null),
  notes: z.string().trim().max(MAX_NOTES_LENGTH).nullable().default(null),
});

const asMonth = (query: { month?: number; year?: number }) => (query.month && query.year ? { month: query.month, year: query.year } : undefined);

/** Incentives, under the scoped incentive resource: own scope sees only your own. */
export function createIncentiveRoutes(defaultHourlyRate: number): ApiRoute[] {
  const service = createIncentiveService(defaultHourlyRate);

  const handleMonth: RequestHandler = async (req, res) => {
    res.json(await service.listMonth(getActor(req), scopeOf(req), asMonth(parseRequestQuery(monthQuerySchema, req.query))));
  };

  const handleGenerate: RequestHandler = async (req, res) => {
    res.json(await service.generateMonth(getActor(req), scopeOf(req), parseRequestBody(monthBodySchema, req.body)));
  };

  const handleDisburse: RequestHandler = async (req, res) => {
    const { userId, ...month } = parseRequestBody(disburseBodySchema, req.body);
    res.json(await service.disburse(getActor(req), scopeOf(req), userId, month));
  };

  const handleLedger: RequestHandler = async (req, res) => {
    res.json(await service.listLedger(getActor(req), scopeOf(req), parseRequestQuery(ledgerQuerySchema, req.query)));
  };

  const handleSettings: RequestHandler = async (req, res) => {
    res.json(await service.listSettings(getActor(req), scopeOf(req)));
  };

  const handleUpdateSetting: RequestHandler = async (req, res) => {
    res.json(await service.updateSetting(getActor(req), scopeOf(req), String(req.params.userId), parseRequestBody(settingBodySchema, req.body)));
  };

  const handleProjectIncentives: RequestHandler = async (req, res) => {
    res.json(await service.listProjectIncentives(getActor(req), scopeOf(req), String(req.params.id)));
  };

  const handleSetProjectIncentive: RequestHandler = async (req, res) => {
    const grant = parseRequestBody(projectIncentiveBodySchema, req.body);
    res.json(await service.setProjectIncentive(getActor(req), scopeOf(req), String(req.params.id), String(req.params.userId), grant));
  };

  return [
    { method: 'GET', path: '/tasks/incentives', access: 'private', permission: 'incentive.read', handler: handleMonth },
    { method: 'POST', path: '/tasks/incentives/generate', access: 'private', permission: 'incentive.create', handler: handleGenerate },
    { method: 'POST', path: '/tasks/incentives/disburse', access: 'private', permission: 'incentive.update', handler: handleDisburse },
    { method: 'GET', path: '/tasks/incentives/ledger', access: 'private', permission: 'incentive.read', handler: handleLedger },
    { method: 'GET', path: '/tasks/incentives/settings', access: 'private', permission: 'incentive.read', handler: handleSettings },
    { method: 'PUT', path: '/tasks/incentives/settings/:userId', access: 'private', permission: 'incentive.update', handler: handleUpdateSetting },
    { method: 'GET', path: '/tasks/projects/:id/incentives', access: 'private', permission: 'incentive.read', handler: handleProjectIncentives },
    { method: 'PUT', path: '/tasks/projects/:id/incentives/:userId', access: 'private', permission: 'incentive.update', handler: handleSetProjectIncentive },
  ];
}
