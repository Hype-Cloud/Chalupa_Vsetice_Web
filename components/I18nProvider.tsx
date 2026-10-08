import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createI18n, DEFAULT_LOCALE, type Locale } from '../lib/i18n/index.ts';
import { resolveLocale, storeLocale, urlWithLocale } from '../lib/i18n/preference.ts';
import { I18nContext, SetLocaleContext } from './i18n.ts';

const browserStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/**
 * Centrální jazyk celého frontendu. Statický HTML je předrenderovaný česky; jazyk z URL
 * (`?lang=`) nebo uložené preference se použije hned po načtení v prohlížeči. Změna jazyka jen
 * přerenderuje texty – komponenty zůstávají připojené, takže termín, hosté i nabídka se zachovají.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    setLocaleState(resolveLocale({ search: window.location.search, storage: browserStorage() }));
  }, []);

  const i18n = useMemo(() => createI18n(locale), [locale]);

  // Jazyk dokumentu, titulek a popis stránky podle aktuálního jazyka.
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = i18n.t('meta.title');
    document.querySelector('meta[name="description"]')?.setAttribute('content', i18n.t('meta.description'));
  }, [locale, i18n]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    storeLocale(browserStorage(), next);
    // Adresa odpovídá jazyku (sdílitelný odkaz), bez nového záznamu v historii a bez reloadu.
    window.history.replaceState(window.history.state, '', urlWithLocale(window.location.href, next));
  }, []);

  return (
    <SetLocaleContext.Provider value={setLocale}>
      <I18nContext.Provider value={i18n}>{children}</I18nContext.Provider>
    </SetLocaleContext.Provider>
  );
}
