import { API_UNREACHABLE_MESSAGE, getApiBase } from './config';

export type HealthStatus = 'checking' | 'ok' | 'error';

export interface HealthResult {
  status: HealthStatus;
  message?: string;
  data?: {
    status?: string;
    database?: string;
    server?: string;
  };
}

/**
 * Ping GET /api/health. Safe to call after loadRuntimeConfig().
 */
export async function checkApiHealth(): Promise<HealthResult> {
  let base: string;
  try {
    base = getApiBase();
  } catch {
    return { status: 'error', message: API_UNREACHABLE_MESSAGE };
  }

  try {
    const res = await fetch(`${base}/health`, {
      credentials: 'include',
      cache: 'no-store',
    });
    const contentType = res.headers.get('content-type') ?? '';
    const text = await res.text();
    if (!res.ok || contentType.includes('text/html') || text.trimStart().startsWith('<')) {
      console.error('[AVICHIAN] Health check failed', res.status, text.slice(0, 120));
      return { status: 'error', message: API_UNREACHABLE_MESSAGE };
    }
    let json: {
      success?: boolean;
      data?: { status?: string; database?: string; server?: string };
    };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      return { status: 'error', message: API_UNREACHABLE_MESSAGE };
    }
    const db = json.data?.database;
    if (db && db !== 'connected') {
      return {
        status: 'error',
        message: API_UNREACHABLE_MESSAGE,
        data: json.data,
      };
    }
    return {
      status: 'ok',
      data: json.data ?? { status: 'ok', server: 'running' },
    };
  } catch (err) {
    console.error('[AVICHIAN] Health check network error', err);
    return { status: 'error', message: API_UNREACHABLE_MESSAGE };
  }
}
