'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiRequestError, refreshAccessToken, setAccessToken, setSessionEndedListener } from '@/lib/api/client';
import { MASTER_MODULE_KEY } from '@/lib/config';
import { getMyModuleAccess, getProfile, login, logout, type PermissionMap, type Profile } from './authApi';

interface SignedInAccount {
  profile: Profile;
  /** What this person can do in the Master module. The API checks every call, so this only decides what to show. */
  masterPermissions: PermissionMap;
}

type AuthState = { status: 'loading' } | { status: 'signedOut' } | ({ status: 'signedIn' } & SignedInAccount);

interface AuthContextValue {
  state: AuthState;
  signIn: (credentials: { email: string; password: string }) => Promise<void>;
  signOut: () => Promise<void>;
  /** Reads the account again after something about it changes, such as the password. */
  reloadAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

async function loadAccount(): Promise<SignedInAccount> {
  const profile = await getProfile();
  // The API refuses everything else until a temporary password has been changed.
  if (profile.mustChangePassword) return { profile, masterPermissions: {} };
  const { permissions } = await getMyModuleAccess(MASTER_MODULE_KEY);
  return { profile, masterPermissions: permissions };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    setSessionEndedListener(() => setState({ status: 'signedOut' }));

    // The access token doesn't survive a reload, so try to restore the session from the refresh cookie.
    refreshAccessToken()
      .then(loadAccount)
      .then((account) => setState({ status: 'signedIn', ...account }))
      .catch((error: unknown) => {
        // A 401 only means nobody is signed in. The sign-in page shows when the API can't be reached.
        if (!(error instanceof ApiRequestError && error.status === 401)) console.error('Could not restore the session', error);
        setState({ status: 'signedOut' });
      });
  }, []);

  const reloadAccount = useCallback(async () => {
    setState({ status: 'signedIn', ...(await loadAccount()) });
  }, []);

  const signIn = useCallback<AuthContextValue['signIn']>(
    async (credentials) => {
      const { accessToken } = await login(credentials);
      setAccessToken(accessToken);
      await reloadAccount();
    },
    [reloadAccount],
  );

  const signOut = useCallback(async () => {
    await logout();
    setAccessToken(null);
    setState({ status: 'signedOut' });
  }, []);

  const value = useMemo(() => ({ state, signIn, signOut, reloadAccount }), [state, signIn, signOut, reloadAccount]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside AuthProvider');
  return value;
}

/** For screens that only render once someone is signed in, which the (app) layout guarantees. */
export function useSignedInAccount(): SignedInAccount {
  const { state } = useAuth();
  if (state.status !== 'signedIn') throw new Error('useSignedInAccount needs a signed-in person');
  return state;
}
