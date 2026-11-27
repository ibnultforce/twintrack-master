import type { RequestHandler } from 'express';
import { z } from 'zod';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { parseRequestBody } from '../../../lib/validation.js';
import { getCaller } from '../../master/access/caller.js';
import type { AccountsAssistant } from './accountsAssistant.js';

const MAX_TURNS = 40;
const MAX_MESSAGE_LENGTH = 4000;

const chatBodySchema = z.strictObject({
  messages: z
    .array(z.strictObject({ role: z.enum(['user', 'assistant']), content: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH) }))
    .min(1)
    .max(MAX_TURNS)
    .refine((turns) => turns[0]?.role === 'user' && turns.at(-1)?.role === 'user', 'must start and end with a user message'),
});

/**
 * The in-app Claude assistant. The screen keeps the conversation and sends it whole each time; nothing is stored.
 * It needs chart read access, like the reports Claude reads to answer.
 */
export function createAssistantRoutes(assistant: AccountsAssistant): ApiRoute[] {
  const handleChat: RequestHandler = async (req, res) => {
    const { messages } = parseRequestBody(chatBodySchema, req.body);
    res.json(await assistant.reply(getCaller(req), messages));
  };

  return [
    { method: 'POST', path: '/accounts/assistant/messages', access: 'private', permission: 'ledgerAccount.read', bodySchema: chatBodySchema, handler: handleChat },
  ];
}
