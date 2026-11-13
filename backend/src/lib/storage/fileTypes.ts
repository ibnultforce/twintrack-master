import type { DownloadOptions } from './fileStorage.js';

/** Shown in the browser. Anything else is downloaded, so a file can't run as a page on the API's address. */
const INLINE_VIEWABLE_TYPES = /^(image\/(png|jpeg|gif|webp|bmp|avif)|video\/(mp4|webm|ogg|quicktime)|audio\/[\w.+-]+|application\/pdf)$/;
/** Shown as plain text, whatever their type, so markup inside them never runs. */
const PLAIN_TEXT_TYPES = /^(text\/(plain|csv|markdown|x-log)|application\/json)$/;

/** A type as uploaded, or a generic binary one when it isn't a well-formed media type. */
export function normalizeMimeType(mimeType: string | undefined): string {
  const value = mimeType?.trim().toLowerCase() ?? '';
  return /^[\w.+-]+\/[\w.+-]+$/.test(value) ? value : 'application/octet-stream';
}

/** How to serve an uploaded file safely: viewed only when a browser can't run it, downloaded otherwise. */
export function safeDownload(file: { fileName: string; mimeType: string }, mode: 'view' | 'download'): DownloadOptions {
  const isViewable = INLINE_VIEWABLE_TYPES.test(file.mimeType);
  const isPlainText = PLAIN_TEXT_TYPES.test(file.mimeType);
  const contentType = isPlainText ? 'text/plain; charset=utf-8' : isViewable ? file.mimeType : 'application/octet-stream';
  return { fileName: file.fileName, contentType, disposition: mode === 'view' && (isViewable || isPlainText) ? 'inline' : 'attachment' };
}
