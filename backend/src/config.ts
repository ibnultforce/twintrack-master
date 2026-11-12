import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { MODULE_KEY } from './modules/master/moduleRegistry/manifest.js';

const MIN_SECRET_LENGTH = 32;

/** Local addresses used when nothing else says where the portal is. Production refuses to rely on it. */
const DEFAULT_PORTAL_URL = 'http://twintrack.localhost:3100';
const MASTER_FRONTEND_KEY = 'master';
const DEFAULT_PUBLIC_API_URL = 'http://localhost:4100';
const ENCRYPTION_KEY_PATTERN = /^[0-9a-f]{64}$/i;
const ENCRYPTION_KEY_BYTES = 32;

const positiveInteger = (defaultValue: number) => z.coerce.number().int().positive().default(defaultValue);

function isWebOrigin(value: string | undefined): value is string {
  if (!value || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === value;
}

const moduleFrontendUrls = z
  .string()
  .default('')
  .transform((value, context) => {
    const frontendUrls = new Map<string, string>();
    for (const pair of value.split(',').map((item) => item.trim()).filter(Boolean)) {
      const [moduleKey, frontendUrl, ...extraParts] = pair.split('=');
      if (!moduleKey || !MODULE_KEY.test(moduleKey) || !isWebOrigin(frontendUrl) || extraParts.length > 0) {
        context.addIssue({ code: 'custom', message: `"${pair}" must look like hr=https://hr.twintrack.com` });
      } else if (frontendUrls.has(moduleKey)) {
        context.addIssue({ code: 'custom', message: `module "${moduleKey}" is listed twice` });
      } else {
        frontendUrls.set(moduleKey, frontendUrl);
      }
    }
    return frontendUrls;
  });

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4100),
    MONGODB_URI: z.string().regex(/^mongodb(\+srv)?:\/\//, 'must start with mongodb:// or mongodb+srv://'),
    ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .transform((value) => value.split(',').map((origin) => origin.trim()).filter(Boolean))
      .pipe(z.array(z.url()).min(1)),
    MODULE_FRONTEND_URLS: moduleFrontendUrls,
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).default(0),
    JWT_ACCESS_SECRET: z.string().min(MIN_SECRET_LENGTH, `must be at least ${MIN_SECRET_LENGTH} characters`),
    JWT_ISSUER: z.string().min(1).default('https://api.twintrack.com'),
    ACCESS_TOKEN_TTL_SECONDS: positiveInteger(900),
    SESSION_IDLE_DAYS: positiveInteger(7),
    SESSION_MAX_DAYS: positiveInteger(30),
    REFRESH_GRACE_SECONDS: positiveInteger(10),
    REFRESH_COOKIE_SECURE: z.enum(['true', 'false']).optional(),
    LOGIN_MAX_FAILED_ATTEMPTS: positiveInteger(10),
    LOGIN_RATE_WINDOW_MINUTES: positiveInteger(15),
    TEST_PAGE_ENABLED: z.enum(['true', 'false']).default('false'),
    RESEND_API_KEY: z.string().trim().optional(),
    EMAIL_FROM: z.string().trim().min(1).default('TwinTrack <no-reply@twintrack.com>'),
    PORTAL_URL: z.string().refine(isWebOrigin, 'must be an address such as https://twintrack.com').optional(),
    PASSWORD_LINK_TTL_HOURS: positiveInteger(24),
    IMPERSONATION_ENABLED: z.enum(['true', 'false']).default('false'),
    PUBLIC_API_URL: z.string().refine(isWebOrigin, 'must be an address such as https://api.twintrack.com').optional(),
    ENCRYPTION_KEY: z.string().trim().regex(ENCRYPTION_KEY_PATTERN, 'must be 64 hexadecimal characters').optional(),
    R2_ACCOUNT_ID: z.string().trim().optional(),
    R2_ACCESS_KEY_ID: z.string().trim().optional(),
    R2_SECRET_ACCESS_KEY: z.string().trim().optional(),
    R2_BUCKET: z.string().trim().optional(),
    STORAGE_DIR: z.string().trim().min(1).default('uploads'),
    INCENTIVE_HOURLY_RATE_BDT: z.coerce.number().min(0).default(0),
  })
  .superRefine((env, context) => {
    // A module frontend that isn't allowed to call the API would open and then fail on its first request.
    for (const [moduleKey, frontendUrl] of env.MODULE_FRONTEND_URLS) {
      if (!env.ALLOWED_ORIGINS.includes(frontendUrl)) {
        context.addIssue({
          code: 'custom',
          path: ['MODULE_FRONTEND_URLS'],
          message: `${moduleKey}: ${frontendUrl} is not in ALLOWED_ORIGINS`,
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.REFRESH_COOKIE_SECURE === 'false') {
      context.addIssue({ code: 'custom', path: ['REFRESH_COOKIE_SECURE'], message: 'must not be false in production' });
    }
    if (env.NODE_ENV === 'production' && env.TEST_PAGE_ENABLED === 'true') {
      context.addIssue({ code: 'custom', path: ['TEST_PAGE_ENABLED'], message: 'must not be true in production' });
    }
    if (env.NODE_ENV === 'production' && env.IMPERSONATION_ENABLED === 'true') {
      context.addIssue({ code: 'custom', path: ['IMPERSONATION_ENABLED'], message: 'must not be true in production' });
    }
    // Without a key, emails are written to the log, which would leak set-password links in production.
    if (env.NODE_ENV === 'production' && !env.RESEND_API_KEY) {
      context.addIssue({ code: 'custom', path: ['RESEND_API_KEY'], message: 'is required in production' });
    }
    if (env.NODE_ENV === 'production' && !env.PUBLIC_API_URL?.startsWith('https://')) {
      context.addIssue({ code: 'custom', path: ['PUBLIC_API_URL'], message: 'is required in production, as an https address' });
    }
    const r2Settings = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET];
    if (r2Settings.some(Boolean) && !r2Settings.every(Boolean)) {
      context.addIssue({ code: 'custom', path: ['R2_BUCKET'], message: 'R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET go together' });
    }
    // Local files live on one server's disk, which production can't rely on.
    if (env.NODE_ENV === 'production' && !r2Settings.every(Boolean)) {
      context.addIssue({ code: 'custom', path: ['R2_BUCKET'], message: 'R2 file storage is required in production' });
    }
    if (env.NODE_ENV === 'production' && !env.ENCRYPTION_KEY) {
      context.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: 'is required in production' });
    }
    if (env.NODE_ENV === 'production' && !env.PORTAL_URL && !env.MODULE_FRONTEND_URLS.has(MASTER_FRONTEND_KEY)) {
      context.addIssue({ code: 'custom', path: ['PORTAL_URL'], message: 'is required in production, for the links in emails' });
    }
  });

