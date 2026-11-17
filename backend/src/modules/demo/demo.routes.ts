import type { ApiRoute } from '../../lib/apiRoute.js';
import { noteRoutes } from './note/note.routes.js';

export const DEMO_MODULE_KEY = 'demo';

/** Every built route of the Demo module. A test checks this list against manifests/demo.manifest.json. */
export const demoRoutes: ApiRoute[] = [...noteRoutes];
