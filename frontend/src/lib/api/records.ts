import { apiRequest } from './http';
import type { CustomFieldDefinition, CustomRecordView, HistoryEntry, ReadableObject } from './types';

const segment = encodeURIComponent;
const objectPath = (moduleKey: string, objectKey: string) => `/records/${segment(moduleKey)}/${segment(objectKey)}`;
const recordPath = (moduleKey: string, objectKey: string, recordId: string) => `${objectPath(moduleKey, objectKey)}/${segment(recordId)}`;

export async function listReadableObjects(): Promise<ReadableObject[]> {
  return (await apiRequest<{ objects: ReadableObject[] }>('/records')).objects;
}

export const listRecords = (moduleKey: string, objectKey: string, query: { page: number; pageSize: number; deleted?: boolean }) =>
  apiRequest<{ total: number; records: CustomRecordView[] }>(objectPath(moduleKey, objectKey), {
    query: { page: query.page, pageSize: query.pageSize, ...(query.deleted && { deleted: 'true' }) },
  });

export const createRecord = (moduleKey: string, objectKey: string, values: Record<string, unknown>) =>
  apiRequest<CustomRecordView>(objectPath(moduleKey, objectKey), { method: 'POST', body: { values } });

export const updateRecord = (moduleKey: string, objectKey: string, recordId: string, values: Record<string, unknown>, version: number) =>
  apiRequest<CustomRecordView>(recordPath(moduleKey, objectKey, recordId), { method: 'PATCH', body: { values, version } });

export const deleteRecord = (moduleKey: string, objectKey: string, recordId: string) =>
  apiRequest(recordPath(moduleKey, objectKey, recordId), { method: 'DELETE' });

export const restoreRecord = (moduleKey: string, objectKey: string, recordId: string) =>
  apiRequest(`${recordPath(moduleKey, objectKey, recordId)}/restore`, { method: 'POST' });

export async function getRecordHistory(moduleKey: string, objectKey: string, recordId: string): Promise<HistoryEntry[]> {
  return (await apiRequest<{ entries: HistoryEntry[] }>(`${recordPath(moduleKey, objectKey, recordId)}/history`, { query: { page: 1, pageSize: 50 } })).entries;
}

export interface ObjectDefinition {
  label: string;
  fields: CustomFieldDefinition[];
  sharingModel: 'private' | 'publicRead' | 'publicReadWrite';
}

export const addCustomObject = (moduleKey: string, objectKey: string, definition: ObjectDefinition) =>
  apiRequest(`/modules/${segment(moduleKey)}/objects`, { method: 'POST', body: { key: objectKey, ...definition } });

export const updateCustomObject = (moduleKey: string, objectKey: string, definition: ObjectDefinition) =>
  apiRequest(`/modules/${segment(moduleKey)}/objects/${segment(objectKey)}`, { method: 'PUT', body: definition });

export const removeCustomObject = (moduleKey: string, objectKey: string) =>
  apiRequest(`/modules/${segment(moduleKey)}/objects/${segment(objectKey)}`, { method: 'DELETE' });
