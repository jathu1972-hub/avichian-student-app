import { useEffect, useState } from 'react';
import { checkApiHealth, type HealthStatus } from '../lib/health';
import { API_UNREACHABLE_MESSAGE } from '../lib/config';

/**
 * Startup health ping. Shows a friendly banner only when the API is unreachable.
 * Never mentions localhost or development ports.
 */
export function ApiConnectionBanner() {
  const [status, setStatus] = useState<HealthStatus>('checking');
  const [message, setMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    void checkApiHealth().then((result) => {
      if (cancelled) return;
      setStatus(result.status);
      if (result.status === 'error') {
        setMessage(result.message || API_UNREACHABLE_MESSAGE);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (status !== 'error') return null;

  return (
    <div
      role="alert"
      className="fixed inset-x-0 top-0 z-[200] border-b border-amber-500/30 bg-amber-500/95 px-4 py-2.5 text-center text-sm font-medium text-slate-900 shadow-md"
    >
      {message || API_UNREACHABLE_MESSAGE}
    </div>
  );
}
