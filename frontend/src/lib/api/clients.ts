import { apiRequest } from './http';
import type { Client, ClientDetails, ClientStatus, HistoryEntry } from './types';

const HISTORY_PAGE_SIZE = 50;

const clientPath = (clientId: string) => `/clients/${encodeURIComponent(clientId)}`;

export const listClients = (query: { page: number; pageSize: number; search?: string; status?: ClientStatus }) =>
  apiRequest<{ clients: Client[]; total: number }>('/clients', { query: { ...query } });

export const getClient = (clientId: string) => apiRequest<Client>(clientPath(clientId));

export const createClient = (details: Partial<ClientDetails>) => apiRequest<Client>('/clients', { method: 'POST', body: details });

/** Sends the version that was read, so a change someone made since is not overwritten. */
export const updateClient = (clientId: string, changes: Partial<ClientDetails>, version: number) =>
  apiRequest<Client>(clientPath(clientId), { method: 'PATCH', body: { ...changes, version } });

export const setClientStatus = (clientId: string, status: ClientStatus, version: number) =>
  apiRequest<Client>(`${clientPath(clientId)}/status`, { method: 'PATCH', body: { status, version } });

export async function getClientHistory(clientId: string): Promise<HistoryEntry[]> {
  return (await apiRequest<{ entries: HistoryEntry[] }>(`${clientPath(clientId)}/history`, { query: { page: 1, pageSize: HISTORY_PAGE_SIZE } })).entries;
}
