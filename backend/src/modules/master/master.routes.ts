import type { Application } from 'express';
import type { AppDependencies } from '../../appDependencies.js';
import type { Config } from '../../config.js';
import type { ApiRoute } from '../../lib/apiRoute.js';
import { createSecretCipher } from '../../lib/encryption.js';
import type { UserReferenceCheck } from '../../lib/userReferences.js';
import { accessProfilesRoutes } from './accessProfiles/accessProfiles.routes.js';
import { createAccessRoutes } from './access/access.routes.js';
import { apiTokensRoutes } from './apiTokens/apiTokens.routes.js';
import { auditRoutes } from './audit/audit.routes.js';
import { clientsRoutes } from './clients/clients.routes.js';
import { customObjectsRoutes } from './customObjects/customObjects.routes.js';
import { createAuthRoutes } from './auth/auth.routes.js';
import { createImpersonationRoutes } from './auth/impersonation.routes.js';
import { healthRoutes } from './health/health.routes.js';
import { createMasterMcpTools } from './mcp/masterMcpTools.js';
import { createMcpRoutes } from './mcp/mcp.routes.js';
import type { McpToolProvider } from './mcp/mcpTools.js';
import { createModuleRegistryRoutes } from './moduleRegistry/moduleRegistry.routes.js';
import { oauthRoutes } from './oauth/oauth.routes.js';
import { createOAuthProvider, type OAuthSettings } from './oauth/oauthProvider.js';
import { mountOAuthProtocol } from './oauth/oauthProtocol.js';
import { orgRolesRoutes } from './orgRoles/orgRoles.routes.js';
import { createStorageRoutes } from './storage/storage.routes.js';
import { directoryRoutes } from './users/directory.routes.js';
import { photoRoutes } from './users/photos.routes.js';
import { createUsersRoutes } from './users/users.routes.js';

export { MASTER_MODULE_KEY } from './moduleRegistry/manifest.js';

/** Every route of the Master module. A test checks this list against manifests/master.manifest.json. */
/** What the other modules give Master, so it can serve them without knowing their data. */
export interface MasterExtensions {
  /** Lets Master refuse to delete a person a module still names. */
  userReferenceChecks: UserReferenceCheck[];
  /** Each module's tools for the MCP endpoint. */
  mcpToolProviders: McpToolProvider[];
}

const oauthSettingsFrom = (config: Config): OAuthSettings => ({ publicApiUrl: config.publicApiUrl, portalUrl: config.email.portalUrl });

/** The OAuth protocol endpoints, which come from the MCP SDK as mounted routers. See oauthProtocol.ts. */
export function mountMasterProtocols(app: Application, config: Config): void {
  const settings = oauthSettingsFrom(config);
  mountOAuthProtocol(app, createOAuthProvider(settings, createSecretCipher(config.encryptionKey)), settings);
}

export function createMasterRoutes(
  config: Config,
  dependencies: AppDependencies,
  extensions: MasterExtensions = { userReferenceChecks: [], mcpToolProviders: [] },
): ApiRoute[] {
  const mailer = { emailSender: dependencies.emailSender, settings: config.email };
  const mcpToolProviders = [createMasterMcpTools(config.moduleFrontendUrls), ...extensions.mcpToolProviders];
  return [
    ...healthRoutes,
    ...createAuthRoutes(config),
    ...createImpersonationRoutes(config.auth),
    ...createAccessRoutes(config),
    ...createUsersRoutes(mailer, extensions.userReferenceChecks),
    ...photoRoutes,
    ...directoryRoutes,
    ...orgRolesRoutes,
    ...accessProfilesRoutes,
    ...createModuleRegistryRoutes(config),
    ...auditRoutes,
    ...customObjectsRoutes,
    ...clientsRoutes,
    ...apiTokensRoutes,
    ...oauthRoutes,
    ...createMcpRoutes(oauthSettingsFrom(config), mcpToolProviders),
    ...createStorageRoutes(dependencies.localStorage, config.allowedOrigins),
  ];
}
