import { runInTransaction } from '../../../db.js';
import { ApiError } from '../../../lib/errors.js';
import { findPermissionsIn } from '../access/access.service.js';
import type { Caller } from '../access/caller.js';
import { recordAudit } from '../audit/audit.repository.js';
import { MASTER_MODULE_KEY } from '../moduleRegistry/manifest.js';
import type { PhotoContentType } from '../models/userPhoto.js';
import { superAdminRefusal, throwIfRefused } from './accountRules.js';
import { deletePhotoOf, findPhotoOf, savePhoto } from './photos.repository.js';
import { savePhotoUpdatedAt } from './users.repository.js';
import { requireUser, userTargetFields } from './users.service.js';

export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const EDIT_PEOPLE_PERMISSION = 'user.update';

/** The image type from the file's first bytes, which can't be faked by naming the file differently. */
const SIGNATURES: { contentType: PhotoContentType; matches: (bytes: Buffer) => boolean }[] = [
  { contentType: 'image/png', matches: (bytes) => bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { contentType: 'image/jpeg', matches: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
  {
    contentType: 'image/webp',
    matches: (bytes) => bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP',
  },
];

function detectPhotoType(bytes: Buffer): PhotoContentType {
  const match = SIGNATURES.find((signature) => signature.matches(bytes));
  if (!match) throw new ApiError(415, 'unsupported_photo', 'Send a PNG, JPEG or WebP image.');
  return match.contentType;
}

/** People change their own photo. Changing someone else's needs user.update in Master, and never reaches a super admin's. */
async function assertMayChangePhoto(caller: Caller, targetId: string) {
  const target = await requireUser(targetId);
  if (target._id === caller.user._id) return target;

  const permissions = await findPermissionsIn(caller, MASTER_MODULE_KEY);
  if (!permissions[EDIT_PEOPLE_PERMISSION]) throw new ApiError(403, 'forbidden', 'You can only change your own photo.');
  throwIfRefused(superAdminRefusal({ ...caller, ipAddress: undefined, permissions, fieldAccess: {} }, target));
  return target;
}

const photoAuditFields = (caller: Caller, ipAddress: string | undefined) => ({
  actorId: caller.user._id,
  actorName: caller.user.name,
  ip: ipAddress,
});

export async function setUserPhoto(caller: Caller, userId: string, image: Buffer, ipAddress: string | undefined) {
  if (image.length === 0) throw new ApiError(422, 'validation_failed', 'Send the image as the request body.');
  const contentType = detectPhotoType(image);
  const target = await assertMayChangePhoto(caller, userId);

  const photoUpdatedAt = await runInTransaction(async (session) => {
    const updatedAt = await savePhoto(target._id, contentType, image, session);
    await savePhotoUpdatedAt(target._id, updatedAt, session);
    await recordAudit({ action: 'user.photo_changed', ...photoAuditFields(caller, ipAddress), ...userTargetFields(target) }, session);
    return updatedAt;
  });
  return { photoUpdatedAt };
}

export async function removeUserPhoto(caller: Caller, userId: string, ipAddress: string | undefined): Promise<void> {
  const target = await assertMayChangePhoto(caller, userId);
  if (!target.photoUpdatedAt) return;

  await runInTransaction(async (session) => {
    await deletePhotoOf(target._id, session);
    await savePhotoUpdatedAt(target._id, null, session);
    await recordAudit({ action: 'user.photo_removed', ...photoAuditFields(caller, ipAddress), ...userTargetFields(target) }, session);
  });
}

/** Anyone signed in may see a colleague's photo, as in the directory. */
export async function getUserPhoto(userId: string) {
  const photo = await findPhotoOf(userId);
  if (!photo) throw new ApiError(404, 'no_photo', 'This person has no photo.');
  return photo;
}
