import { findPermissionsIn } from '../access/access.service.js';
import type { Grantee } from '../access/permissions.js';
import { peopleInScope } from '../access/scope.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import type { UserDoc } from '../models/user.js';
import { recordUserSeen } from './users.repository.js';

/** Open apps report in about every 45 seconds, so two minutes allows for a missed report or two. */
const ONLINE_WINDOW_MS = 2 * 60_000;
/** Reports closer together than this don't write, so many open tabs don't each write every time. */
const SEEN_WRITE_INTERVAL_MS = 30_000;
const PRESENCE_PERMISSION = 'presence.read';

/** Called by open apps, to show the person as online. */
export async function recordHeartbeat(userId: string): Promise<void> {
  await recordUserSeen(userId, new Date(Date.now() - SEEN_WRITE_INTERVAL_MS));
}

const isOnline = (lastSeenAt: Date | undefined) => Boolean(lastSeenAt && Date.now() - lastSeenAt.getTime() < ONLINE_WINDOW_MS);

/**
 * Whether each person shows as online to this viewer, or undefined where the viewer may not know. Seeing it needs
 * presence.read in Master, and its scope decides whose. Leaving the flag out, instead of false, keeps "hidden" apart
 * from "offline".
 */
/** Someone looking at people, whose own place decides whose online status they see. */
export type Viewer = Grantee & { user: Pick<UserDoc, '_id' | 'superAdmin'> };

export async function findOnlineStatus(viewer: Viewer, people: Pick<UserDoc, '_id' | 'lastSeenAt'>[]): Promise<Map<string, boolean | undefined>> {
  const scope = (await findPermissionsIn(viewer, MASTER_MODULE_KEY))[PRESENCE_PERMISSION];
  const reachedIds = scope ? await peopleInScope(viewer.user._id, scope) : [];
  const isVisible = (personId: string) => reachedIds === null || reachedIds.includes(personId);
  return new Map(people.map((person) => [person._id, isVisible(person._id) ? isOnline(person.lastSeenAt) : undefined]));
}
