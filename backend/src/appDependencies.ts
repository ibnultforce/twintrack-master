import type { Config } from './config.js';
import { createEmailSender, type EmailSender } from './lib/email/emailSender.js';
import type { FileStorage } from './lib/storage/fileStorage.js';
import { createLocalStorage, type LocalStorage } from './lib/storage/localStorage.js';
import { createR2Storage } from './lib/storage/r2Storage.js';

/** Outside services the app talks to. Tests pass their own, so nothing real is called. */
export interface AppDependencies {
  emailSender: EmailSender;
  fileStorage: FileStorage;
  /** Set when files are on the local disk, which serves its own upload and download addresses. */
  localStorage?: LocalStorage;
}

function resolveStorage(config: Config): Pick<AppDependencies, 'fileStorage' | 'localStorage'> {
  if (config.storage.r2) return { fileStorage: createR2Storage(config.storage.r2) };
  const localStorage = createLocalStorage(config.storage.localDirectory, config.publicApiUrl, config.encryptionKey);
  return { fileStorage: localStorage, localStorage };
}

export function resolveDependencies(config: Config, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const storage = overrides.fileStorage ? { fileStorage: overrides.fileStorage, localStorage: overrides.localStorage } : resolveStorage(config);
  return { emailSender: overrides.emailSender ?? createEmailSender(config.email, config.logLevel), ...storage };
}
