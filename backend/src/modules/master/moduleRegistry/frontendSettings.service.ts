import { isWebOrigin } from '../../../config.js';
import { ApiError } from '../../../lib/errors.js';
import type { FieldError } from '../../../lib/validation.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { Module, type ModuleDoc, type ModuleFrontendSettings } from '../models/module.js';
import { findModuleByKey } from './moduleRegistry.repository.js';

export const MAX_REDIRECT_URLS = 10;
export const MAX_ALLOWED_ORIGINS = 20;

/** Plain http is only accepted for addresses on this computer in production, since codes and tokens travel over it. */
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.localhost)$/;

export interface FrontendSettingsRequest {
  frontendUrl: string | null;
  redirectUrls: string[];
  allowedOrigins: string[];
}

/** What the Modules screen shows: the saved settings, and where the frontend address comes from. */
export interface FrontendSettingsView {
  frontendUrl: string | null;
  /** `app` when a super admin saved it, `environment` when it comes from MODULE_FRONTEND_URLS. */
  frontendUrlSource: 'app' | 'environment' | null;
  redirectUrls: string[];
  allowedOrigins: string[];
  changedAt: Date | null;
}

type ModuleWithSettings = Pick<ModuleDoc, 'key'> & { frontendSettings?: ModuleFrontendSettings };

/** The address the portal sends people to: the one saved in the app, or else MODULE_FRONTEND_URLS. */
export function resolveFrontendUrl(module: ModuleWithSettings, environmentUrls: Map<string, string>): string | null {
  return module.frontendSettings?.frontendUrl ?? environmentUrls.get(module.key) ?? null;
}

export function toFrontendSettingsView(module: ModuleWithSettings, environmentUrls: Map<string, string>): FrontendSettingsView {
  const saved = module.frontendSettings;
  const frontendUrl = resolveFrontendUrl(module, environmentUrls);
  return {
    frontendUrl,
    frontendUrlSource: saved?.frontendUrl ? 'app' : frontendUrl ? 'environment' : null,
    redirectUrls: saved?.redirectUrls ?? [],
    allowedOrigins: saved?.allowedOrigins ?? [],
    changedAt: saved?.changedAt ?? null,
  };
}

function isSafeProtocol(url: URL, isProduction: boolean): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (!isProduction || LOCAL_HOST.test(url.hostname));
}

function checkRequest(request: FrontendSettingsRequest, isProduction: boolean): FieldError[] {
  const errors: FieldError[] = [];
  const insecure = 'must use https, except for an address on this computer';

  if (request.frontendUrl !== null) {
    if (!isWebOrigin(request.frontendUrl)) errors.push({ path: 'frontendUrl', message: 'must be an address such as https://hr.twintrack.com, with no path' });
    else if (!isSafeProtocol(new URL(request.frontendUrl), isProduction)) errors.push({ path: 'frontendUrl', message: insecure });
  }

  request.allowedOrigins.forEach((origin, index) => {
    const path = `allowedOrigins.${index}`;
    if (!isWebOrigin(origin)) errors.push({ path, message: 'must be an address such as https://hr.twintrack.com, with no path' });
    else if (!isSafeProtocol(new URL(origin), isProduction)) errors.push({ path, message: insecure });
  });

  const permittedOrigins = new Set([...request.allowedOrigins, ...(request.frontendUrl ? [request.frontendUrl] : [])]);
  request.redirectUrls.forEach((redirectUrl, index) => {
    const path = `redirectUrls.${index}`;
    if (!URL.canParse(redirectUrl)) {
      errors.push({ path, message: 'must be a full address such as https://hr.twintrack.com/auth/callback' });
      return;
    }
    const url = new URL(redirectUrl);
    if (url.hash || url.username || url.password) errors.push({ path, message: 'must not have a #fragment or a user name' });
    else if (!isSafeProtocol(url, isProduction)) errors.push({ path, message: insecure });
    else if (!permittedOrigins.has(url.origin)) errors.push({ path, message: `must be on the frontend address or an allowed origin (${url.origin} is neither)` });
  });
  return errors;
}

const withoutRepeats = (values: string[]) => [...new Set(values)];

/**
 * Saves where a module's frontend lives, where sign-in codes may go and which addresses may call the API. Only a super
 * admin may: whoever controls a redirect address receives people's sign-ins.
 */
export async function saveFrontendSettings(
  actor: Actor,
  moduleKey: string,
  request: FrontendSettingsRequest,
  options: { isProduction: boolean; environmentUrls: Map<string, string> },
): Promise<FrontendSettingsView> {
  if (!actor.user.superAdmin) throw new ApiError(403, 'super_admin_only', 'Only a super admin can change where a module signs people in.');
  const module = await findModuleByKey(moduleKey);
  if (!module) throw new ApiError(404, 'unknown_module', 'No such module.');

  const cleaned: FrontendSettingsRequest = {
    frontendUrl: request.frontendUrl,
    redirectUrls: withoutRepeats(request.redirectUrls),
    allowedOrigins: withoutRepeats(request.allowedOrigins),
  };
  const errors = checkRequest(cleaned, options.isProduction);
  if (errors.length > 0) throw new ApiError(422, 'validation_failed', 'Some fields are invalid.', errors);

  const frontendSettings: ModuleFrontendSettings = {
    ...(cleaned.frontendUrl && { frontendUrl: cleaned.frontendUrl }),
    redirectUrls: cleaned.redirectUrls,
    allowedOrigins: cleaned.allowedOrigins,
    changedBy: actor.user._id,
    changedAt: new Date(),
  };
  await Module.updateOne({ key: module.key }, { $set: { frontendSettings } });
  await recordAudit({
    action: 'module.frontendSettingsChanged',
    ...actorFields(actor),
    targetType: 'module',
    targetId: module.key,
    targetName: module.name,
    module: module.key,
    before: toFrontendSettingsView(module, options.environmentUrls),
    after: cleaned,
  });
  return toFrontendSettingsView({ key: module.key, frontendSettings }, options.environmentUrls);
}
