/**
 * Frontend API / Socket configuration.
 *
 * Development: empty VITE_API_URL → relative `/api` via Vite proxy to localhost:4000.
 * Production (Netlify): MUST set VITE_API_URL to the backend origin, e.g.
 *   VITE_API_URL=https://api.avichian.com
 * (no trailing slash; optional trailing /api is stripped).
 *
 * Never put secrets in VITE_* variables.
 */

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * Normalize VITE_API_URL to API origin only (scheme + host[:port]).
 * Accepts: https://api.example.com  OR  https://api.example.com/api
 */
export function normalizeApiOrigin(raw: string): string {
  let url = stripTrailingSlash(raw.trim());
  // Users often paste full REST base with /api
  if (url.toLowerCase().endsWith('/api')) {
    url = url.slice(0, -4);
    url = stripTrailingSlash(url);
  }
  return url;
}

/** Origin of the API, e.g. https://api.avichian.in — empty in local dev. */
export function getApiOrigin(): string {
  const raw = import.meta.env.VITE_API_URL as string | undefined;
  if (!raw || !raw.trim()) {
    if (import.meta.env.PROD) {
      console.error(
        '[AVICHIAN] VITE_API_URL is not set in this production build. ' +
          'Relative /api calls hit Netlify and return index.html (JSON parse fails). ' +
          'Set VITE_API_URL=https://your-backend-host in Netlify → Environment variables, then Redeploy.',
      );
    }
    return '';
  }
  const origin = normalizeApiOrigin(raw);
  if (import.meta.env.PROD && /localhost|127\.0\.0\.1/.test(origin)) {
    console.error(
      '[AVICHIAN] VITE_API_URL points at localhost in a production build:',
      origin,
      '— browsers cannot reach your laptop. Use a public API host.',
    );
  }
  return origin;
}

/**
 * Base path for REST calls.
 * Local: `/api`
 * Prod: `https://api.avichian.com/api`
 */
export function getApiBase(): string {
  const origin = getApiOrigin();
  return origin ? `${origin}/api` : '/api';
}

/** True when the SPA is calling the API on another origin (Netlify → Railway/Render). */
export function isCrossOriginApi(): boolean {
  return Boolean(getApiOrigin());
}

/** Socket.IO connection URL (origin only; path is /socket.io). */
export function getSocketUrl(): string | undefined {
  const origin = getApiOrigin();
  return origin || undefined;
}

/** Resolve relative `/api/media/...` URLs against the API origin for Netlify hosting. */
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
