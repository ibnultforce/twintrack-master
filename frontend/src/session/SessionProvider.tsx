'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getMyModuleAccess, getMyProfile, logIn, logOut } from '@/lib/api/account';
import { getManageableRoles } from '@/lib/api/modules';
import { ApiRequestError, refreshAccessToken, setAccessToken, setSessionListeners } from '@/lib/api/http';
import type { PermissionMap, Profile } from '@/lib/api/types';
import { getAccessOptions } from '@/lib/api/users';

const MASTER_MODULE_KEY = 'master';

type SessionStatus = 'loading' | 'signed-out' | 'signed-in' | 'unavailable';

interface SessionValue {
  status: SessionStatus;
  profile: Profile | null;
  can: (permission: string) => boolean;
  /** Whether this person can change someone's access in at least one module. */
  canChangeAccess: boolean;
  /** Whether this person can create or edit roles in at least one module. */
  canEditRoles: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
}

interface LoadedSession {
  profile: Profile;
  masterPermissions: PermissionMap;
  canChangeAccess: boolean;
  canEditRoles: boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

/** A refusal here means this person doesn't have the thing being read, which is a normal answer. */
async function orWhenRefused<Value>(read: () => Promise<Value>, fallback: Value): Promise<Value> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof ApiRequestError && (error.status === 403 || error.status === 404)) return fallback;
    throw error;
  }
}

async function loadSession(): Promise<LoadedSession> {
  const profile = await getMyProfile();
  // Nothing else answers until a temporary password has been replaced.
  if (profile.mustChangePassword) return { profile, masterPermissions: {}, canChangeAccess: false, canEditRoles: false };

  const [masterAccess, accessOptions, manageableRoles] = await Promise.all([
    orWhenRefused(() => getMyModuleAccess(MASTER_MODULE_KEY), null),
    orWhenRefused(getAccessOptions, []),
    orWhenRefused(getManageableRoles, []),
  ]);
  return {
    profile,
    masterPermissions: masterAccess?.permissions ?? {},
    canChangeAccess: accessOptions.some((option) => option.canChange),
    canEditRoles: manageableRoles.length > 0,
  };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<LoadedSession | null>(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setSession(null);
    setStatus('signed-out');
  }, []);

  const refreshSession = useCallback(async () => {
    setSession(await loadSession());
    setStatus('signed-in');
  }, []);

  useEffect(() => {
    setSessionListeners({
      onSessionEnded: clearSession,
      onPasswordChangeRequired: () => setSession((current) => (current ? { ...current, profile: { ...current.profile, mustChangePassword: true } } : current)),
    });

    refreshAccessToken()
      .then(async (hasSession) => {
        if (hasSession) await refreshSession();
        else setStatus('signed-out');
      })
      .catch(() => setStatus('unavailable'));

    return () => setSessionListeners(null);
  }, [clearSession, refreshSession]);

  const signIn = useCallback(async (email: string, password: string) => {
    await logIn(email, password);
    await refreshSession();
  }, [refreshSession]);

  const signOut = useCallback(async () => {
    try {
      await logOut();
    } finally {
      clearSession();
    }
  }, [clearSession]);

  const value = useMemo<SessionValue>(() => ({
    status,
    profile: session?.profile ?? null,
    can: (permission) => Boolean(session?.masterPermissions[permission]),
    canChangeAccess: session?.canChangeAccess ?? false,
    canEditRoles: session?.canEditRoles ?? false,
    signIn,
    signOut,
    refreshSession,
  }), [status, session, signIn, signOut, refreshSession]);

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error('useSession must be used inside SessionProvider.');
  return value;
}

/** For screens inside the signed-in area, where the app shell has already confirmed the profile exists. */
export function useProfile(): Profile {
  const { profile } = useSession();
  if (!profile) throw new Error('useProfile must be used inside the signed-in area.');
  return profile;
}
