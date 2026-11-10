import type { ApiRoute } from '../../lib/apiRoute.js';
import { projectRoutes } from './project/project.routes.js';
import { taskRoutes } from './task/task.routes.js';

export { TASKS_MODULE_KEY } from './tasksModule.js';

/** Every built route of the Tasks module. A test checks this list against manifests/tasks.manifest.json. */
export const tasksRoutes: ApiRoute[] = [...projectRoutes, ...taskRoutes];
