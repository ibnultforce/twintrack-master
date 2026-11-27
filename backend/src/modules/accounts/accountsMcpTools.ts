import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
 * Read-only Accounts tools for Claude, over MCP and in the Accounts app's assistant: balances and the four reports. They change nothing, and each
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

/** One read-only Accounts tool: what Claude is told, what it may send, and how it is answered for a caller. */
export interface AccountsReadTool {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  run: (caller: McpCaller, input: Record<string, string | undefined>) => Promise<CallToolResult>;
}

const noRefusal = async (result: CallToolResult | null, work: () => Promise<CallToolResult>) => result ?? work();

/**
 * The six tools, shared by the MCP server (Claude Code, claude.ai) and the in-app assistant, so both see the same
 * descriptions, inputs and access checks.
 */
export const ACCOUNTS_READ_TOOLS: AccountsReadTool[] = [
  {
    name: 'accounts_dashboard',
    description: `A month at a glance: cash and bank, what clients owe, what is owed to vendors, profit for the month and the financial year so far, and the largest costs. ${amountsNote}`,
    inputSchema: z.object({ month: monthField.describe('YYYY-MM') }),
    run: (caller, { month }) => answer(caller, () => getDashboard(month as string)),
  },
  {
    name: 'accounts_cash_and_bank',
    description: `Each cash and bank account's balance, with money in and out over a period (this month so far if left out). ${amountsNote}`,
    inputSchema: z.object({ from: dateField.optional(), to: dateField.optional() }),
    run: (caller, { from, to }) => answer(caller, (actor) => getCashAndBank(actor, { from: from ?? `${todayAsEntryDate().slice(0, 7)}-01`, to: to ?? todayAsEntryDate() })),
  },
  {
    name: 'accounts_trial_balance',
    description: `Every account's debits, credits and balance up to a date (debits minus credits). ${amountsNote}`,
    inputSchema: z.object({ to: dateField.optional().describe('Up to and including, YYYY-MM-DD; all entries if left out') }),
    run: (caller, { to }) => answer(caller, () => getTrialBalanceView(to)),
  },
  {
    name: 'accounts_profit_and_loss',
    description: `Income and expense accounts for a period, and the net profit. ${amountsNote}`,
    inputSchema: z.object(periodShape),
    run: (caller, { from, to }) => noRefusal(refusedPeriod(from as string, to as string), () => answer(caller, () => getProfitAndLoss(from as string, to as string))),
  },
  {
    name: 'accounts_balance_sheet',
    description: `Assets, liabilities and equity on a date. Profit not yet closed into equity shows as its own equity lines. ${amountsNote}`,
    inputSchema: z.object({ to: dateField.describe('YYYY-MM-DD') }),
    run: (caller, { to }) => answer(caller, () => getBalanceSheet(to as string)),
  },
  {
    name: 'accounts_cash_flow',
    description: `Cash and bank movements over a period, by what they were for: running the business, assets, owners and financing. Money in is positive. ${amountsNote}`,
    inputSchema: z.object(periodShape),
    run: (caller, { from, to }) => noRefusal(refusedPeriod(from as string, to as string), () => answer(caller, () => getCashFlow(from as string, to as string))),
  },
];

export const accountsMcpTools: McpToolProvider = (server, caller) => {
  for (const tool of ACCOUNTS_READ_TOOLS) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema.shape, annotations: { readOnlyHint: true } },
      (input) => tool.run(caller, input as Record<string, string | undefined>),
    );
  }
};
