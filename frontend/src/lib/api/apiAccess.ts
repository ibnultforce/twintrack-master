import { apiRequest } from './http';
import type { ApiToken, ConnectedApp, OAuthRequest, OwnedApiToken, OwnedConnectedApp } from './types';

export async function listMyApiTokens(): Promise<ApiToken[]> {
  return (await apiRequest<{ tokens: ApiToken[] }>('/me/api-tokens')).tokens;
}

/** The answer holds the token itself, which is never shown again. */
export const createMyApiToken = (name: string, expiresInDays?: number) =>
  apiRequest<ApiToken & { token: string }>('/me/api-tokens', { method: 'POST', body: { name, ...(expiresInDays && { expiresInDays }) } });

export const revokeMyApiToken = (tokenId: string) =>
  apiRequest<ApiToken>(`/me/api-tokens/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' });

export async function listMyConnectedApps(): Promise<ConnectedApp[]> {
  return (await apiRequest<{ apps: ConnectedApp[] }>('/me/connected-apps')).apps;
}

export const disconnectApp = (appId: string) => apiRequest(`/me/connected-apps/${encodeURIComponent(appId)}/revoke`, { method: 'POST' });

/** Everyone's tokens that apiToken.read reaches, newest first. */
export const listApiTokensInScope = (page: number, pageSize: number) =>
  apiRequest<{ total: number; tokens: OwnedApiToken[] }>(`/api-tokens?page=${page}&pageSize=${pageSize}`);

export const revokeApiTokenInScope = (tokenId: string) =>
  apiRequest<ApiToken>(`/api-tokens/${encodeURIComponent(tokenId)}/revoke`, { method: 'POST' });

/** Everyone's connected apps that apiToken.read reaches, newest first. */
export const listConnectedAppsInScope = (page: number, pageSize: number) =>
  apiRequest<{ total: number; apps: OwnedConnectedApp[] }>(`/connected-apps?page=${page}&pageSize=${pageSize}`);

export const disconnectAppInScope = (appId: string) => apiRequest(`/connected-apps/${encodeURIComponent(appId)}/revoke`, { method: 'POST' });

export const getOAuthRequest = (requestId: string) => apiRequest<OAuthRequest>(`/oauth/requests/${encodeURIComponent(requestId)}`);

/** Records the answer, and returns where to send the browser: back to the app. */
export const decideOAuthRequest = (requestId: string, approve: boolean) =>
  apiRequest<{ redirectUrl: string }>(`/oauth/requests/${encodeURIComponent(requestId)}/decision`, { method: 'POST', body: { approve } });