export interface AuthSettings {
  accessTokenSecret: string;
  tokenIssuer: string;
  accessTokenTtlSeconds: number;
  /** A session ends after this long without use. */
  sessionIdleDays: number;
  /** A session ends after this long, however much it's used. */
  sessionMaxDays: number;
  /** How long a just-replaced refresh token still works, so two tabs refreshing together don't end the session. */
  refreshGraceSeconds: number;
  isRefreshCookieSecure: boolean;
  loginMaxFailedAttempts: number;
  loginRateWindowMinutes: number;
  /** Lets a super admin sign in as someone else, to see what they see. Never allowed in production. */
  isImpersonationEnabled: boolean;
}

export interface EmailSettings {
  /** Sends through Resend when set. Without it, emails are written to the log, which only development allows. */
  resendApiKey?: string;
  from: string;
  /** The portal address that links in emails open. */
  portalUrl: string;
  passwordLinkTtlHours: number;
}

export interface R2Settings {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

export interface StorageSettings {
  /** Files go to Cloudflare R2 when set. Without it, they go to localDirectory, which only development allows. */
  r2?: R2Settings;
  localDirectory: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  mongodbUri: string;
  allowedOrigins: string[];
  /** Module key to the address of its frontend, for sending people to it after login. */
  moduleFrontendUrls: Map<string, string>;
  logLevel: string;
  /** How many proxies sit in front of the API, so rate limits see the caller's real address. */
  trustProxyHops: number;
  /** Serves the browser test page at /try. Never allowed in production. */
  isTestPageEnabled: boolean;
  /** This API's own public address. OAuth and the MCP endpoint name it to the apps that connect. */
  publicApiUrl: string;
  /**
   * Encrypts secrets that must be read back, such as OAuth client secrets. Losing it makes them unreadable.
   * Outside production a missing key is replaced by a random one, so those secrets last until the server restarts.
   */
  encryptionKey: Buffer;
  auth: AuthSettings;
  email: EmailSettings;
  storage: StorageSettings;
  /** The hourly incentive rate, in taka, for anyone whose incentive setting doesn't name their own. */
  defaultIncentiveHourlyRate: number;
}

export class ConfigError extends Error {}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`Invalid environment settings:\n${problems.join('\n')}`);
  }
  const values = parsed.data;
  return {
    nodeEnv: values.NODE_ENV,
    port: values.PORT,
    mongodbUri: values.MONGODB_URI,
    allowedOrigins: values.ALLOWED_ORIGINS,
    moduleFrontendUrls: values.MODULE_FRONTEND_URLS,
    logLevel: values.LOG_LEVEL,
    trustProxyHops: values.TRUST_PROXY_HOPS,
    isTestPageEnabled: values.TEST_PAGE_ENABLED === 'true',
    publicApiUrl: values.PUBLIC_API_URL ?? DEFAULT_PUBLIC_API_URL,
    encryptionKey: values.ENCRYPTION_KEY ? Buffer.from(values.ENCRYPTION_KEY, 'hex') : randomBytes(ENCRYPTION_KEY_BYTES),
    auth: {
      accessTokenSecret: values.JWT_ACCESS_SECRET,
      tokenIssuer: values.JWT_ISSUER,
      accessTokenTtlSeconds: values.ACCESS_TOKEN_TTL_SECONDS,
      sessionIdleDays: values.SESSION_IDLE_DAYS,
      sessionMaxDays: values.SESSION_MAX_DAYS,
      refreshGraceSeconds: values.REFRESH_GRACE_SECONDS,
      isRefreshCookieSecure: values.REFRESH_COOKIE_SECURE
        ? values.REFRESH_COOKIE_SECURE === 'true'
        : values.NODE_ENV === 'production',
      loginMaxFailedAttempts: values.LOGIN_MAX_FAILED_ATTEMPTS,
      loginRateWindowMinutes: values.LOGIN_RATE_WINDOW_MINUTES,
      isImpersonationEnabled: values.IMPERSONATION_ENABLED === 'true',
    },
    email: {
      resendApiKey: values.RESEND_API_KEY || undefined,
      from: values.EMAIL_FROM,
      portalUrl: values.PORTAL_URL ?? values.MODULE_FRONTEND_URLS.get(MASTER_FRONTEND_KEY) ?? DEFAULT_PORTAL_URL,
      passwordLinkTtlHours: values.PASSWORD_LINK_TTL_HOURS,
    },
    storage: {
      ...(values.R2_ACCOUNT_ID && values.R2_ACCESS_KEY_ID && values.R2_SECRET_ACCESS_KEY && values.R2_BUCKET && {
        r2: { accountId: values.R2_ACCOUNT_ID, accessKeyId: values.R2_ACCESS_KEY_ID, secretAccessKey: values.R2_SECRET_ACCESS_KEY, bucket: values.R2_BUCKET },
      }),
      localDirectory: values.STORAGE_DIR,
    },
    defaultIncentiveHourlyRate: values.INCENTIVE_HOURLY_RATE_BDT,
  };
}
