import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DOWNLOAD_URL_TTL_SECONDS, PART_URL_TTL_SECONDS, type DownloadOptions, type FileStorage } from './fileStorage.js';

/** The two API routes that stand in for R2's signed addresses. See modules/master/storage/storage.routes.ts. */
export const LOCAL_PART_PATH = '/files/parts';
export const LOCAL_CONTENT_PATH = '/files/content';

type PartGrant = { kind: 'part'; key: string; uploadId: string; partNumber: number };
type ContentGrant = { kind: 'content'; key: string } & DownloadOptions;
export type LocalGrant = (PartGrant | ContentGrant) & { expiresAt: number };

export interface LocalStorage extends FileStorage {
  /** Reads and checks a token from one of its own addresses. Null when it's forged or expired. */
  readGrant(token: string): LocalGrant | null;
  /** Saves one part from the request body, returning its ETag. */
  savePart(grant: PartGrant, body: NodeJS.ReadableStream): Promise<string>;
  /** The file's path on disk, for serving it. */
  pathOf(key: string): string;
}

/** The upload this part belongs to has finished or been cancelled. */
export class UploadClosedError extends Error {
  constructor() {
    super('The upload has finished or been cancelled.');
    this.name = 'UploadClosedError';
  }
}

/**
 * Files on the API's own disk, for development without R2. It hands out the same kind of short-lived addresses as R2,
 * signed with the app's key, so the frontend works the same way with either.
 */
export function createLocalStorage(directory: string, publicApiUrl: string, signingKey: Buffer): LocalStorage {
  const root = resolve(directory);

  /** Keys come from the app, but a path is still checked to stay inside the folder. */
  const pathOf = (key: string) => {
    const path = resolve(root, key);
    if (!path.startsWith(root + sep)) throw new Error(`Storage key ${key} points outside the storage folder.`);
    return path;
  };
  const partsFolder = (key: string, uploadId: string) => pathOf(`${key}.upload-${uploadId}`);

  const sign = (payload: string) => createHmac('sha256', signingKey).update(payload).digest('base64url');
  const issueToken = (grant: LocalGrant) => {
    const payload = Buffer.from(JSON.stringify(grant)).toString('base64url');
    return `${payload}.${sign(payload)}`;
  };

  return {
    async startUpload(key) {
      const uploadId = randomBytes(12).toString('hex');
      await mkdir(partsFolder(key, uploadId), { recursive: true });
      return uploadId;
    },
    async partUploadUrls(key, uploadId, partNumbers) {
      const expiresAt = Date.now() + PART_URL_TTL_SECONDS * 1000;
      return partNumbers.map((partNumber) => ({
        partNumber,
        url: `${publicApiUrl}${LOCAL_PART_PATH}?token=${issueToken({ kind: 'part', key, uploadId, partNumber, expiresAt })}`,
      }));
    },
    async completeUpload(key, uploadId, parts) {
      const folder = partsFolder(key, uploadId);
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      const output = createWriteStream(target);
      for (const { partNumber } of [...parts].sort((first, second) => first.partNumber - second.partNumber)) {
        await pipeline(createReadStream(join(folder, String(partNumber))), output, { end: false });
      }
      await new Promise<void>((done, fail) => output.end((error?: Error | null) => (error ? fail(error) : done())));
      await rm(folder, { recursive: true, force: true });
    },
    async abortUpload(key, uploadId) {
      await rm(partsFolder(key, uploadId), { recursive: true, force: true });
    },
    async objectSize(key) {
      return (await stat(pathOf(key))).size;
    },
    async downloadUrl(key, options) {
      const token = issueToken({ kind: 'content', key, ...options, expiresAt: Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000 });
      return `${publicApiUrl}${LOCAL_CONTENT_PATH}?token=${token}`;
    },
    async deleteObject(key) {
      await rm(pathOf(key), { force: true });
    },
    async putObject(key, body) {
      const target = pathOf(key);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, body);
    },
    readObject(key) {
      return readFile(pathOf(key));
    },
    readGrant(token) {
      const [payload, signature] = token.split('.');
      if (!payload || !signature) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      const grant = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as LocalGrant;
      return grant.expiresAt > Date.now() ? grant : null;
    },
    async savePart(grant, body) {
      const folder = partsFolder(grant.key, grant.uploadId);
      // An upload that was finished or aborted has no folder, so a late part can't recreate it.
      try {
        await readdir(folder);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new UploadClosedError();
        throw error;
      }
      const path = join(folder, String(grant.partNumber));
      try {
        await pipeline(body, createWriteStream(path));
      } catch (error) {
        // A half-written part is useless, and a retry writes it again from the start.
        await rm(path, { force: true }).catch(() => undefined);
        throw error;
      }
      // An ETag, as R2 gives for each part. Completing the upload sends it back, as with R2.
      const hash = createHash('md5');
      await pipeline(createReadStream(path), hash);
      return `"${hash.digest('hex')}"`;
    },
    pathOf,
  };
}

