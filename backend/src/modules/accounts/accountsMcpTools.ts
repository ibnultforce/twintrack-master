import { z } from 'zod';
import { ApiError } from '../../lib/errors.js';
import { buildActorIn } from '../master/access/access.service.js';
import { toolError, toolResult, type McpCaller, type McpToolProvider } from '../master/mcp/mcpTools.js';
import { ACCOUNTS_MODULE_KEY } from './accountsModule.js';
import type { Actor } from '../master/access/caller.js';
import { getCashAndBank } from './cashBank/cashBank.service.js';
import { isRealDate, todayAsEntryDate } from './ledger/ledger.service.js';
import { getBalanceSheet, getCashFlow, getDashboard, getProfitAndLoss } from './reports/reports.service.js';
import { getTrialBalanceView } from './generalLedger/generalLedger.service.js';

/*
 * Read-only Accounts tools for the Claude assistant: balances and the four reports. They change nothing, and each
 * checks the caller's Accounts profile the way its route does, so the assistant sees only what its screen would.
 */

const READ_BOOKS = 'ledgerAccount.read';
const amountsNote = 'Amounts are paisa (100 paisa = Tk 1) on each account\'s normal side. The financial year runs July to June.';

const dateField = z.string().refine(isRealDate, 'must be a real date as YYYY-MM-DD');
const monthField = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be a month as YYYY-MM');

/** Every tool reads the whole books, which needs chart read access, as the matching routes do. */
async function requireBooksReader(caller: McpCaller): Promise<Actor> {
  const actor = await buildActorIn(caller, ACCOUNTS_MODULE_KEY);
  if (!actor?.permissions[READ_BOOKS]) throw new ApiError(403, 'forbidden', `You need ${READ_BOOKS} in Accounts to read this.`);
  return actor;
}

async function answer(caller: McpCaller, work: (actor: Actor) => Promise<unknown>) {
  try {
    return toolResult(await work(await requireBooksReader(caller)));
  } catch (error) {
    if (error instanceof ApiError) return toolError(error.message);
    throw error;
  }
}

const periodShape = { from: dateField.describe('First day, YYYY-MM-DD'), to: dateField.describe('Last day, YYYY-MM-DD') };
const refusedPeriod = (from: string, to: string) => (from > to ? toolError('from must be on or before to.') : null);

export const accountsMcpTools: McpToolProvider = (server, caller) => {
  server.registerTool(
    'accounts_dashboard',
    { description: `A month at a glance: cash and bank, what clients owe, what is owed to vendors, profit for the month and the financial year so far, and the largest costs. ${amountsNote}`, inputSchema: { month: monthField.describe('YYYY-MM') }, annotations: { readOnlyHint: true } },
    ({ month }) => answer(caller, () => getDashboard(month)),
  );

  server.registerTool(
    'accounts_cash_and_bank',
    { description: `Each cash and bank account's balance, with money in and out over a period (this month so far if left out). ${amountsNote}`, inputSchema: { from: dateField.optional(), to: dateField.optional() }, annotations: { readOnlyHint: true } },
    ({ from, to }) => answer(caller, (actor) => getCashAndBank(actor, { from: from ?? `${todayAsEntryDate().slice(0, 7)}-01`, to: to ?? todayAsEntryDate() })),
  );

  server.registerTool(
    'accounts_trial_balance',
    { description: `Every account's debits, credits and balance up to a date (debits minus credits). ${amountsNote}`, inputSchema: { to: dateField.optional().describe('Up to and including, YYYY-MM-DD; all entries if left out') }, annotations: { readOnlyHint: true } },
    ({ to }) => answer(caller, () => getTrialBalanceView(to)),
  );

  server.registerTool(
    'accounts_profit_and_loss',
    { description: `Income and expense accounts for a period, and the net profit. ${amountsNote}`, inputSchema: periodShape, annotations: { readOnlyHint: true } },
    ({ from, to }) => refusedPeriod(from, to) ?? answer(caller, () => getProfitAndLoss(from, to)),
  );

  server.registerTool(
    'accounts_balance_sheet',
    { description: `Assets, liabilities and equity on a date. Profit not yet closed into equity shows as its own equity lines. ${amountsNote}`, inputSchema: { to: dateField.describe('YYYY-MM-DD') }, annotations: { readOnlyHint: true } },
    ({ to }) => answer(caller, () => getBalanceSheet(to)),
  );

  server.registerTool(
    'accounts_cash_flow',
    { description: `Cash and bank movements over a period, by what they were for: running the business, assets, owners and financing. Money in is positive. ${amountsNote}`, inputSchema: periodShape, annotations: { readOnlyHint: true } },
    ({ from, to }) => refusedPeriod(from, to) ?? answer(caller, () => getCashFlow(from, to)),
  );
};
