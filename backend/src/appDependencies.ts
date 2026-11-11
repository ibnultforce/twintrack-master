import type { Config } from './config.js';
import { createEmailSender, type EmailSender } from './lib/email/emailSender.js';

/** Outside services the app talks to. Tests pass their own, so nothing real is called. */
export interface AppDependencies {
  emailSender: EmailSender;
}

export function resolveDependencies(config: Config, overrides: Partial<AppDependencies> = {}): AppDependencies {
  return { emailSender: overrides.emailSender ?? createEmailSender(config.email, config.logLevel) };
}
