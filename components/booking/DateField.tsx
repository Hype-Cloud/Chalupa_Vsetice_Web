import { useEffect, useId, useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import type { IsoDate } from '../../lib/availability/dates.ts';
import { useI18n } from '../i18n.ts';
import { formatDateInput, parseDateInput } from './dateInput.ts';

interface Props {
  label: string;
  /** Autoritativní hodnota (ISO) z centrálního stavu pobytu. */
  value: IsoDate | null;
  min?: IsoDate;
  /** Platné úplné datum (nebo null po vymazání) → centrální stav (stejná validace jako kalendář). */
  onCommit: (date: IsoDate | null) => void;
}

/**
 * Datum ve tvaru DD.MM.RRRR nezávisle na jazyku prohlížeče. Rozepsaný text je jen lokální
 * koncept pro psaní – autoritativní je ISO hodnota v centrálním stavu. Nativní date picker
 * slouží jen k výběru (jeho formát uživatel ve vlastním poli nevidí).
 */
export function DateField({ label, value, min, onCommit }: Props) {
  const { t } = useI18n();
  const id = useId();
  const errorId = `${id}-error`;
  const [draft, setDraft] = useState(value ? formatDateInput(value) : '');
  const [error, setError] = useState<'format' | 'invalid' | null>(null);
  const focused = useRef(false);
  const picker = useRef<HTMLInputElement>(null);
  const [canPick, setCanPick] = useState(false);
  useEffect(() => setCanPick(typeof HTMLInputElement !== 'undefined' && 'showPicker' in HTMLInputElement.prototype), []);

  // Změna z kalendáře nebo pickeru přepíše koncept – ne během psaní v tomto poli.
  useEffect(() => {
    if (focused.current) return;
    setDraft(value ? formatDateInput(value) : '');
    setError(null);
  }, [value]);

  const onChange = (text: string) => {
    setDraft(text);
    const parsed = parseDateInput(text);
    if (parsed.status === 'valid') {
      setError(null);
      if (parsed.iso !== value) onCommit(parsed.iso);
    } else {
      // Rozepsaný text není chyba; neexistující úplné datum ano (nic se neopravuje).
      setError(parsed.status === 'invalid' ? 'invalid' : null);
    }
  };

  const onBlur = () => {
    focused.current = false;
    const parsed = parseDateInput(draft);
    if (parsed.status === 'empty') {
      setError(null);
      if (value) onCommit(null);
    } else if (parsed.status === 'partial' || parsed.status === 'malformed') {
      setError('format');
    } else if (parsed.status === 'valid') {
      setDraft(formatDateInput(parsed.iso));
    }
  };

  return (
    <div className="date-field">
      <label htmlFor={id}>{label}</label>
      <div className="date-field-control">
        <input
          id={id}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          placeholder={t('dateInput.placeholder')}
          value={draft}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onFocus={() => (focused.current = true)}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
        />
        {canPick && (
          <>
            <button type="button" className="date-picker-button" aria-label={t('dateInput.openPicker', { field: label })} onClick={() => picker.current?.showPicker()}>
              <CalendarDays size={18} strokeWidth={1.6} aria-hidden="true" />
            </button>
            <input
              ref={picker}
              type="date"
              className="date-picker-proxy"
              tabIndex={-1}
              aria-hidden="true"
              min={min}
              value={value ?? ''}
              onChange={(e) => {
                const iso = e.target.value;
                if (!iso) return;
                setDraft(formatDateInput(iso));
                setError(null);
                onCommit(iso);
              }}
            />
          </>
        )}
      </div>
      {error && (
        <p id={errorId} className="field-error">
          {t(error === 'invalid' ? 'dateInput.error.invalid' : 'dateInput.error.format')}
        </p>
      )}
    </div>
  );
}
