/**
 * Where uploaded files live. The browser sends a file's parts straight to the addresses this hands out, and reads
 * files from short-lived addresses too, so large files never pass through the API's memory. Features talk to this,
 * never to R2 or the disk, so tests and development can use the local driver.
 */
export interface FileStorage {
  /** Starts a multipart upload, returning its id. */
  startUpload(key: string, contentType: string): Promise<string>;
  /** Addresses the browser PUTs each part to. Each answer carries an ETag header, which completing the upload needs. */
  partUploadUrls(key: string, uploadId: string, partNumbers: number[]): Promise<{ partNumber: number; url: string }[]>;
  completeUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<void>;
  abortUpload(key: string, uploadId: string): Promise<void>;
  /** The stored size in bytes, to check it matches what was declared. */
  objectSize(key: string): Promise<number>;
  /** A short-lived address that serves the file, shown in the browser or saved as a download. */
  downloadUrl(key: string, options: DownloadOptions): Promise<string>;
  deleteObject(key: string): Promise<void>;
}

export interface DownloadOptions {
  fileName: string;
  contentType: string;
  disposition: 'inline' | 'attachment';
}

/** Every part but the last must be this size. At 64 MB, a 5 GB file is 80 parts, and a failed part resends little. */
export const UPLOAD_PART_SIZE = 64 * 1024 * 1024;
/** How long an address handed out for one part or one download keeps working. */
export const PART_URL_TTL_SECONDS = 60 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

/** A header value for a download's file name, safe for any characters it contains (RFC 6266). */
export function contentDisposition({ fileName, disposition }: Pick<DownloadOptions, 'fileName' | 'disposition'>): string {
  const asciiName = fileName.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', "'");
  return `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
