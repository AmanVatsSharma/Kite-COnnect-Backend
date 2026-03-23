import { apiUrl } from './api-base';

const TOKEN_KEY = 'admin_token';

export function getAdminToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setAdminToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(message: string, status: number, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { admin?: boolean } = {},
): Promise<T> {
  const { admin, headers: h, ...rest } = init;
  const headers = new Headers(h);
  if (!headers.has('Content-Type') && rest.body && typeof rest.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (admin) {
    const t = getAdminToken();
    if (t) headers.set('x-admin-token', t);
  }

  const res = await fetch(apiUrl(path), { ...rest, headers });
  const text = await res.text();
  let data: unknown = text;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const msg =
      typeof data === 'object' && data !== null && 'message' in data
        ? String((data as { message: unknown }).message)
        : res.statusText;
    throw new ApiError(msg || `HTTP ${res.status}`, res.status, data);
  }

  // Nest ResponseInterceptor wraps as { success, data, timestamp } unless body has `success`
  if (
    data &&
    typeof data === 'object' &&
    'data' in data &&
    'success' in (data as object)
  ) {
    return (data as { data: T }).data;
  }

  return data as T;
}

/** Raw request for API console: optional admin token and optional x-api-key. */
export async function apiRequestRaw(
  path: string,
  init: RequestInit & {
    admin?: boolean;
    apiKey?: string | null;
  } = {},
): Promise<{ status: number; ok: boolean; data: unknown; rawText: string }> {
  const { admin: useAdmin, apiKey, headers: h, ...rest } = init;
  const headers = new Headers(h);
  if (!headers.has('Content-Type') && rest.body && typeof rest.body === 'string') {
    headers.set('Content-Type', 'application/json');
  }
  if (useAdmin) {
    const t = getAdminToken();
    if (t) headers.set('x-admin-token', t);
  }
  if (apiKey) {
    headers.set('x-api-key', apiKey);
  }

  const res = await fetch(apiUrl(path), { ...rest, headers });
  const rawText = await res.text();
  let data: unknown = rawText;
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = rawText;
    }
  }

  return { status: res.status, ok: res.ok, data, rawText };
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
