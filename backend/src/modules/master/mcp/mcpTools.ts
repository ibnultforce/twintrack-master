import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { AccessProfileDoc } from '../models/accessProfile.js';
import type { UserDoc } from '../models/user.js';

/** The person an MCP call acts for, read fresh from their token on each call. */
export interface McpCaller {
  user: UserDoc;
  profile: AccessProfileDoc | null;
}

/**
 * Adds one module's tools to the MCP server for a caller. Each module lists its own, and the app hands them all to
 * Master, which serves them. A tool must check the caller's permissions itself, the same way its route does.
 */
export type McpToolProvider = (server: McpServer, caller: McpCaller) => void;

/** A tool's answer as JSON text, which is what MCP clients show the model. */
export function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** A refusal or failure the model should read, such as missing access, rather than a protocol error. */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}
