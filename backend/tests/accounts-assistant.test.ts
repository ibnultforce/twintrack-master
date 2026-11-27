import type { Application } from 'express';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { AccountsAssistant, ChatTurn } from '../src/modules/accounts/assistant/accountsAssistant.js';
import { ACCOUNTS_READ_TOOLS } from '../src/modules/accounts/accountsMcpTools.js';
import type { McpCaller } from '../src/modules/master/mcp/mcpTools.js';
import { AccessProfile } from '../src/modules/master/models/accessProfile.js';
import { User } from '../src/modules/master/models/user.js';
import { useTestDatabase } from './helpers/database.js';
import { addPerson, importSeedManifests, requestsAs, signIn } from './helpers/signedIn.js';
import { createTestConfig } from './helpers/testConfig.js';

const CHAT = '/accounts/assistant/messages';
const QUESTION: ChatTurn[] = [{ role: 'user', content: 'How much cash do we have?' }];

/** Stands in for Claude: records what the route hands it, and answers by running one real read-only tool as the caller. */
function createRecordingAssistant() {
  const calls: { userId: string; conversation: ChatTurn[] }[] = [];
  const assistant: AccountsAssistant = {
    isConfigured: true,
    async reply(caller, conversation) {
      calls.push({ userId: caller.user._id, conversation });
      const cashTool = ACCOUNTS_READ_TOOLS.find((tool) => tool.name === 'accounts_cash_and_bank')!;
      const result = await cashTool.run(caller, {});
      return { reply: result.isError ? 'No access.' : 'You have Tk 0 in cash and bank.', toolsUsed: [cashTool.name] };
    },
  };
  return { assistant, calls };
}

async function callerFor(userId: string): Promise<McpCaller> {
  const user = (await User.findById(userId))!;
  return { user, profile: user.profileId ? await AccessProfile.findById(user.profileId) : null };
}

describe('the Accounts Claude assistant', () => {
  useTestDatabase();

  beforeEach(async () => {
    await importSeedManifests();
    await AccessProfile.create([
      { _id: 'ap_as_reader', name: 'Books reader', grants: { accounts: { ledgerAccount: { actions: ['read'] } } } },
      { _id: 'ap_as_vouchers', name: 'Vouchers only', grants: { accounts: { journalVoucher: { actions: ['read'] } } } },
    ]);
    await addPerson('rahim', { profileId: 'ap_as_reader' });
    await addPerson('rumana', { profileId: 'ap_as_vouchers' });
  });

  const as = async (app: Application, id: string) => requestsAs(app, await signIn(app, `${id}@twintrack.test`));

  it('answers a books reader, handing Claude the conversation and the signed-in person', async () => {
    const { assistant, calls } = createRecordingAssistant();
    const app = createApp(createTestConfig(), { accountsAssistant: assistant });

    const response = await (await as(app, 'rahim')).post(CHAT, { messages: QUESTION });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ reply: 'You have Tk 0 in cash and bank.', toolsUsed: ['accounts_cash_and_bank'] });
    expect(calls).toEqual([{ userId: 'rahim', conversation: QUESTION }]);
  });

  it('refuses someone whose profile can\'t read the books, before Claude is asked', async () => {
    const { assistant, calls } = createRecordingAssistant();
    const app = createApp(createTestConfig(), { accountsAssistant: assistant });

    const response = await (await as(app, 'rumana')).post(CHAT, { messages: QUESTION });

    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it('refuses a conversation that doesn\'t end with the person\'s question', async () => {
    const { assistant } = createRecordingAssistant();
    const app = createApp(createTestConfig(), { accountsAssistant: assistant });

    const response = await (await as(app, 'rahim')).post(CHAT, { messages: [...QUESTION, { role: 'assistant', content: 'Tk 0.' }] });

    expect(response.status).toBe(422);
  });

  it('says it isn\'t set up when the server has no Anthropic API key', async () => {
    const app = createApp(createTestConfig());

    const response = await (await as(app, 'rahim')).post(CHAT, { messages: QUESTION });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('assistant_not_configured');
  });

  it('runs each tool with the caller\'s own access, so Claude can\'t read past their profile', async () => {
    const cashTool = ACCOUNTS_READ_TOOLS.find((tool) => tool.name === 'accounts_cash_and_bank')!;

    const allowed = await cashTool.run(await callerFor('rahim'), {});
    const refused = await cashTool.run(await callerFor('rumana'), {});

    expect(allowed.isError).toBeUndefined();
    expect(refused.isError).toBe(true);
  });
});
