import type { AppDependencies } from '../../appDependencies.js';
import type { Config } from '../../config.js';
import type { ApiRoute } from '../../lib/apiRoute.js';
import { createSecretCipher } from '../../lib/encryption.js';
import { createAttachmentRoutes } from './attachment/attachment.routes.js';
import { createCredentialRoutes } from './credential/credential.routes.js';
import { createIncentiveRoutes } from './incentive/incentive.routes.js';
import { pointsRoutes } from './points/points.routes.js';
import { createProjectRoutes } from './project/project.routes.js';
import { taskRoutes } from './task/task.routes.js';

export { PROJECTS_MODULE_KEY } from './projectsModule.js';

/** Every built route of the Project management module. A test checks this list against manifests/projects.manifest.json. */
export function createProjectsRoutes(config: Config, dependencies: Pick<AppDependencies, 'fileStorage'>): ApiRoute[] {
  const cipher = createSecretCipher(config.encryptionKey);
  return [
    ...createProjectRoutes(config.defaultIncentiveHourlyRate),
    ...taskRoutes,
    ...pointsRoutes,
    ...createCredentialRoutes(cipher),
    ...createAttachmentRoutes(dependencies.fileStorage),
    ...createIncentiveRoutes(config.defaultIncentiveHourlyRate),
  ];
}
