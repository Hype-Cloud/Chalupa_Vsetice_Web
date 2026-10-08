import { languageOptions } from '../lib/i18n/preference.ts';
import { useI18n, useSetLocale } from './i18n.ts';

/** Přepínač jazyka: zkratky jazyků (ne vlajky), aktivní jazyk aria-pressed, ovládání klávesnicí. */
export function LanguageSwitcher() {
  const { locale, t } = useI18n();
  const setLocale = useSetLocale();
  return (
    <div className="lang-switch" role="group" aria-label={t('language.label')}>
      {languageOptions(locale).map((option) => (
        <button
          key={option.locale}
          type="button"
          lang={option.locale}
          title={option.name}
          aria-pressed={option.active}
          className={option.active ? 'is-active' : undefined}
          onClick={() => setLocale(option.locale)}
        >
          {/* Viditelná zkratka je součástí přístupného jména („CS Čeština“), WCAG 2.5.3. */}
          {option.label}
          <span className="sr-only"> {option.name}</span>
        </button>
      ))}
    </div>
  );
}
