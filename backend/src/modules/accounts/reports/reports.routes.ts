import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestQuery } from '../../../lib/validation.js';
import { accountingDateField, monthField } from '../accountsFields.js';
import { getBalanceSheet, getCashFlow, getDashboard, getProfitAndLoss } from './reports.service.js';

const periodQuerySchema = z
  .object({ from: accountingDateField, to: accountingDateField })
  .refine(({ from, to }) => from <= to, { message: 'from must be on or before to', path: ['to'] });
const dateQuerySchema = z.object({ to: accountingDateField });
const monthQuerySchema = z.object({ month: monthField });

const handleProfitAndLoss: RequestHandler = async (req, res) => {
  const { from, to } = parseRequestQuery(periodQuerySchema, req.query);
  res.json(await getProfitAndLoss(from, to));
};
const handleBalanceSheet: RequestHandler = async (req, res) => {
  res.json(await getBalanceSheet(parseRequestQuery(dateQuerySchema, req.query).to));
};
const handleCashFlow: RequestHandler = async (req, res) => {
  const { from, to } = parseRequestQuery(periodQuerySchema, req.query);
  res.json(await getCashFlow(from, to));
};
const handleDashboard: RequestHandler = async (req, res) => {
  res.json(await getDashboard(parseRequestQuery(monthQuerySchema, req.query).month));
};

/** The financial reports and the dashboard. Like the trial balance they read the whole books, so they need chart read access. */
export const reportRoutes: ApiRoute[] = [
  { method: 'GET', path: '/accounts/reports/profit-and-loss', access: 'private', permission: 'ledgerAccount.read', handler: handleProfitAndLoss },
  { method: 'GET', path: '/accounts/reports/balance-sheet', access: 'private', permission: 'ledgerAccount.read', handler: handleBalanceSheet },
  { method: 'GET', path: '/accounts/reports/cash-flow', access: 'private', permission: 'ledgerAccount.read', handler: handleCashFlow },
  { method: 'GET', path: '/accounts/dashboard', access: 'private', permission: 'ledgerAccount.read', handler: handleDashboard },
];
