import { Schema, model } from 'mongoose';
import type { ManifestResource, ManifestRole, ManifestRoute } from '../moduleRegistry/manifest.js';

/** An imported module manifest. Role templates here are the fixed permission layer. */
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
  roles: ManifestRole[];
  /** Set when someone edits roles, resources or grantable permissions here, so an import or removal can't quietly undo that. */
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
    roles: { type: Schema.Types.Mixed, default: [] },
    permissionsEditedAt: Date,
  },
  { timestamps: true },
);

export const Module = model<ModuleDoc>('Module', moduleSchema);
