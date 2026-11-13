import { Schema, model } from 'mongoose';
import type { ManifestResource, ManifestRoute } from '../moduleRegistry/manifest.js';
import type { RouteAccessChange } from '../moduleRegistry/routeAccess.js';

/** An imported module manifest, with any resources and custom objects changed in the app. */
export interface ModuleDoc {
  key: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  baseUrl?: string;
  core: boolean;
  resources: ManifestResource[];
  routes: ManifestRoute[];
  /** Set when someone edits resources here, so an import or removal can't quietly undo that. */
  permissionsEditedAt?: Date;
  /** Access rules a super admin changed in the app. An import keeps them, since they aren't in the manifest. */
  routeAccess?: RouteAccessChange[];
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
    resources: { type: Schema.Types.Mixed, default: [] },
    routes: { type: Schema.Types.Mixed, default: [] },
    permissionsEditedAt: Date,
    routeAccess: { type: Schema.Types.Mixed, default: undefined },
  },
  { timestamps: true },
);

export const Module = model<ModuleDoc>('Module', moduleSchema);
