import type { Config } from './config.js';
import { createEmailSender, type EmailSender } from './lib/email/emailSender.js';
import type { FileStorage } from './lib/storage/fileStorage.js';
import { createLocalStorage, type LocalStorage } from './lib/storage/localStorage.js';
import { createR2Storage } from './lib/storage/r2Storage.js';
import { createClaudeAssistant, createDisabledAssistant, type AccountsAssistant } from './modules/accounts/assistant/accountsAssistant.js';
import { createAllowedOrigins, type AllowedOrigins } from './modules/master/moduleRegistry/allowedOrigins.js';
import { createDisabledModuleFiles, createModuleFiles, MASTER_REPO_ROOT, type ModuleFiles } from './modules/master/moduleRegistry/moduleFiles.js';

/** Outside services the app talks to. Tests pass their own, so nothing real is called. */
export interface AppDependencies {
  emailSender: EmailSender;
  fileStorage: FileStorage;
  /** Set when files are on the local disk, which serves its own upload and download addresses. */
  localStorage?: LocalStorage;
  /** ALLOWED_ORIGINS plus the origins a super admin saved on modules. */
  allowedOrigins: AllowedOrigins;
  /** The repo's manifests/ and module-packs/, kept in step with module imports when MODULE_FILE_SYNC_ENABLED is on. */
  moduleFiles: ModuleFiles;
  /** Claude for the Accounts assistant: the real API when ANTHROPIC_API_KEY is set, otherwise one that says it isn't set up. */
  accountsAssistant: AccountsAssistant;
}

function resolveStorage(config: Config): Pick<AppDependencies, 'fileStorage' | 'localStorage'> {
  if (config.storage.r2) return { fileStorage: createR2Storage(config.storage.r2) };
  const localStorage = createLocalStorage(config.storage.localDirectory, config.publicApiUrl, config.encryptionKey);
  return { fileStorage: localStorage, localStorage };
}

export function resolveDependencies(config: Config, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const storage = overrides.fileStorage ? { fileStorage: overrides.fileStorage, localStorage: overrides.localStorage } : resolveStorage(config);
  return {
    emailSender: overrides.emailSender ?? createEmailSender(config.email, config.logLevel),
    allowedOrigins: overrides.allowedOrigins ?? createAllowedOrigins(config.allowedOrigins),
    moduleFiles: overrides.moduleFiles
      ?? (config.isModuleFileSyncEnabled ? createModuleFiles(MASTER_REPO_ROOT, config.logLevel) : createDisabledModuleFiles()),
    accountsAssistant: overrides.accountsAssistant
      ?? (config.anthropicApiKey ? createClaudeAssistant(config.anthropicApiKey, config.logLevel) : createDisabledAssistant()),
    ...storage,
  };
}
