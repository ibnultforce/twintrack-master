import { Schema, model } from 'mongoose';
import type { DataModel, ManifestResource, ManifestRoute } from '../moduleRegistry/manifest.js';
import type { RouteAccessChange } from '../moduleRegistry/routeAccess.js';

export type ModuleSource = 'file' | 'app';

/**
 * Where a module's frontend lives and what may sign in to it, set by a super admin in the app. An import keeps it,
 * since it isn't in the manifest.
 */
export interface ModuleFrontendSettings {
  /** Overrides MODULE_FRONTEND_URLS for this module. */
  frontendUrl?: string;
  /** Where Master may send a one-time sign-in code. The first is the default. */
  redirectUrls: string[];
  /** Addresses whose pages may call the API, on top of ALLOWED_ORIGINS. */
  allowedOrigins: string[];
  changedBy: string;
  changedAt: Date;
}

/** An imported module manifest, with any resources and custom objects changed in the app. */
export interface ModuleDoc {
  key: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  baseUrl?: string;
  core: boolean;
  /**
   * Where the manifest came from: `file` for the repo's manifests folder (the seed), `app` for an import in the app.
   * Modules saved before this field have none.
   */
  source?: ModuleSource;
  resources: ManifestResource[];
  routes: ManifestRoute[];
  /** Set when someone edits resources here, so an import or removal can't quietly undo that. */
  permissionsEditedAt?: Date;
  /** Access rules a super admin changed in the app. An import keeps them, since they aren't in the manifest. */
  routeAccess?: RouteAccessChange[];
  frontendSettings?: ModuleFrontendSettings;
  /** The records the API returns, as JSON Schema. From the manifest's `schema` or a schema import. */
  schema?: DataModel;
  createdAt: Date;
  updatedAt: Date;
}

const moduleSchema = new Schema<ModuleDoc>(
  {
    key: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    version: { type: String, required: true },
    description: String,
    repository: String,
    baseUrl: String,
    core: { type: Boolean, default: false },
    source: { type: String, enum: ['file', 'app'] },
    resources: { type: Schema.Types.Mixed, default: [] },
    routes: { type: Schema.Types.Mixed, default: [] },
    permissionsEditedAt: Date,
    routeAccess: { type: Schema.Types.Mixed, default: undefined },
    frontendSettings: { type: Schema.Types.Mixed, default: undefined },
    schema: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true },
);

export const Module = model<ModuleDoc>('Module', moduleSchema);
