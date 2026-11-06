import type { RequestHandler } from 'express';
import type { Config } from '../../../config.js';
import type { ApiRoute } from '../../../lib/apiRoute.js';
import { getModuleAccessForUser, listModulesForUser } from './access.service.js';
import { getCaller } from './caller.js';

export function createAccessRoutes(config: Config): ApiRoute[] {
  const getMyModules: RequestHandler = async (req, res) => {
    const modules = await listModulesForUser(getCaller(req).user, config.moduleFrontendUrls);
    res.json({ modules });
  };

  const getMyPermissions: RequestHandler = async (req, res) => {
    const moduleKey = String(req.params.module);
    const access = await getModuleAccessForUser(getCaller(req).user, moduleKey);
    res.json({ module: moduleKey, ...access });
  };

  return [
    { method: 'GET', path: '/me/modules', access: 'signed', handler: getMyModules },
    { method: 'GET', path: '/me/permissions/:module', access: 'signed', handler: getMyPermissions },
  ];
}
