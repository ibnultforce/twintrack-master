import type { Application, RequestHandler } from 'express';
import type { ManifestRoute } from '../modules/master/moduleRegistry/manifest.js';

/** One API route. Its access rules come from the module's manifest, so they use the same types. */
export interface ApiRoute extends Omit<ManifestRoute, 'planned'> {
  /** Runs before the handler, for checks that apply to this route only. */
  middleware?: RequestHandler[];
  handler: RequestHandler;
}

/** Registers routes directly on the app, not on mounted routers, so the Postman coverage test can see each one. */
export function registerRoutes(app: Application, routes: ApiRoute[]): void {
  for (const route of routes) {
    // Token and permission checks don't exist yet, so a protected route must not go live without them.
    if (route.access !== 'public') {
      throw new Error(`${route.method} ${route.path} needs access checks, which aren't built yet.`);
    }
    const httpVerb = route.method.toLowerCase() as Lowercase<ApiRoute['method']>;
    app.route(route.path)[httpVerb]([...(route.middleware ?? []), route.handler]);
  }
}
