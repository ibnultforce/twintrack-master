import { mongo, type ClientSession } from 'mongoose';
import { UserPhoto, type PhotoContentType, type UserPhotoDoc } from '../models/userPhoto.js';

export async function savePhoto(userId: string, contentType: PhotoContentType, data: Buffer, session: ClientSession): Promise<Date> {
  const saved = await UserPhoto.findByIdAndUpdate(
    userId,
    { $set: { contentType, data } },
    { upsert: true, returnDocument: 'after', session },
  ).lean();
  if (!saved) throw new Error('Saving the photo returned nothing.');
  return saved.updatedAt;
}

/** The photo with its bytes as a Buffer. Plain reads return MongoDB's Binary type, which Express would send as JSON. */
export async function findPhotoOf(userId: string): Promise<UserPhotoDoc | null> {
  const photo = await UserPhoto.findById(userId).lean();
  if (!photo) return null;
  const stored = photo.data as Buffer | mongo.Binary;
  return { ...photo, data: Buffer.isBuffer(stored) ? stored : Buffer.from(stored.buffer) };
}

export async function deletePhotoOf(userId: string, session: ClientSession): Promise<void> {
  await UserPhoto.deleteOne({ _id: userId }, { session });
}
