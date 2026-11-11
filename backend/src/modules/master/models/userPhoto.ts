import { Schema, model } from 'mongoose';

export const PHOTO_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PhotoContentType = (typeof PHOTO_CONTENT_TYPES)[number];

/** A person's profile photo, kept apart from the user so lists of people never load the image. */
export interface UserPhotoDoc {
  /** The user's id: each person has at most one photo. */
  _id: string;
  contentType: PhotoContentType;
  data: Buffer;
  updatedAt: Date;
}

const userPhotoSchema = new Schema<UserPhotoDoc>(
  {
    _id: { type: String, required: true },
    contentType: { type: String, enum: PHOTO_CONTENT_TYPES, required: true },
    data: { type: Buffer, required: true },
  },
  { timestamps: { createdAt: false, updatedAt: true } },
);

export const UserPhoto = model<UserPhotoDoc>('UserPhoto', userPhotoSchema);
