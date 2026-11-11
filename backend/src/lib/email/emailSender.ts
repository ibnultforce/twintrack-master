import { pino } from 'pino';
import type { EmailSettings } from '../../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** The same message without markup, for mail clients that show text only. */
  text: string;
}

/** Sends email. Features depend on this, not on Resend, so tests and local development can swap it. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** The email could not be handed to the provider. Safe to report to the person who asked for it. */
export class EmailDeliveryError extends Error {}

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** Sends through Resend's HTTP API: https://resend.com/docs/api-reference/emails/send-email */
export function createResendEmailSender(apiKey: string, from: string): EmailSender {
  return {
    async send(message) {
      let response: Response;
      try {
        response = await fetch(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to: [message.to], subject: message.subject, html: message.html, text: message.text }),
        });
      } catch (error) {
        throw new EmailDeliveryError(`Could not reach Resend: ${(error as Error).message}`);
      }
      if (!response.ok) throw new EmailDeliveryError(`Resend refused the email with status ${response.status}.`);
    },
  };
}

/**
 * For local development without a Resend key: writes each email's text to the log, links included, instead of
 * sending it. Configuration refuses this in production.
 */
export function createLogEmailSender(logLevel: string): EmailSender {
  const logger = pino({ level: logLevel });
  return {
    async send(message) {
      logger.info({ to: message.to, subject: message.subject, text: message.text }, 'Email not sent: RESEND_API_KEY is not set');
    },
  };
}

export function createEmailSender(settings: EmailSettings, logLevel: string): EmailSender {
  return settings.resendApiKey ? createResendEmailSender(settings.resendApiKey, settings.from) : createLogEmailSender(logLevel);
}
