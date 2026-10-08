import { useEffect, useRef } from 'react';
import type { Locale } from '../../lib/i18n/index.ts';
import { useI18n } from '../i18n.ts';
import { createInvisibleTurnstile, type TokenSource, type TurnstileApi } from './invisibleTurnstile.ts';

// Cloudflare Turnstile v režimu Invisible (explicitní render, `execution: 'execute'`). Skript se
// načte s formulářem, challenge běží až po kliknutí na odeslání (invisibleTurnstile.ts).
// Site key je veřejný (GET /api/booking-config); secret zůstává jen ve Workeru.

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
      script.remove();
      reject(new Error('turnstile-load'));
    };
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * Jazyk widgetu podle jazyka webu (uplatní se jen u pojistky `interaction-only`). Turnstile očekává
 * standardní jazykový kód; pro `ua` se odvozuje přes Intl z regionu (stejný princip jako
 * INTL_LOCALE v lib/i18n), ve zdroji se používá jen `ua`.
 */
const UA_WIDGET_LANGUAGE = new Intl.Locale('und-UA').maximize().language;
const WIDGET_LANGUAGE: Record<Locale, string> = { cs: 'cs', en: 'en', de: 'de', ua: UA_WIDGET_LANGUAGE };

interface Props {
  siteKey: string;
  /** Zdroj tokenů pro odeslání (null po odpojení formuláře). */
  onSource: (source: TokenSource | null) => void;
}

/** Kotva pro neviditelný widget – nic nezobrazuje a nerezervuje v layoutu žádné místo. */
export function Turnstile({ siteKey, onSource }: Props) {
  const { locale } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const onSourceRef = useRef(onSource);
  onSourceRef.current = onSource;

  useEffect(() => {
    // Skript se načte předem, aby challenge po kliknutí začala hned; chyba se projeví až při odeslání.
    loadTurnstile().catch(() => undefined);
    const source = createInvisibleTurnstile({
      load: loadTurnstile,
      container: () => container.current,
      siteKey,
      language: () => WIDGET_LANGUAGE[localeRef.current],
    });
    onSourceRef.current(source);
    return () => {
      source.dispose();
      onSourceRef.current(null);
    };
  }, [siteKey]);

  return <div ref={container} className="turnstile-anchor" />;
}
