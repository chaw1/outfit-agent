import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ApiClient } from '../api/client';
import type { AuthResponse, User } from '../api/types';

const TOKEN_KEY = 'outfit.session';
const BASE_KEY = 'outfit.server';
const defaultBase = process.env.EXPO_PUBLIC_API_BASE || 'http://localhost:19301';

async function read(key: string) {
  if (Platform.OS === 'web') return (key === TOKEN_KEY ? sessionStorage : localStorage).getItem(key);
  return SecureStore.getItemAsync(key);
}
async function write(key: string, value: string | null) {
  if (Platform.OS === 'web') {
    const storage = key === TOKEN_KEY ? sessionStorage : localStorage;
    if (value === null) storage.removeItem(key); else storage.setItem(key, value);
  } else if (value === null) await SecureStore.deleteItemAsync(key);
  else await SecureStore.setItemAsync(key, value);
}

type SessionValue = {
  ready: boolean; token: string | null; user: User | null; baseUrl: string; api: ApiClient;
  signIn: (result: AuthResponse) => Promise<void>; signOut: () => Promise<void>; setBaseUrl: (url: string) => Promise<void>;
};
const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [baseUrl, setBase] = useState(defaultBase);
  const mounted = useRef(true);
  const revision = useRef(0);
  const current = useRef({ token: null as string | null, baseUrl: defaultBase });
  const storageQueue = useRef(Promise.resolve());

  const persist = useCallback((operation: () => Promise<void>) => {
    const pending = storageQueue.current.then(operation);
    storageQueue.current = pending.catch(() => undefined);
    return pending;
  }, []);

  const signOut = useCallback(async () => {
    revision.current += 1;
    current.current = { ...current.current, token: null };
    if (mounted.current) { setToken(null); setUser(null); }
    await persist(() => write(TOKEN_KEY, null));
  }, [persist]);
  const handleUnauthorized = useCallback(() => {
    // A delayed response from the previous server/session cannot invalidate a new login.
    if (mounted.current && token && current.current.token === token && current.current.baseUrl === baseUrl) return signOut();
  }, [baseUrl, token, signOut]);
  // The constructor stores this callback; it only runs after a later HTTP response.
  // eslint-disable-next-line react-hooks/refs
  const api = useMemo(() => new ApiClient({ baseUrl, token, onUnauthorized: handleUnauthorized }), [baseUrl, token, handleUnauthorized]);
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    const initialRevision = revision.current;
    Promise.all([read(TOKEN_KEY), read(BASE_KEY)]).then(([savedToken, savedBase]) => {
      if (alive && revision.current === initialRevision) {
        current.current = { token: savedToken, baseUrl: savedBase || defaultBase };
        setToken(savedToken); setBase(savedBase || defaultBase);
      }
    }).catch(() => { /* 存储不可用时保留可登录的页面。 */ }).finally(() => { if (alive) setReady(true); });
    return () => { alive = false; mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!ready || !token) return;
    let alive = true;
    api.me().then(value => {
      if (alive && current.current.token === token && current.current.baseUrl === baseUrl) setUser(value);
    }).catch(() => { /* 断网时仍可进入项目页重试；401由客户端清会话。 */ });
    return () => { alive = false; };
  }, [api, baseUrl, ready, token]);

  const signIn = useCallback(async (result: AuthResponse) => {
    if (current.current.baseUrl !== baseUrl) throw new Error('服务器已切换，请在当前服务器重新登录。');
    const attempt = ++revision.current;
    current.current = { ...current.current, token: result.token };
    try {
      await persist(() => write(TOKEN_KEY, result.token));
      if (mounted.current && revision.current === attempt) { setToken(result.token); setUser(result.user); }
    } catch (error) {
      if (revision.current === attempt) {
        current.current = { ...current.current, token: null };
        if (mounted.current) { setToken(null); setUser(null); }
      }
      throw error;
    }
  }, [baseUrl, persist]);
  const setBaseUrl = useCallback(async (url: string) => {
    const parsed = new URL(url.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('请输入完整的 http 或 https 服务地址，不要带密码、查询参数。');
    const normalized = url.trim().replace(/\/+$/, '');
    if (normalized === current.current.baseUrl) return;
    revision.current += 1;
    current.current = { token: null, baseUrl: normalized };
    if (mounted.current) { setToken(null); setUser(null); setBase(normalized); }
    await persist(async () => { await write(TOKEN_KEY, null); await write(BASE_KEY, normalized); });
  }, [persist]);
  const value = useMemo(() => ({ ready, token, user, baseUrl, api, signIn, signOut, setBaseUrl }), [ready, token, user, baseUrl, api, signIn, signOut, setBaseUrl]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error('SessionProvider 缺失');
  return value;
}
