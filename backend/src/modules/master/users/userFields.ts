import { z } from 'zod';

const MAX_NAME_LENGTH = 100;

/** Field rules shared by login, the profile route and the admin routes. */
export const emailField = z.string().trim().toLowerCase().pipe(z.email('must be a valid email address'));

export const nameField = z.string().trim().min(1, 'is required').max(MAX_NAME_LENGTH);
