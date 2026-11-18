import type { Application, RequestHandler } from 'express';
import type { ZodType } from 'zod';
import type { ManifestRoute } from '../modules/master/moduleRegistry/manifest.js';

/** One API route. Its access rules come from the module's manifest, so they use the same types. */
export interface ApiRoute extends Omit<ManifestRoute, 'planned'> {
  /** Runs after the access checks, for checks that apply to this route only. */
  middleware?: RequestHandler[];
  /** The schema the handler checks its body with. Read for the Try dialog's field options; the handler still validates. */
  bodySchema?: ZodType;
  handler: RequestHandler;
}

// Each registered route's body schema, by "METHOD /path", so tools can describe an API without importing its module.
const bodySchemas = new Map<string, ZodType>();

/** The body schema of a registered API, as "METHOD /path", if it takes a body. */
export const findBodySchema = (api: string): ZodType | undefined => bodySchemas.get(api);

// Every registered API as "METHOD /path", so a manifest's routes can be checked against what the backend serves.
const registeredApis = new Set<string>();

/** Whether the backend serves this API, given as "METHOD /path" with the module's base path included. */
export const isApiRegistered = (api: string): boolean => registeredApis.has(api);

/** Turns a route's declared access into the middleware that enforces it. */
export type AccessMiddlewareFor = (route: ApiRoute) => RequestHandler[];

/**
 * Registers routes directly on the app, not on mounted routers, so the Postman coverage test can see each one.
 * Access checks always come from the route's declaration, so a protected route can't go live without them.
 */
export function registerRoutes(app: Application, routes: ApiRoute[], accessMiddlewareFor: AccessMiddlewareFor): void {
  for (const route of routes) {
    const httpVerb = route.method.toLowerCase() as Lowercase<ApiRoute['method']>;
    registeredApis.add(`${route.method} ${route.path}`);
    if (route.bodySchema) bodySchemas.set(`${route.method} ${route.path}`, route.bodySchema);
    app.route(route.path)[httpVerb]([...accessMiddlewareFor(route), ...(route.middleware ?? []), route.handler]);
  }
}
