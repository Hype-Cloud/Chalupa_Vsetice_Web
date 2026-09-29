import { useEffect, useState } from 'react';
import type { AvailabilityResponse } from '../../lib/availability/types.ts';
import { REFRESH_MS } from './config.ts';

export type AvailabilityState = { phase: 'loading' } | { phase: 'loaded'; data: AvailabilityResponse } | { phase: 'error' };

function isAvailabilityResponse(value: unknown): value is AvailabilityResponse {
  const data = value as AvailabilityResponse;
  return !!data && typeof data === 'object' && ['ok', 'partial', 'stale', 'unavailable'].includes(data.status) && Array.isArray(data.busy) && !!data.range;
}

/** Načítá obsazenost z vlastního API (/api/availability) a obnovuje ji, dokud je stránka otevřená. */
export function useAvailability(): AvailabilityState {
  const [state, setState] = useState<AvailabilityState>({ phase: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let controller: AbortController | null = null;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      try {
        const response = await fetch('/api/availability', { signal: controller.signal, headers: { accept: 'application/json' } });
        const data: unknown = await response.json();
        if (!cancelled) setState(isAvailabilityResponse(data) ? { phase: 'loaded', data } : { phase: 'error' });
      } catch (error) {
        if (!cancelled && (error as Error).name !== 'AbortError') {
          // Síťová chyba nesmí přepsat už načtená data; bez nich je stav neznámý.
          setState((previous) => (previous.phase === 'loaded' ? previous : { phase: 'error' }));
        }
      }
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    const onVisible = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      controller?.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return state;
}
