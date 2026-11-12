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

export { TASKS_MODULE_KEY } from './tasksModule.js';

/** Every built route of the Tasks module. A test checks this list against manifests/tasks.manifest.json. */
export function createTasksRoutes(config: Config, dependencies: Pick<AppDependencies, 'fileStorage'>): ApiRoute[] {
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
