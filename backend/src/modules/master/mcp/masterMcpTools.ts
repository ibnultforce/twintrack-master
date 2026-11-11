import { z } from 'zod';
import { ApiError } from '../../../lib/errors.js';
import { buildActorIn, getModuleAccessForUser, listModulesForUser } from '../access/access.service.js';
import { getProfile } from '../auth/account.service.js';
import { listClients } from '../clients/clients.service.js';
import { CLIENT_STATUSES } from '../models/client.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import { listDirectory } from '../users/directory.service.js';
import { toolError, toolResult, type McpToolProvider } from './mcpTools.js';

const MAX_SEARCH_LENGTH = 100;
const MAX_RESULTS = 50;

/** Runs a tool's work, turning an expected refusal into an answer the model can read. */
async function answer(work: () => Promise<unknown>) {
  try {
    return toolResult(await work());
  } catch (error) {
    if (error instanceof ApiError) return toolError(error.message);
    throw error;
  }
}

/** Master's tools: who the caller is, what they can do, and the shared lists every module uses. */
export function createMasterMcpTools(moduleFrontendUrls: Map<string, string>): McpToolProvider {
  return (server, caller) => {
    server.registerTool(
      'whoami',
      { description: 'The signed-in person: name, job details, and the TwinTrack modules they can use.', annotations: { readOnlyHint: true } },
      () =>
        answer(async () => ({
          ...(await getProfile(caller.user)),
          modules: await listModulesForUser(caller, moduleFrontendUrls),
        })),
    );

    server.registerTool(
      'my_permissions',
      {
        description: 'What the signed-in person can do in one module, such as "hr" or "tasks", and how far each permission reaches.',
        inputSchema: { module: z.string().min(1).max(MAX_SEARCH_LENGTH).describe('The module key, from whoami') },
        annotations: { readOnlyHint: true },
      },
      ({ module }) =>
        answer(async () => {
          const { permissions, profileName, hasAccess } = await getModuleAccessForUser(caller, module);
          return { module, hasAccess, profileName, permissions };
        }),
    );

    server.registerTool(
      'find_colleagues',
      {
        description: 'Searches active colleagues by name, email or job title. Online status shows only where the person may see it.',
        inputSchema: { search: z.string().max(MAX_SEARCH_LENGTH).optional().describe('Part of a name, email or job title') },
        annotations: { readOnlyHint: true },
      },
      ({ search }) => answer(() => listDirectory(caller, { search, page: 1, pageSize: MAX_RESULTS })),
    );

    server.registerTool(
      'list_clients',
      {
        description: 'Lists clients TwinTrack works for. Needs client.read in Master.',
        inputSchema: {
          search: z.string().max(MAX_SEARCH_LENGTH).optional().describe('Part of a name, initials or email'),
          status: z.enum(CLIENT_STATUSES).optional(),
        },
        annotations: { readOnlyHint: true },
      },
      ({ search, status }) =>
        answer(async () => {
          const actor = await buildActorIn(caller, MASTER_MODULE_KEY);
          if (!actor?.permissions['client.read']) throw new ApiError(403, 'forbidden', 'You do not have permission to see clients.');
          return listClients(actor, { search, status, page: 1, pageSize: MAX_RESULTS });
        }),
    );
  };
}
