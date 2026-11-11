import type { EmailMessage, EmailSender } from '../../src/lib/email/emailSender.js';

export interface RecordingEmailSender extends EmailSender {
  sent: EmailMessage[];
  /** Makes every send fail until set back to false, to test what happens when email is down. */
  failing: boolean;
  /** The token from the newest set-password link sent to this address. */
  latestLinkToken(to: string): string;
}

/** Keeps emails in memory instead of sending them, so tests can read the links in them. */
export function createRecordingEmailSender(): RecordingEmailSender {
  const sender: RecordingEmailSender = {
    sent: [],
    failing: false,
    async send(message) {
      if (sender.failing) throw new Error('Email is down in this test.');
      sender.sent.push(message);
    },
    latestLinkToken(to) {
      const message = sender.sent.findLast((email) => email.to === to);
      const token = message?.text.match(/[?&]token=([\w-]+)/)?.[1];
      if (!token) throw new Error(`No set-password link was sent to ${to}.`);
      return token;
    },
  };
  return sender;
}
