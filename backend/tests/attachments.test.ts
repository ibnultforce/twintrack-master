import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { Application } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { FileStorage } from '../src/lib/storage/fileStorage.js';
import { createLocalStorage, UploadClosedError } from '../src/lib/storage/localStorage.js';
import { TaskAttachment, TaskAttachmentUsage } from '../src/modules/tasks/models/taskAttachment.js';
import { seedDatabase } from '../src/seed/seedDatabase.js';
import { useTestDatabase } from './helpers/database.js';
import { requestsAs, signIn } from './helpers/signedIn.js';
import { readSeedFiles } from './helpers/testAccess.js';
import { createTestConfig, TEST_ORIGIN } from './helpers/testConfig.js';

const PASSWORD = 'correct-password';
const API_URL = 'http://localhost:4100';
const ID = { ARIF: 'u_07', MEHEDI: 'u_09' };
const KEY = Buffer.from('c'.repeat(64), 'hex');

/** The path and query of a storage address, which supertest needs instead of the full address. */
const pathOf = (url: string) => url.slice(API_URL.length);

describe('task attachments, with files on the local disk', () => {
  useTestDatabase();

  const folder = mkdtempSync(join(tmpdir(), 'twintrack-files-'));
  const storage = createLocalStorage(folder, API_URL, KEY);
  let app: Application;
  const as = async (name: string) => requestsAs(app, await signIn(app, `${name}@twintrack.test`, PASSWORD));

  beforeAll(() => {
    app = createApp(createTestConfig({ PUBLIC_API_URL: API_URL }), { fileStorage: storage, localStorage: storage });
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  beforeEach(async () => {
    await seedDatabase({ files: readSeedFiles(), password: PASSWORD, nodeEnv: 'test' });
  });

  async function taskForMehedi() {
    const rahim = await as('rahim');
    const project = await rahim.post('/tasks/projects', { name: 'Payroll revamp', memberIds: [ID.MEHEDI] });
    const task = await rahim.post('/tasks/tasks', { projectId: project.body.id, title: 'Export', assignedDevId: ID.MEHEDI, estimatedHours: 2 });
    return { rahim, taskId: task.body.id as string };
  }

  /** Uploads bytes the way the frontend does: start, get part addresses, PUT each part, then complete. */
  async function upload(person: Awaited<ReturnType<typeof as>>, taskId: string, content: Buffer, fileName = 'notes.txt', mimeType = 'text/plain') {
    const started = await person.post(`/tasks/tasks/${taskId}/attachments`, { fileName, mimeType, sizeBytes: content.length });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    const attachmentId = started.body.attachment.id as string;
    const { parts } = (await person.post(`/tasks/tasks/${taskId}/attachments/${attachmentId}/part-urls`, { partNumbers: [1] })).body;
    const put = await request(app).put(pathOf(parts[0].url)).set('Origin', TEST_ORIGIN).set('Content-Type', mimeType).send(content);
    expect(put.status).toBe(200);
    expect(put.headers['access-control-expose-headers']).toContain('ETag');
    const completed = await person.post(`/tasks/tasks/${taskId}/attachments/${attachmentId}/complete`, { parts: [{ partNumber: 1, etag: put.headers.etag }] });
    return { attachmentId, started, completed };
  }

  it('uploads a file, lists it with the space used, and serves it from a short-lived address', async () => {
    const { rahim, taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const { completed, started } = await upload(mehedi, taskId, Buffer.from('hello, world'));
    expect(started.body).toMatchObject({ partSize: 64 * 1024 * 1024, partCount: 1 });
    expect(completed.body).toMatchObject({ fileName: 'notes.txt', sizeBytes: 12, status: 'ready', uploadedByName: 'Mehedi Hasan' });

    const listed = (await rahim.get(`/tasks/tasks/${taskId}/attachments`)).body;
    expect(listed).toMatchObject({ usedBytes: 12, limitBytes: 5 * 1024 ** 3, attachments: [expect.objectContaining({ fileName: 'notes.txt' })] });

    const { url } = (await rahim.get(`/tasks/tasks/${taskId}/attachments/${completed.body.id}/url?mode=view`)).body;
    const file = await request(app).get(pathOf(url));
    expect(file.status).toBe(200);
    expect(file.text).toBe('hello, world');
    expect(file.headers['content-type']).toContain('text/plain');
    expect(file.headers['content-disposition']).toMatch(/^inline/);
  });

  it('joins a file sent in several parts in order', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const started = await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'big.bin', sizeBytes: 6 });
    const id = started.body.attachment.id as string;
    // The test sends two small parts. Real ones are 64 MB each, except the last.
    const { parts } = (await mehedi.post(`/tasks/tasks/${taskId}/attachments/${id}/part-urls`, { partNumbers: [1] })).body;
    const fakeSecond = (await storage.partUploadUrls(`tasks/${taskId}/${id}`, (await TaskAttachment.findById(id).lean())!.uploadId!, [2]))[0]!;
    const second = await request(app).put(pathOf(fakeSecond.url)).send(Buffer.from('def'));
    const first = await request(app).put(pathOf(parts[0].url)).send(Buffer.from('abc'));
    await mehedi.post(`/tasks/tasks/${taskId}/attachments/${id}/complete`, { parts: [{ partNumber: 2, etag: second.headers.etag }, { partNumber: 1, etag: first.headers.etag }] });
    const { url } = (await mehedi.get(`/tasks/tasks/${taskId}/attachments/${id}/url?mode=download`)).body;
    const file = await request(app).get(pathOf(url)).buffer(true);
    expect(file.body.toString()).toBe('abcdef');
    expect(file.headers['content-disposition']).toMatch(/^attachment; filename="big.bin"/);
  });

  it('downloads files a browser could run, such as HTML, instead of showing them', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const { completed } = await upload(mehedi, taskId, Buffer.from('<script>alert(1)</script>'), 'page.html', 'text/html');
    const { url } = (await mehedi.get(`/tasks/tasks/${taskId}/attachments/${completed.body.id}/url?mode=view`)).body;
    const file = await request(app).get(pathOf(url));
    expect(file.headers['content-type']).toBe('application/octet-stream');
    expect(file.headers['content-disposition']).toMatch(/^attachment/);
  });

  it('refuses a file whose stored size differs from what was declared', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const started = await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'lie.txt', sizeBytes: 3 });
    const id = started.body.attachment.id as string;
    const { parts } = (await mehedi.post(`/tasks/tasks/${taskId}/attachments/${id}/part-urls`, { partNumbers: [1] })).body;
    const put = await request(app).put(pathOf(parts[0].url)).send(Buffer.from('much more than three bytes'));
    const completed = await mehedi.post(`/tasks/tasks/${taskId}/attachments/${id}/complete`, { parts: [{ partNumber: 1, etag: put.headers.etag }] });
    expect(completed.body.error.code).toBe('size_mismatch');
    expect(await TaskAttachment.exists({ _id: id })).toBeNull();
  });

  it('keeps a task to 5 GB, counting uploads in progress', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    expect((await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'a.iso', sizeBytes: 4 * 1024 ** 3 })).status).toBe(201);
    const second = await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'b.iso', sizeBytes: 2 * 1024 ** 3 });
    expect(second.status).toBe(413);
    expect(second.body.error.code).toBe('attachment_limit');
  });

  it('lets only one of two uploads at once take the last of the space, and gives space back on removal', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    expect((await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'big.iso', sizeBytes: 4.5 * 1024 ** 3 })).status).toBe(201);
    const halfGb = 0.5 * 1024 ** 3;
    const both = await Promise.all([1, 2].map((n) => mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: `part-${n}.zip`, sizeBytes: halfGb })));
    expect(both.map((response) => response.status).sort()).toEqual([201, 413]);
    expect((await TaskAttachmentUsage.findById(taskId).lean())?.bytes).toBe(5 * 1024 ** 3);

    const started = both.find((response) => response.status === 201)!;
    expect((await mehedi.delete(`/tasks/tasks/${taskId}/attachments/${started.body.attachment.id}`)).status).toBe(200);
    expect((await TaskAttachmentUsage.findById(taskId).lean())?.bytes).toBe(4.5 * 1024 ** 3);
  });

  it('reports a part that fails to save as a server error, not a closed upload, and leaves no partial file', async () => {
    const key = 'tasks/t_x/ta_x';
    const uploadId = await storage.startUpload(key, 'text/plain');
    const { url } = (await storage.partUploadUrls(key, uploadId, [1]))[0]!;
    const grant = storage.readGrant(new URL(url).searchParams.get('token')!)!;
    const failing = new Readable({ read() { this.destroy(new Error('connection dropped')); } });
    const error = await storage.savePart(grant as Parameters<typeof storage.savePart>[0], failing).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(UploadClosedError);
    expect(existsSync(join(folder, `${key}.upload-${uploadId}`, '1'))).toBe(false);

    await storage.abortUpload(key, uploadId);
    const late = await storage.savePart(grant as Parameters<typeof storage.savePart>[0], Readable.from(['x'])).catch((caught: unknown) => caught);
    expect(late).toBeInstanceOf(UploadClosedError);
  });

  it("keeps an unfinished upload to its uploader, and asks for part numbers the file has", async () => {
    const { rahim, taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const id = (await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'x.txt', sizeBytes: 5 })).body.attachment.id;
    expect((await rahim.post(`/tasks/tasks/${taskId}/attachments/${id}/part-urls`, { partNumbers: [1] })).body.error.code).toBe('not_your_upload');
    expect((await mehedi.post(`/tasks/tasks/${taskId}/attachments/${id}/part-urls`, { partNumbers: [2] })).status).toBe(422);
    expect((await rahim.delete(`/tasks/tasks/${taskId}/attachments/${id}`)).body.error.code).toBe('not_your_upload');
    expect((await mehedi.delete(`/tasks/tasks/${taskId}/attachments/${id}`)).body).toEqual({ deleted: true });
  });

  it('clears uploads left unfinished for a day', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const id = (await mehedi.post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'stale.txt', sizeBytes: 5 })).body.attachment.id;
    // Mongoose never changes createdAt, so the test backdates it in the collection itself.
    await TaskAttachment.collection.updateOne({ _id: id }, { $set: { createdAt: new Date(Date.now() - 2 * 86_400_000) } });
    await mehedi.get(`/tasks/tasks/${taskId}/attachments`);
    expect(await TaskAttachment.exists({ _id: id })).toBeNull();
  });

  it('lets the uploader or someone who can edit the task remove a file, and nobody else', async () => {
    const { rahim, taskId } = await taskForMehedi();
    const { completed } = await upload(await as('mehedi'), taskId, Buffer.from('rahim may remove this'));
    expect((await rahim.delete(`/tasks/tasks/${taskId}/attachments/${completed.body.id}`)).body).toEqual({ deleted: true });
    expect((await rahim.get(`/tasks/tasks/${taskId}/attachments`)).body.attachments).toEqual([]);
  });

  it('refuses people who can not reach the task', async () => {
    const { taskId } = await taskForMehedi();
    expect((await (await as('sumaiya')).post(`/tasks/tasks/${taskId}/attachments`, { fileName: 'x', sizeBytes: 1 })).body.error.code).toBe('out_of_scope');
  });

  it('refuses a forged or changed file address', async () => {
    const { taskId } = await taskForMehedi();
    const mehedi = await as('mehedi');
    const { completed } = await upload(mehedi, taskId, Buffer.from('secret'));
    const { url } = (await mehedi.get(`/tasks/tasks/${taskId}/attachments/${completed.body.id}/url`)).body;
    const [payload, signature] = new URL(url).searchParams.get('token')!.split('.');
    const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), key: 'tasks/other/file' })).toString('base64url');
    expect((await request(app).get(`/files/content?token=${changed}.${signature}`)).body.error.code).toBe('invalid_file_link');
    expect((await request(app).get('/files/content?token=nonsense')).status).toBe(403);
  });

  it('turns the local file addresses off when files are in R2', async () => {
    const elsewhere: FileStorage = { ...storage };
    const r2App = createApp(createTestConfig(), { fileStorage: elsewhere });
    expect((await request(r2App).get('/files/content?token=x')).status).toBe(404);
  });
});
