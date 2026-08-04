/**
 * Frontend API / Socket configuration.
 *
 * Resolution order for API origin:
 * 1. Runtime public/config.json → { "apiUrl": "https://your-api" }
 * 2. Build-time VITE_API_URL
 * 3. Dev only: relative /api (Vite proxy)
 *
 * Never put secrets in VITE_* variables.
 */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function normalizeApiOrigin(raw: string): string {
  let url = stripTrailingSlash(raw.trim());
  if (url.toLowerCase().endsWith('/api')) {
    url = stripTrailingSlash(url.slice(0, -4));
  }
  return url;
}

/** Set from public/config.json before first API call */
let runtimeApiOrigin = '';
let configLoaded = false;

/**
 * Load optional runtime config (cache-busted). Safe to call multiple times.
 * Place file at: public/config.json → { "apiUrl": "https://api.example.com" }
 */
export async function loadRuntimeConfig(): Promise<void> {
  if (configLoaded) return;
  configLoaded = true;

  // Local Vite always uses the /api proxy → backend :4000.
  // Ignoring public/config.json here prevents a dead Cloudflare tunnel from
  // breaking login when the API is running on this machine.
  if (import.meta.env.DEV && !isHostedStaticFrontend()) {
    console.info('[AVICHIAN] Dev mode: using Vite /api proxy (localhost:4000)');
    return;
  }

  try {
    const base = import.meta.env.BASE_URL || '/';
    const url = `${base}config.json?v=${Date.now()}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return;
    // Strip BOM if static host/editor rewrote UTF-8 with BOM
    const text = (await res.text()).replace(/^\uFEFF/, '');
    const json = JSON.parse(text) as { apiUrl?: string; VITE_API_URL?: string };
    const raw = json.apiUrl || json.VITE_API_URL;
    if (raw && raw.trim()) {
      runtimeApiOrigin = normalizeApiOrigin(raw);
      console.info('[AVICHIAN] API origin from config.json:', runtimeApiOrigin);
    }
  } catch {
    // optional file
  }
}

function isHostedStaticFrontend(): boolean {
  if (typeof window === 'undefined') return Boolean(import.meta.env.PROD);
  const h = window.location.hostname;
  return (
    h.includes('github.io') ||
    h.includes('netlify.app') ||
    h.includes('vercel.app') ||
    h.includes('pages.dev')
  );
}

/** Origin of the API, e.g. https://api.example.com — empty only in local Vite dev. */
export function getApiOrigin(): string {
  if (runtimeApiOrigin) return runtimeApiOrigin;

  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (raw && raw.trim()) {
    const origin = normalizeApiOrigin(raw);
    if (import.meta.env.PROD && /localhost|127\.0\.0\.1/.test(origin) && isHostedStaticFrontend()) {
      console.error('[AVICHIAN] VITE_API_URL points at localhost on a public site — browsers cannot reach it.');
    }
    return origin;
  }

  if (import.meta.env.PROD || isHostedStaticFrontend()) {
    console.error(
      '[AVICHIAN] No API URL configured. Set public/config.json { "apiUrl": "https://YOUR-API" } ' +
        'or build with VITE_API_URL, then redeploy.',
    );
  }
  return '';
}

/**
 * Base path for REST calls.
 * Local: `/api`  ·  Prod: `https://your-api/api`
 */
export function getApiBase(): string {
  const origin = getApiOrigin();
  if (origin) return `${origin}/api`;

  if (import.meta.env.PROD || isHostedStaticFrontend()) {
    throw new Error(
      'API URL is not configured (would call relative /api and get HTML 404). ' +
        'Set config.json apiUrl or VITE_API_URL to your Express backend origin ' +
        '(Render / Railway / Cloudflare tunnel), then redeploy. ' +
        'Local full stack: use http://localhost:5173 with backend on :4000.',
    );
  }
  return '/api';
}

export function isCrossOriginApi(): boolean {
  return Boolean(getApiOrigin());
}

export function getSocketUrl(): string | undefined {
  const origin = getApiOrigin();
  return origin || undefined;
}

export function resolveMediaUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (
    url.startsWith('http://') ||
    url.startsWith('https://') ||
    url.startsWith('data:') ||
    url.startsWith('blob:')
  ) {
    return url;
  }
  const origin = getApiOrigin();
  if (url.startsWith('/') && origin) {
    return `${origin}${url}`;
  }
  return url;
}
