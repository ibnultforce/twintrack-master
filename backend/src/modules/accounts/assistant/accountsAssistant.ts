import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { pino } from 'pino';
import { ApiError } from '../../../lib/errors.js';
import type { McpCaller } from '../../master/mcp/mcpTools.js';
import { ACCOUNTS_READ_TOOLS } from '../accountsMcpTools.js';
import { todayAsEntryDate } from '../ledger/ledger.service.js';

/*
 * The Claude assistant inside the Accounts app. Claude answers with the same six read-only tools it gets over MCP,
 * run as the signed-in person, so it sees exactly what their Accounts profile allows and can change nothing.
 */

const ASSISTANT_MODEL = 'claude-opus-5-5';
const MAX_REPLY_TOKENS = 16000;
/** Requests to Claude in one reply: tool calls plus the answer. Enough for a few reports side by side. */
const MAX_TOOL_ROUNDS = 8;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantReply {
  reply: string;
  /** The tools Claude used for this answer, in order, so the screen can show what it read. */
  toolsUsed: string[];
}

export interface AccountsAssistant {
  isConfigured: boolean;
  reply(caller: McpCaller, conversation: ChatTurn[]): Promise<AssistantReply>;
}

function systemPrompt(): string {
  return [
    "You are the assistant inside TwinTrack Accounts, a company's bookkeeping app. You answer questions about the company's books for the person signed in.",
    'Use the tools to read the books; never guess a figure. Tools return amounts in paisa: show them to people in taka as "Tk 1,234.50", with Bangladeshi digit grouping (Tk 1,12,40,000).',
    'You can only read. If someone asks you to record, approve, pay or change anything, say that you can\'t, and which screen in Accounts does it.',
    'If a tool says the person lacks access, tell them plainly that their profile doesn\'t include it.',
    'Answer in a few short sentences. Your answer is shown as plain text, so write no Markdown: no tables, headings, bold or bullet symbols; put each figure on its own line when listing several. The financial year runs July to June.',
    `Today is ${todayAsEntryDate()}.`,
  ].join('\n');
}

/** The tool's answer as text Claude reads. A refusal, such as missing access, is passed on for Claude to explain. */
const toolText = (result: CallToolResult) =>
  result.content.map((block) => (block.type === 'text' ? block.text : '')).join('\n');

function buildTools(caller: McpCaller, toolsUsed: string[]) {
  return ACCOUNTS_READ_TOOLS.map((tool) => betaZodTool({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    run: async (input) => {
      toolsUsed.push(tool.name);
      return toolText(await tool.run(caller, input as Record<string, string | undefined>));
    },
  }));
}

const replyText = (message: Anthropic.Beta.BetaMessage) =>
  message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n\n').trim();

/** Turns the API's failures into answers the screen can show, without passing on its internal details. */
function describeFailure(error: unknown): ApiError {
  if (error instanceof Anthropic.RateLimitError) return new ApiError(503, 'assistant_busy', 'Claude is busy right now. Try again in a minute.');
  if (error instanceof Anthropic.AuthenticationError) return new ApiError(503, 'assistant_not_configured', 'The assistant\'s Anthropic API key was refused. Ask whoever runs TwinTrack to check ANTHROPIC_API_KEY.');
  return new ApiError(502, 'assistant_unavailable', 'Claude couldn\'t be reached. Try again.');
}

export function createClaudeAssistant(apiKey: string, logLevel: string): AccountsAssistant {
  const client = new Anthropic({ apiKey });
  const logger = pino({ level: logLevel });

  return {
    isConfigured: true,
    async reply(caller, conversation) {
      const toolsUsed: string[] = [];
      let finalMessage: Anthropic.Beta.BetaMessage;
      try {
        finalMessage = await client.beta.messages.toolRunner({
          model: ASSISTANT_MODEL,
          max_tokens: MAX_REPLY_TOKENS,
          max_iterations: MAX_TOOL_ROUNDS,
          output_config: { effort: 'medium' },
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: systemPrompt(),
          tools: buildTools(caller, toolsUsed),
          messages: conversation.map((turn) => ({ role: turn.role, content: turn.content })),
        });
      } catch (error) {
        if (error instanceof ApiError) throw error;
        // The API's message is logged for whoever runs the server; the person sees only describeFailure's words.
        logger.error({ reason: (error as Error).message, status: (error as { status?: number }).status }, 'The Accounts assistant request to Claude failed');
        throw describeFailure(error);
      }

      if (finalMessage.stop_reason === 'refusal') {
        return { reply: 'I can\'t help with that request. Ask me about balances, reports or the books instead.', toolsUsed };
      }
      if (finalMessage.stop_reason === 'tool_use') {
        return { reply: 'That needed more reading than I can do in one answer. Try asking about one thing at a time.', toolsUsed };
      }
      return { reply: replyText(finalMessage) || 'I have no answer to that.', toolsUsed };
    },
  };
}

/** Used when no ANTHROPIC_API_KEY is set: every question gets a clear "not set up" answer instead of a failure. */
export function createDisabledAssistant(): AccountsAssistant {
  return {
    isConfigured: false,
    async reply() {
      throw new ApiError(503, 'assistant_not_configured', 'The Claude assistant isn\'t set up on this server. Ask whoever runs TwinTrack to set ANTHROPIC_API_KEY.');
    },
  };
}
