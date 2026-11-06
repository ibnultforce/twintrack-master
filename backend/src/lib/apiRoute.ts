import type { Application, RequestHandler } from 'express';
import type { ManifestRoute } from '../modules/master/moduleRegistry/manifest.js';

/** One API route. Its access rules come from the module's manifest, so they use the same types. */
export interface ApiRoute extends Omit<ManifestRoute, 'planned'> {
  /** Runs after the access checks, for checks that apply to this route only. */
  middleware?: RequestHandler[];
  /** For the few signed routes someone must reach before they've replaced a temporary password. */
  allowedDuringPasswordChange?: boolean;
  handler: RequestHandler;
}

/** Turns a route's declared access into the middleware that enforces it. */
export type AccessMiddlewareFor = (route: ApiRoute) => RequestHandler[];

/**
 * Registers routes directly on the app, not on mounted routers, so the Postman coverage test can see each one.
 * Access checks always come from the route's declaration, so a protected route can't go live without them.
 */
export function registerRoutes(app: Application, routes: ApiRoute[], accessMiddlewareFor: AccessMiddlewareFor): void {
  for (const route of routes) {
    const httpVerb = route.method.toLowerCase() as Lowercase<ApiRoute['method']>;
    app.route(route.path)[httpVerb]([...accessMiddlewareFor(route), ...(route.middleware ?? []), route.handler]);
  }
}
