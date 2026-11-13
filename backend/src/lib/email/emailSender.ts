import { pino } from 'pino';
import type { EmailSettings } from '../../config.js';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  /** The same message without markup, for mail clients that show text only. */
  text: string;
  /** Files sent with the message, such as an invoice document. */
  attachments?: EmailAttachment[];
}

export interface EmailAttachment {
  fileName: string;
  content: Buffer;
}

/** Sends email. Features depend on this, not on Resend, so tests and local development can swap it. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/** The email could not be handed to the provider. Safe to report to the person who asked for it. */
export class EmailDeliveryError extends Error {}

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';

/** Resend's own explanation of a refusal, such as an unverified domain. It never contains the key. */
async function readResendRefusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === 'string' ? body.message : 'no reason given';
}

/**
 * Sends through Resend's HTTP API: https://resend.com/docs/api-reference/emails/send-email
 * A refusal is logged with Resend's reason, so an admin can see why, without the email's text or links.
 */
export function createResendEmailSender(apiKey: string, from: string, logLevel: string): EmailSender {
  const logger = pino({ level: logLevel });
  return {
    async send(message) {
      let response: Response;
      try {
        response = await fetch(RESEND_EMAILS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from,
            to: [message.to],
            subject: message.subject,
            html: message.html,
            text: message.text,
            // Resend takes each file's content as base64.
            ...(message.attachments?.length && {
              attachments: message.attachments.map((file) => ({ filename: file.fileName, content: file.content.toString('base64') })),
            }),
          }),
        });
      } catch (error) {
        logger.warn({ to: message.to, reason: (error as Error).message }, 'Could not reach Resend');
        throw new EmailDeliveryError(`Could not reach Resend: ${(error as Error).message}`);
      }
      if (!response.ok) {
        const reason = await readResendRefusal(response);
        logger.warn({ to: message.to, status: response.status, reason }, 'Resend refused the email');
        throw new EmailDeliveryError(`Resend refused the email with status ${response.status}: ${reason}`);
      }
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
      const attachments = message.attachments?.map((file) => file.fileName);
      logger.info({ to: message.to, subject: message.subject, text: message.text, attachments }, 'Email not sent: RESEND_API_KEY is not set');
    },
  };
}

export function createEmailSender(settings: EmailSettings, logLevel: string): EmailSender {
  return settings.resendApiKey ? createResendEmailSender(settings.resendApiKey, settings.from, logLevel) : createLogEmailSender(logLevel);
}
