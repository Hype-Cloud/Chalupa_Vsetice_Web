import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n.ts';

// Cloudflare Turnstile (explicitní render). Skript se načte až s formulářem. Site key je veřejný
// (GET /api/booking-config); secret zůstává jen ve Workeru.

interface TurnstileApi {
  render: (element: HTMLElement, options: Record<string, unknown>) => string;
  reset: (widgetId: string) => void;
  remove: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<TurnstileApi> | null = null;

function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile-missing')));
    script.onerror = () => {
      loading = null;
      reject(new Error('turnstile-load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Jazyk widgetu podle jazyka webu (Turnstile používá ISO 639-1: ukrajinština = uk). */
const WIDGET_LANGUAGE = { cs: 'cs', en: 'en', de: 'de', ua: 'uk' } as const;

interface Props {
  siteKey: string;
  /** Zvýšení hodnoty = reset widgetu (po turnstile-failed / turnstile-required). */
  resetSignal: number;
  /** Platný token, nebo null (expirace, chyba, reset, odpojení). */
  onToken: (token: string | null) => void;
}

export function Turnstile({ siteKey, resetSignal, onToken }: Props) {
  const { t, locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const widget = useRef<string | null>(null);
  const onTokenRef = useRef(onToken);
  onTokenRef.current = onToken;
  // Jazyk widgetu se bere při vykreslení; přepnutí jazyka webu widget (a token) nemění.
  const language = useRef(WIDGET_LANGUAGE[locale]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile()
      .then((api) => {
        if (cancelled || !container.current) return;
        widget.current = api.render(container.current, {
          sitekey: siteKey,
          language: language.current,
          size: 'flexible',
          'refresh-expired': 'auto',
          callback: (token: string) => onTokenRef.current(token),
          'expired-callback': () => onTokenRef.current(null),
          'error-callback': () => onTokenRef.current(null),
        });
      })
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
      onTokenRef.current(null);
    };
  }, [siteKey]);

  useEffect(() => {
    if (resetSignal === 0 || !widget.current) return;
    onTokenRef.current(null);
    window.turnstile?.reset(widget.current);
  }, [resetSignal]);

  return (
    <div className="turnstile" role="group" aria-label={t('reservation.turnstile.label')}>
      <div ref={container} />
      {failed && <p className="field-error" role="alert">{t('reservation.turnstile.unavailable')}</p>}
    </div>
  );
}
