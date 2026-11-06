import { z } from 'zod';
import { MODULE_KEY } from './modules/master/moduleRegistry/manifest.js';

const MIN_SECRET_LENGTH = 32;

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
  auth: AuthSettings;
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
    },
  };
}
