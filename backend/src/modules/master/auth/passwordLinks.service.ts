import { randomBytes, randomUUID } from 'node:crypto';
import type { EmailSettings } from '../../../config.js';
import { runInTransaction } from '../../../db.js';
import { renderEmail } from '../../../lib/email/emailLayout.js';
import type { EmailSender } from '../../../lib/email/emailSender.js';
import { ApiError } from '../../../lib/errors.js';
import { actorFields, type Actor } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import type { PasswordLinkPurpose } from '../models/passwordLink.js';
import type { UserDoc } from '../models/user.js';
import { ownAccountRefusal, superAdminRefusal } from '../users/accountRules.js';
import { findUserById, findUsersByIds, updateUserPassword } from '../users/users.repository.js';
import { deletePasswordLinksOf, replacePasswordLinks, takeUsablePasswordLink } from './passwordLink.repository.js';
import { hashPassword } from './passwords.js';
import { revokeAllUserSessions } from './session.repository.js';
import { hashRandomToken } from './tokens.js';

const LINK_TOKEN_BYTES = 32;
const MILLISECONDS_PER_HOUR = 3_600_000;
export const SET_PASSWORD_PATH = '/set-password';

/** What sending password links needs from outside: where emails go out, and where the links point. */
export interface PasswordLinkMailer {
  emailSender: EmailSender;
  settings: EmailSettings;
}

/** What happened for one person when links were sent. A failure for one never stops the others. */
export interface PasswordLinkResult {
  userId: string;
  email?: string;
  sent: boolean;
  /** Why it wasn't sent, as a code a frontend can show a message for. */
  error?: 'unknown_user' | 'account_inactive' | 'super_admin_protected' | 'own_account' | 'email_failed';
}

const EMAIL_WORDING: Record<PasswordLinkPurpose, { subject: string; heading: string; intro: string; button: string }> = {
  invite: {
    subject: 'Set up your TwinTrack account',
    heading: 'Welcome to TwinTrack',
    intro: 'An account has been created for you. Choose a password to start using it.',
    button: 'Set my password',
  },
  reset: {
    subject: 'Set a new TwinTrack password',
    heading: 'Set a new password',
    intro: 'A password reset was requested for your TwinTrack account. Choose a new password with the button below.',
    button: 'Set a new password',
  },
};

function buildPasswordEmail(user: Pick<UserDoc, 'name'>, purpose: PasswordLinkPurpose, link: string, ttlHours: number) {
  const wording = EMAIL_WORDING[purpose];
  return renderEmail({
    previewText: wording.intro,
    heading: wording.heading,
    paragraphs: [`Hi ${user.name},`, wording.intro],
    button: { label: wording.button, href: link },
    footnotes: [
      `This link works once and expires in ${ttlHours} hours.`,
      "If you weren't expecting this email, you can ignore it. Nothing changes unless you open the link.",
    ],
  });
}

/**
 * Saves a new link for the person, replacing any earlier one, then emails it. The link is saved first, so a failed
 * email can simply be sent again. Returns false when the email couldn't be handed over.
 */
export async function sendPasswordLink(
  mailer: PasswordLinkMailer,
  user: Pick<UserDoc, '_id' | 'name' | 'email'>,
  purpose: PasswordLinkPurpose,
  actor: Actor,
): Promise<boolean> {
  const { settings, emailSender } = mailer;
  const token = randomBytes(LINK_TOKEN_BYTES).toString('base64url');
  await runInTransaction(async (session) => {
    await replacePasswordLinks(
      {
        _id: `pl_${randomUUID()}`,
        userId: user._id,
        tokenHash: hashRandomToken(token),
        purpose,
        createdBy: actor.user._id,
        expiresAt: new Date(Date.now() + settings.passwordLinkTtlHours * MILLISECONDS_PER_HOUR),
      },
      session,
    );
    await recordAudit(
      { action: 'user.password_link_sent', ...actorFields(actor), targetType: 'user', targetId: user._id, targetName: user.name, after: { purpose } },
      session,
    );
  });

  const link = `${settings.portalUrl}${SET_PASSWORD_PATH}?token=${token}`;
  try {
    await emailSender.send({ to: user.email, subject: EMAIL_WORDING[purpose].subject, ...buildPasswordEmail(user, purpose, link, settings.passwordLinkTtlHours) });
    return true;
  } catch {
    return false;
  }
}

/** Why one person can't be sent a reset link by this admin, or null when they can. */
function refusalFor(actor: Actor, target: UserDoc): PasswordLinkResult['error'] | null {
  if (target.status !== 'active') return 'account_inactive';
  // Someone who knows their password changes it themselves, so an admin can't reset their own as a shortcut.
  return superAdminRefusal(actor, target) ?? ownAccountRefusal(actor, target);
}

/** Emails each person a link to set a new password. Their current password keeps working until they use it. */
export async function sendResetLinks(mailer: PasswordLinkMailer, actor: Actor, userIds: string[]): Promise<PasswordLinkResult[]> {
  const uniqueIds = [...new Set(userIds)];
  const users = new Map((await findUsersByIds(uniqueIds)).map((user) => [user._id, user]));

  const results: PasswordLinkResult[] = [];
  for (const userId of uniqueIds) {
    const target = users.get(userId);
    if (!target) {
      results.push({ userId, sent: false, error: 'unknown_user' });
      continue;
    }
    const refusal = refusalFor(actor, target);
    if (refusal) {
      results.push({ userId, email: target.email, sent: false, error: refusal });
      continue;
    }
    const sent = await sendPasswordLink(mailer, target, 'reset', actor);
    results.push({ userId, email: target.email, sent, ...(!sent && { error: 'email_failed' as const }) });
  }
  return results;
}

const invalidLink = () =>
  new ApiError(400, 'invalid_password_link', 'This link is invalid or has expired. Ask an admin to send a new one.');

/**
 * Sets a password from an emailed link. The link is used up, and every session ends, in case someone else was signed
 * in with the old password.
 */
export async function setPasswordWithLink(token: string, newPassword: string, ipAddress: string | undefined): Promise<void> {
  const passwordHash = await hashPassword(newPassword);
  await runInTransaction(async (session) => {
    const link = await takeUsablePasswordLink(hashRandomToken(token), session);
    if (!link) throw invalidLink();

    const user = await findUserById(link.userId);
    if (user?.status !== 'active') throw invalidLink();

    await updateUserPassword(user._id, passwordHash, session);
    await deletePasswordLinksOf(user._id, session);
    await revokeAllUserSessions(user._id, session);
    await recordAudit({ action: 'auth.password_set', actorId: user._id, actorName: user.name, after: { purpose: link.purpose }, ip: ipAddress }, session);
  });
}
