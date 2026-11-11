import { Schema, model } from 'mongoose';

/** An app that registered itself to connect over OAuth, such as a claude.ai connector (RFC 7591). */
export interface OAuthClientDoc {
  /** The client_id the app was given. */
  _id: string;
  /** What the app sent when it registered, without its secret. */
  metadata: Record<string, unknown>;
  /** Encrypted, because OAuth needs the secret itself to check it. Missing for public clients. */
  clientSecretEncrypted?: string;
  createdAt: Date;
}

const oauthClientSchema = new Schema<OAuthClientDoc>(
  {
    _id: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed, required: true },
    clientSecretEncrypted: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);

export const OAuthClient = model<OAuthClientDoc>('OAuthClient', oauthClientSchema);

/**
 * An app asking to act for someone, waiting for them to approve or decline on the portal's consent page. Approving
 * gives it a one-time code, and only a hash of that code is kept.
 */
export interface OAuthAuthorizationRequestDoc {
  _id: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  scopes: string[];
  resource?: string;
  /** Who answered the request. */
  userId?: string;
  codeHash?: string;
  decidedAt?: Date;
  /** Set when the code was exchanged for tokens. */
  consumedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
}

const oauthAuthorizationRequestSchema = new Schema<OAuthAuthorizationRequestDoc>(
  {
    _id: { type: String, required: true },
    clientId: { type: String, required: true },
    redirectUri: { type: String, required: true },
    codeChallenge: { type: String, required: true },
    state: String,
    scopes: { type: [String], default: [] },
    resource: String,
    userId: String,
    codeHash: { type: String, unique: true, sparse: true },
    decidedAt: Date,
    consumedAt: Date,
    // Kept a day past expiry, so a code used again after expiring can still revoke what it was exchanged for.
    expiresAt: { type: Date, required: true, expires: 86_400 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const OAuthAuthorizationRequest = model<OAuthAuthorizationRequestDoc>('OAuthAuthorizationRequest', oauthAuthorizationRequestSchema);

/**
 * One connected app for one person: the tokens an approved request was exchanged for. Revoking it disconnects the app.
 * Only hashes of the tokens are kept.
 */
export interface OAuthGrantDoc {
  _id: string;
  clientId: string;
  userId: string;
  authorizationRequestId: string;
  scopes: string[];
  resource?: string;
  accessTokenHash: string;
  accessTokenExpiresAt: Date;
  refreshTokenHash: string;
  refreshTokenExpiresAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
  createdAt: Date;
}

const oauthGrantSchema = new Schema<OAuthGrantDoc>(
  {
    _id: { type: String, required: true },
    clientId: { type: String, required: true },
    userId: { type: String, required: true, index: true },
    authorizationRequestId: { type: String, required: true, index: true },
    scopes: { type: [String], default: [] },
    resource: String,
    accessTokenHash: { type: String, required: true, unique: true },
    accessTokenExpiresAt: { type: Date, required: true },
    refreshTokenHash: { type: String, required: true, unique: true },
    refreshTokenExpiresAt: { type: Date, required: true },
    lastUsedAt: Date,
    revokedAt: Date,
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

export const OAuthGrant = model<OAuthGrantDoc>('OAuthGrant', oauthGrantSchema);
