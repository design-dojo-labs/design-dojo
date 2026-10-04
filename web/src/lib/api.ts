import type { Bootstrap } from '@lld/shared';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

let bootstrapPromise: Promise<Bootstrap> | null = null;

/** Identifies this browser tab on state-changing requests, so it can ignore change events it caused. */
export const CLIENT_ID: string = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export function getBootstrap(force = false): Promise<Bootstrap> {
  if (!bootstrapPromise || force) {
    bootstrapPromise = fetch('/api/bootstrap').then(async (r) => {
      if (!r.ok) throw new ApiError(r.status, 'Cannot reach the local server.');
      return r.json();
    });
    bootstrapPromise.catch(() => (bootstrapPromise = null));
  }
  return bootstrapPromise;
}

/**
 * JSON API client. State-changing requests carry the per-server-process CSRF token; if the server
 * restarted (stale token) the token is refreshed once and the request retried.
 */
export async function api<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    headers['x-studio-token'] = (await getBootstrap()).csrfToken;
    headers['x-client-id'] = CLIENT_ID;
  }
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'The local server is not responding. Is `npm start` still running?');
  }
  if (res.status === 403 && retry && method !== 'GET') {
    const j = await res
      .clone()
      .json()
      .catch(() => null);
    if (j?.code === 'csrf') {
      await getBootstrap(true);
      return api<T>(method, path, body, false);
    }
  }
  if (!res.ok) {
    const j = (await res.json().catch(() => ({ error: res.statusText }))) as Record<string, unknown>;
    const details = Array.isArray(j.issues) ? `: ${(j.issues as string[]).join('; ')}` : '';
    throw new ApiError(res.status, `${String(j.error ?? res.statusText)}${details}`, j);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body: unknown = {}) => api<T>('POST', path, body);
export const put = <T>(path: string, body: unknown) => api<T>('PUT', path, body);
export const patch = <T>(path: string, body: unknown) => api<T>('PATCH', path, body);
export const del = <T>(path: string) => api<T>('DELETE', path);

export function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
