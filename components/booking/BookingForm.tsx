import { useEffect, useId, useRef } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { useI18n } from '../i18n.ts';
import { FIELD_ERROR_KEYS, reservationErrorKey, SUBMIT_BLOCK_KEYS, type ContactDraft, type ReservationConfirmation, type SubmissionState, type SubmitBlock } from './reservation.ts';
import { Turnstile } from './Turnstile.tsx';

interface Props {
  contact: ContactDraft;
  onContact: (contact: ContactDraft) => void;
  submission: SubmissionState;
  /** Proč nelze odeslat (null = lze). */
  block: SubmitBlock;
  /** Hláška o změně ceny (už zformátovaná), nebo null. */
  priceChanged: string | null;
  siteKey: string;
  turnstileResetSignal: number;
  onToken: (token: string | null) => void;
  onSubmit: () => void;
}

const FIELDS = [
  { name: 'firstName', label: 'reservation.form.firstName', autoComplete: 'given-name', type: 'text' },
  { name: 'lastName', label: 'reservation.form.lastName', autoComplete: 'family-name', type: 'text' },
  { name: 'email', label: 'reservation.form.email', autoComplete: 'email', type: 'email' },
  { name: 'phone', label: 'reservation.form.phone', autoComplete: 'tel', type: 'tel' },
] as const;

/** Kontaktní část pod celým blokem kalendáře a panelu (bez kroků, bez modalu). */
export function BookingForm({ contact, onContact, submission, block, priceChanged, siteKey, turnstileResetSignal, onToken, onSubmit }: Props) {
  const { t } = useI18n();
  const id = useId();
  const section = useRef<HTMLElement>(null);

  // Jen při prvním otevření: jemně posunout ke kontaktní části, pokud není vidět.
  useEffect(() => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    section.current?.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'nearest' });
  }, []);

  const fieldErrors = submission.status === 'invalid' ? submission.fields : [];
  const fieldError = (name: string) => (fieldErrors.includes(name) && FIELD_ERROR_KEYS[name] ? t(FIELD_ERROR_KEYS[name]) : null);
  const update = (name: keyof ContactDraft, value: string) => onContact({ ...contact, [name]: value });
  const submitting = submission.status === 'submitting';

  // Jedna stavová zpráva u tlačítka (oznamuje ji čtečka obrazovky).
  let status: { text: string; error: boolean } | null = null;
  if (submission.status === 'error') status = { text: t(reservationErrorKey(submission.code)), error: true };
  else if (submission.status === 'invalid') status = { text: t('reservation.error.invalidRequest'), error: true };
  else if (priceChanged) status = { text: priceChanged, error: true };
  else if (block && block !== 'submitting') status = { text: t(SUBMIT_BLOCK_KEYS[block]), error: false };

  return (
    <section ref={section} className="booking-form" aria-labelledby={`${id}-title`}>
      <p className="booking-form-title" id={`${id}-title`}>{t('reservation.form.label')}</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!block) onSubmit();
        }}
      >
        <div className="form-grid">
          {FIELDS.map((field) => {
            const error = fieldError(field.name);
            return (
              <div key={field.name} className={`form-field is-${field.name}`}>
                <label htmlFor={`${id}-${field.name}`}>{t(field.label)}</label>
                <input
                  id={`${id}-${field.name}`}
                  type={field.type}
                  autoComplete={field.autoComplete}
                  value={contact[field.name]}
                  required
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? `${id}-${field.name}-error` : undefined}
                  onChange={(e) => update(field.name, e.target.value)}
                />
                {error && <p id={`${id}-${field.name}-error`} className="field-error">{error}</p>}
              </div>
            );
          })}
          <div className="form-field is-note">
            <label htmlFor={`${id}-note`}>
              {t('reservation.form.note')} <span className="optional">({t('reservation.form.optional')})</span>
            </label>
            <textarea
              id={`${id}-note`}
              rows={2}
              maxLength={2000}
              value={contact.note}
              aria-invalid={fieldError('note') ? true : undefined}
              aria-describedby={fieldError('note') ? `${id}-note-error` : undefined}
              onChange={(e) => update('note', e.target.value)}
            />
            {fieldError('note') && <p id={`${id}-note-error`} className="field-error">{fieldError('note')}</p>}
          </div>
        </div>
        <Turnstile siteKey={siteKey} resetSignal={turnstileResetSignal} onToken={onToken} />
        <p className={`form-status${status?.error ? ' is-error' : ''}`} role="status" aria-live="polite">
          {status?.text}
        </p>
        <button type="submit" className="button" disabled={block !== null} aria-busy={submitting}>
          {submitting ? t('reservation.form.submitting') : submission.status === 'error' && submission.retryable ? t('reservation.retry') : t('reservation.form.submit')}
          {!submitting && <ArrowUpRight size={18} />}
        </button>
      </form>
    </section>
  );
}

/** Potvrzení po úspěšném odeslání – jen údaje, které vrací server. */
export function BookingSuccess({ reservation }: { reservation: ReservationConfirmation }) {
  const { t, plural, formatDate, formatPrice } = useI18n();
  const heading = useRef<HTMLParagraphElement>(null);
  useEffect(() => heading.current?.focus(), []);
  return (
    <div className="booking-success" role="status">
      <p className="price booking-success-title" tabIndex={-1} ref={heading}>{t('reservation.success.title')}</p>
      <dl className="estimate">
        <div className="booking-code"><dt>{t('reservation.success.code')}</dt><dd>{reservation.code}</dd></div>
        <div><dt>{t('reservation.success.stay')}</dt><dd>{formatDate(reservation.arrival)} – {formatDate(reservation.departure)}</dd></div>
        <div><dt>{t('reservation.success.guests')}</dt><dd>{plural('booking.guests', reservation.guests)}</dd></div>
        <div><dt>{t('reservation.success.nights')}</dt><dd>{plural('booking.nights', reservation.nights)}</dd></div>
        <div><dt>{t('reservation.success.price')}</dt><dd>{formatPrice(reservation.priceCzk)}</dd></div>
      </dl>
      <p className="small">{t('reservation.success.keepCode')}</p>
    </div>
  );
}
