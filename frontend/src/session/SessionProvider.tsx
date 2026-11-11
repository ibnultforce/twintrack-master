'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { getMyModuleAccess, getMyProfile, logIn, logOut, sendHeartbeat, stopImpersonating as endImpersonation } from '@/lib/api/account';
import { ApiRequestError, refreshAccessToken, setAccessToken, setImpersonating, setSessionListeners } from '@/lib/api/http';
import type { PermissionMap, Profile } from '@/lib/api/types';
import { impersonateUser } from '@/lib/api/users';

const MASTER_MODULE_KEY = 'master';
/** The Master permission that lets someone give profiles. Its scope decides whose. */
const GIVE_PROFILE_PERMISSION = 'userProfile.update';
/** The API shows someone online for two minutes after their last report, so this leaves room for a missed one. */
const HEARTBEAT_INTERVAL_MS = 45_000;

type SessionStatus = 'loading' | 'signed-out' | 'signed-in' | 'unavailable';

interface SessionValue {
  status: SessionStatus;
  profile: Profile | null;
  can: (permission: string) => boolean;
  /** Whether this person can give anyone a profile, through userProfile.update. */
  canChangeAccess: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
  refreshSession: () => Promise<void>;
  /** Development only: a super admin sees the app as this person until they stop. */
  startImpersonating: (userId: string) => Promise<void>;
  stopImpersonating: () => Promise<void>;
}

interface LoadedSession {
  profile: Profile;
  masterPermissions: PermissionMap;
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
  setImpersonating(Boolean(profile.impersonatedBy));
  const masterAccess = await orWhenRefused(() => getMyModuleAccess(MASTER_MODULE_KEY), null);
  return { profile, masterPermissions: masterAccess?.permissions ?? {} };
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('loading');
  const [session, setSession] = useState<LoadedSession | null>(null);

  const clearSession = useCallback(() => {
    setAccessToken(null);
    setImpersonating(false);
    setSession(null);
    setStatus('signed-out');
  }, []);

  const refreshSession = useCallback(async () => {
    setSession(await loadSession());
    setStatus('signed-in');
  }, []);

  /** The refresh cookie belongs to the super admin, so refreshing returns them to their own session. */
  const returnToOwnSession = useCallback(async () => {
    setImpersonating(false);
    if (await refreshAccessToken()) await refreshSession();
    else clearSession();
  }, [refreshSession, clearSession]);

  useEffect(() => {
    setSessionListeners({ onSessionEnded: clearSession, onImpersonationEnded: () => void returnToOwnSession() });

    refreshAccessToken()
      .then(async (hasSession) => {
        if (hasSession) await refreshSession();
        else setStatus('signed-out');
      })
      .catch(() => setStatus('unavailable'));

    return () => setSessionListeners(null);
  }, [clearSession, refreshSession, returnToOwnSession]);

  useEffect(() => {
    if (status !== 'signed-in') return undefined;
    // Being shown online is a convenience, so a failed report is simply tried again next time.
    const report = () => void sendHeartbeat().catch(() => undefined);
    report();
    const timer = setInterval(report, HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [status]);

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

  const startImpersonating = useCallback(async (userId: string) => {
    await impersonateUser(userId);
    await refreshSession();
  }, [refreshSession]);

  const stopImpersonating = useCallback(async () => {
    try {
      await endImpersonation();
      setImpersonating(false);
      await refreshSession();
    } catch {
      await returnToOwnSession();
    }
  }, [refreshSession, returnToOwnSession]);

  const value = useMemo<SessionValue>(() => ({
    status,
    profile: session?.profile ?? null,
    can: (permission) => Boolean(session?.masterPermissions[permission]),
    canChangeAccess: Boolean(session?.masterPermissions[GIVE_PROFILE_PERMISSION]),
    signIn,
    signOut,
    refreshSession,
    startImpersonating,
    stopImpersonating,
  }), [status, session, signIn, signOut, refreshSession, startImpersonating, stopImpersonating]);

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
