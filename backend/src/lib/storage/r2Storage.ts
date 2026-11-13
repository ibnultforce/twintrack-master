import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { R2Settings } from '../../config.js';
import { contentDisposition, DOWNLOAD_URL_TTL_SECONDS, PART_URL_TTL_SECONDS, type FileStorage } from './fileStorage.js';

/**
 * Cloudflare R2, through its S3-compatible API. The bucket's CORS rules must allow PUT from the module frontends and
 * expose the ETag header, and a lifecycle rule should abort multipart uploads left unfinished after a day.
 */
export function createR2Storage(settings: R2Settings): FileStorage {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${settings.accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: settings.accessKeyId, secretAccessKey: settings.secretAccessKey },
  });
  const Bucket = settings.bucket;

  return {
    async startUpload(key, contentType) {
      const { UploadId } = await client.send(new CreateMultipartUploadCommand({ Bucket, Key: key, ContentType: contentType }));
      if (!UploadId) throw new Error('R2 did not return an upload id.');
      return UploadId;
    },
    partUploadUrls(key, uploadId, partNumbers) {
      return Promise.all(
        partNumbers.map(async (partNumber) => ({
          partNumber,
          url: await getSignedUrl(client, new UploadPartCommand({ Bucket, Key: key, UploadId: uploadId, PartNumber: partNumber }), { expiresIn: PART_URL_TTL_SECONDS }),
        })),
      );
    },
    async completeUpload(key, uploadId, parts) {
      await client.send(
        new CompleteMultipartUploadCommand({
          Bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts.map(({ partNumber, etag }) => ({ PartNumber: partNumber, ETag: etag })) },
        }),
      );
    },
    async abortUpload(key, uploadId) {
      await client.send(new AbortMultipartUploadCommand({ Bucket, Key: key, UploadId: uploadId }));
    },
    async objectSize(key) {
      const { ContentLength } = await client.send(new HeadObjectCommand({ Bucket, Key: key }));
      return ContentLength ?? 0;
    },
    downloadUrl(key, options) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket, Key: key, ResponseContentType: options.contentType, ResponseContentDisposition: contentDisposition(options) }),
        { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
      );
    },
    async deleteObject(key) {
      await client.send(new DeleteObjectCommand({ Bucket, Key: key }));
    },
    async putObject(key, body, contentType) {
      await client.send(new PutObjectCommand({ Bucket, Key: key, Body: body, ContentType: contentType }));
    },
    async readObject(key) {
      const { Body } = await client.send(new GetObjectCommand({ Bucket, Key: key }));
      if (!Body) throw new Error(`Stored file ${key} has no content.`);
      return Buffer.from(await Body.transformToByteArray());
    },
  };
}
