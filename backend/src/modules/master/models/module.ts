import { Schema, model } from 'mongoose';
import type { ManifestPermissionSet, ManifestResource, ManifestRoute } from '../moduleRegistry/manifest.js';

/** An imported module manifest, with the permission sets built for it in the app. */
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
  /** Named bundles of this module's permissions, which people are given on top of their profile. */
  permissionSets: ManifestPermissionSet[];
  /** Set when someone edits permission sets or resources here, so an import or removal can't quietly undo that. */
  permissionsEditedAt?: Date;
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
    permissionSets: { type: Schema.Types.Mixed, default: [] },
    permissionsEditedAt: Date,
  },
  { timestamps: true },
);

export const Module = model<ModuleDoc>('Module', moduleSchema);
