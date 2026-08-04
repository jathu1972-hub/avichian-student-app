import { API_UNREACHABLE_MESSAGE, getApiBase, isProductionFrontend } from './config';

/** REST base: `/api` (dev proxy) or `https://api…/api` (production). */
function apiBase(): string {
  return getApiBase();
}

let csrfTokenCache: string | null = null;
let refreshPromise: Promise<string | null> | null = null;

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function networkErrorMessage(): string {
  if (isProductionFrontend()) return API_UNREACHABLE_MESSAGE;
  // Developers only (never shown on github.io)
  return `${API_UNREACHABLE_MESSAGE} (dev: is the API reachable and is VITE_API_URL / Vite proxy correct?)`;
}

/**
 * Parse fetch body as JSON. Rejects HTML/SPA shells with a clear message.
 */
export async function parseApiJson<T = Record<string, unknown>>(res: Response): Promise<T> {
  const contentType = res.headers.get('content-type') ?? '';
  const text = await res.text();
  const trimmed = text.trimStart();
  const looksHtml =
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<html') ||
    contentType.includes('text/html');

  if (looksHtml) {
    console.error('[AVICHIAN] API returned HTML instead of JSON', {
      status: res.status,
      contentType,
      preview: trimmed.slice(0, 200),
      apiBase: (() => {
        try {
          return apiBase();
        } catch {
          return '(unconfigured)';
        }
      })(),
    });
    throw new Error(
      isProductionFrontend()
        ? API_UNREACHABLE_MESSAGE
        : `Expected JSON from the API but received HTML (HTTP ${res.status}). Check VITE_API_URL / reverse proxy.`,
    );
  }

  if (!trimmed) {
    if (!res.ok) {
      throw new Error(`Empty response from API (HTTP ${res.status})`);
    }
    return {} as T;
  }

  if (!contentType.includes('application/json') && !trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    console.error('[AVICHIAN] Unexpected API body', {
      status: res.status,
      contentType,
      preview: trimmed.slice(0, 200),
    });
    throw new Error(
      isProductionFrontend()
        ? API_UNREACHABLE_MESSAGE
        : `Expected JSON from the API (HTTP ${res.status}). Body starts with: ${trimmed.slice(0, 80)}`,
    );
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    console.error('[AVICHIAN] Invalid JSON', { status: res.status, preview: trimmed.slice(0, 200) });
    throw new Error(
      isProductionFrontend() ? API_UNREACHABLE_MESSAGE : `Invalid JSON from API (HTTP ${res.status})`,
    );
  }
}

function readCsrfCookie(): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(/(?:^|;\s*)csrf_token=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function setCsrfToken(token: string | null) {
  csrfTokenCache = token;
}

export function clearCsrfToken() {
  csrfTokenCache = null;
}

export async function prefetchCsrfToken(): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}/csrf-token`, { credentials: 'include' });
  } catch (err) {
    console.error('[AVICHIAN] CSRF fetch failed', err);
    throw new Error(networkErrorMessage());
  }
  const json = await parseApiJson<{ data?: { csrfToken?: string }; error?: string }>(res);
  if (!res.ok) {
    throw new Error(
      (typeof json.error === 'string' && json.error) || networkErrorMessage(),
    );
  }
  const token = json?.data?.csrfToken;
  if (!token) {
    throw new Error('CSRF token missing from API response');
  }
  csrfTokenCache = token;
  return token;
}

async function ensureCsrf(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cookieToken = readCsrfCookie();
    if (cookieToken) {
      csrfTokenCache = cookieToken;
      return cookieToken;
    }
    if (csrfTokenCache) {
      return csrfTokenCache;
    }
  }
  return prefetchCsrfToken();
}

export function setAccessToken(token: string | null) {
  if (token) {
    localStorage.setItem('avichian_access_token', token);
  } else {
    localStorage.removeItem('avichian_access_token');
  }
}

export function getAccessToken(): string | null {
  return localStorage.getItem('avichian_access_token');
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const csrf = await ensureCsrf();
        const res = await fetch(`${apiBase()}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'X-CSRF-Token': csrf },
        });
        if (!res.ok) return null;
        const json = await parseApiJson<{
          data?: { accessToken?: string; csrfToken?: string };
        }>(res);
        if (!json.data?.accessToken) return null;
        setAccessToken(json.data.accessToken);
        if (json.data.csrfToken) {
          setCsrfToken(json.data.csrfToken);
        }
        return json.data.accessToken;
      } catch {
        return null;
      } finally {
        refreshPromise = null;
      }
    })();
  }
  return refreshPromise;
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  retryState: { auth?: boolean; csrf?: boolean } = { auth: true, csrf: true },
): Promise<{ success: boolean; data?: T; error?: string; message?: string; code?: string }> {
  const method = (options.method ?? 'GET').toUpperCase();
  const needsCsrf = MUTATING_METHODS.has(method);
  const csrf = needsCsrf ? await ensureCsrf() : null;
  const accessToken = getAccessToken();

  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };

  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  if (options.body && !isFormData && !headers['Content-Type'] && !headers['content-type']) {
    headers['Content-Type'] = 'application/json';
  }

  if (needsCsrf && csrf) {
    headers['X-CSRF-Token'] = csrf;
  }

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      ...options,
      credentials: 'include',
      headers,
    });
  } catch (err) {
    console.error('[AVICHIAN] Network error', path, err);
    throw new Error(networkErrorMessage());
  }

  if (!res.ok) {
    // Still parse body for structured errors when possible
  }

  const json = await parseApiJson<{
    success?: boolean;
    data?: T & { csrfToken?: string };
    error?: string;
    message?: string;
    code?: string;
  }>(res);

  if (
    res.status === 403 &&
    retryState.csrf &&
    needsCsrf &&
    typeof json.error === 'string' &&
    json.error.includes('CSRF')
  ) {
    await ensureCsrf(true);
    return api<T>(path, options, { ...retryState, csrf: false });
  }

  if (res.status === 401 && retryState.auth && !path.includes('/auth/refresh')) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      return api<T>(path, options, { ...retryState, auth: false });
    }
    if (accessToken) {
      setAccessToken(null);
    }
  }

  if (!res.ok) {
    throw new Error(
      (typeof json.error === 'string' && json.error) ||
        (typeof json.message === 'string' && json.message) ||
        `Request failed (HTTP ${res.status})`,
    );
  }

  if (json.data && typeof json.data === 'object' && 'csrfToken' in json.data && json.data.csrfToken) {
    setCsrfToken(json.data.csrfToken as string);
  }

  return json as { success: boolean; data?: T; error?: string; message?: string; code?: string };
}
