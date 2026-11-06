import { z } from 'zod';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/** Query fields shared by every paged list route. */
export const paginationQueryFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export interface PageRequest {
  page: number;
  pageSize: number;
}

export const pageOffset = ({ page, pageSize }: PageRequest): number => (page - 1) * pageSize;

/** Makes text from a request safe to use inside a regular expression. */
export const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
