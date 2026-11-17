import { Module } from '../models/module.js';

/** How long a server trusts its copy of the saved origins. Another API instance sees a change within this time. */
const CACHE_SECONDS = 30;
const MILLISECONDS_PER_SECOND = 1000;

/**
 * The addresses whose pages may call the API: ALLOWED_ORIGINS from the environment, plus each module's allowed
 * origins and frontend address saved in the app. Read on every browser request, so it is cached briefly.
 */
export interface AllowedOrigins {
  isAllowed(origin: string): Promise<boolean>;
  /** Drops the cached copy, so a change made on this server applies at once. */
  forget(): void;
}

async function readSavedOrigins(): Promise<Set<string>> {
  const modules = await Module.find({ frontendSettings: { $exists: true } }, { frontendSettings: 1 }).lean();
  return new Set(modules.flatMap(({ frontendSettings }) => [
    ...(frontendSettings?.allowedOrigins ?? []),
    ...(frontendSettings?.frontendUrl ? [frontendSettings.frontendUrl] : []),
  ]));
}

export function createAllowedOrigins(environmentOrigins: string[]): AllowedOrigins {
  const fixed = new Set(environmentOrigins);
  let cached: { origins: Promise<Set<string>>; readAt: number } | null = null;

  const savedOrigins = () => {
    if (!cached || Date.now() - cached.readAt > CACHE_SECONDS * MILLISECONDS_PER_SECOND) {
      const origins = readSavedOrigins();
      cached = { origins, readAt: Date.now() };
      // A failed read isn't kept, so the next request tries again.
      origins.catch(() => { cached = null; });
    }
    return cached.origins;
  };

  return {
    async isAllowed(origin) {
      return fixed.has(origin) || (await savedOrigins()).has(origin);
    },
    forget() {
      cached = null;
    },
  };
}
