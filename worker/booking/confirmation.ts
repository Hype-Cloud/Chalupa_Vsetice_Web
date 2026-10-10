// Potvrzovací e-mail hostovi po vytvoření rezervace (Resend).
//
// - Data: stejný objekt jako úspěšná odpověď API (response.ts → reservationResponse) – kód,
//   cena, splatnost, platební údaje i SPAYD se nepočítají znovu.
// - Jazyk: locale uložené u rezervace (cs | en | de | ua), texty z lib/i18n.
// - Příjemce: v produkci host; jinde (Preview) jen testovací schránka BOOKING_CONFIRMATION_TEST_EMAIL,
//   skutečná adresa hosta se objeví jen v těle zprávy jako informace.
// - Odesílatel: BOOKING_EMAIL_FROM; testovací odesílatel Resend jen mimo produkci. V produkci
//   bez BOOKING_EMAIL_FROM se e-mail neodešle (skipped).
// - Best-effort: selhání se jen zaloguje (druh chyby), rezervaci ani odpověď API neovlivní.
//   Logy neobsahují jméno, e-mail, telefon, bankovní údaje, SPAYD ani obsah zprávy.
// - Selhání providera (timeout, síť, HTTP 4xx/5xx) → best-effort interní upozornění správci
//   (CONFLICT_ALERT_EMAIL) jen s kódem rezervace, prostředím, druhem chyby a časem. Selhání
//   upozornění se jen zaloguje (žádné další upozornění). Chybějící konfigurace (skipped) není
//   selhání doručení a upozornění negeneruje. Potvrzení se automaticky neopakuje.
// - Renderer renderReservationEmail je obecný (nadpis, úvod, souhrn, platba) – stejný půjde
//   použít pro potvrzení platby, zrušení nebo připomínku splatnosti s jinými texty.

import { bytesToBase64, qrMatrix, qrPngBytes } from '../../lib/booking/qr.ts';
import { createI18n, type Locale } from '../../lib/i18n/index.ts';
import { MailError, RESEND_TEST_FROM, sendViaResend, type MailAttachment, type MailMessage } from '../email/resend.ts';
import type { ReservationResponse } from './response.ts';

export interface ConfirmationEnv {
  /** production / preview – rozhoduje o příjemci. */
  BOOKING_ENV?: string;
  /** Secret: API klíč Resend (stejný jako pro interní upozornění). */
  RESEND_API_KEY?: string;
  /**
   * Odesílatel e-mailů hostům (např. `Chalupa Všetice <rezervace@…>`). Mimo produkci bez nastavení
   * testovací odesílatel Resend; v produkci povinný – bez něj se potvrzení neodešle.
   */
  BOOKING_EMAIL_FROM?: string;
  /** Secret (Preview): testovací schránka, kam jdou všechna potvrzení mimo produkci. */
  BOOKING_CONFIRMATION_TEST_EMAIL?: string;
  /** Secret: adresa správce pro interní upozornění (sdílená s upozorněním na kolize). */
  CONFLICT_ALERT_EMAIL?: string;
  /** Odesílatel interních upozornění; bez nastavení testovací odesílatel Resend. */
  CONFLICT_ALERT_FROM?: string;
}

export interface ConfirmationDeps {
  fetch: typeof fetch;
  log: (message: string) => void;
}

/** Content-ID inline obrázku QR Platby. */
export const QR_CONTENT_ID = 'qr-platba';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: MailAttachment[];
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const ACCENT = '#163d33';
const MUTED = '#5c6a63';
const BORDER = '#e2e7e0';

/**
 * Obecný e-mail k rezervaci: nadpis, úvod, souhrn pobytu (vč. kódu a splatnosti), platební údaje
 * a QR Platba (PNG jako inline příloha `cid:`). `test` = poznámka o skutečném příjemci (Preview).
 */
export function renderReservationEmail(
  data: ReservationResponse,
  locale: Locale,
  texts: { subject: string; heading: string; intro: string },
  options: { test?: { originalRecipient: string } } = {},
): RenderedEmail {
  const i18n = createI18n(locale);
  const { reservation: r, payment: p } = data;
  const summary: [string, string][] = [
    [i18n.t('email.reservationCode'), r.reservationCode],
    [i18n.t('reservation.success.stay'), `${i18n.formatDate(r.arrival)} – ${i18n.formatDate(r.departure)}`],
    [i18n.t('reservation.success.nights'), i18n.plural('booking.nights', r.nights)],
    [i18n.t('reservation.success.guests'), i18n.plural('booking.guests', r.guests)],
    [i18n.t('reservation.payment.due'), i18n.formatDeadlineDate(r.paymentDueAt)],
    [i18n.t('reservation.success.price'), i18n.formatPrice(r.totalCzk)],
  ];
  const payment: [string, string][] = [
    [i18n.t('reservation.payment.amount'), i18n.formatPrice(p.amountCzk)],
    [i18n.t('reservation.payment.account'), p.accountNumber],
    [i18n.t('reservation.payment.iban'), p.iban],
    [i18n.t('reservation.payment.variableSymbol'), p.variableSymbol],
  ];
  const paymentNote = i18n.t('email.paymentNote', { date: i18n.formatDeadlineDate(p.dueAt), vs: p.variableSymbol });
  const paymentHeading = i18n.t('reservation.payment.details');
  const qrLabel = i18n.t('reservation.payment.qrLabel');
  const thanks = i18n.t('reservation.success.thanks');

  // QR ze stejného SPAYD jako API a web; když ho nejde vytvořit, e-mail jde bez QR (ruční údaje stačí).
  const matrix = qrMatrix(p.spayd);
  const attachments: MailAttachment[] = matrix ? [{ filename: 'qr-platba.png', content: bytesToBase64(qrPngBytes(matrix, 6)), contentId: QR_CONTENT_ID }] : [];

  const testNote = options.test
    ? `TEST (Preview): v produkci by tento e-mail šel na adresu ${options.test.originalRecipient}.`
    : null;

  const rows = (items: [string, string][]) =>
    items
      .map(([label, value]) =>
        `<tr><td style="padding:8px 0;border-top:1px solid ${BORDER};color:${MUTED};font-size:14px;">${escapeHtml(label)}</td>` +
        `<td style="padding:8px 0;border-top:1px solid ${BORDER};color:${ACCENT};font-size:14px;font-weight:bold;text-align:right;">${escapeHtml(value)}</td></tr>`,
      )
      .join('');

  const html = [
    '<!doctype html>',
    `<html lang="${locale === 'ua' ? 'uk' : locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(texts.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background:#f8f9f5;font-family:Arial,Helvetica,sans-serif;color:${ACCENT};">`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f8f9f5;"><tr><td align="center" style="padding:24px 12px;">',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${BORDER};border-radius:8px;">`,
    '<tr><td style="padding:28px 28px 8px;">',
    testNote ? `<p style="margin:0 0 16px;padding:10px 12px;background:#f6efe6;color:#784b37;font-size:13px;">${escapeHtml(testNote)}</p>` : '',
    `<h1 style="margin:0 0 8px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:26px;color:${ACCENT};">${escapeHtml(texts.heading)}</h1>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:1.5;color:${MUTED};">${escapeHtml(texts.intro)}</p>`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(summary)}</table>`,
    `<h2 style="margin:28px 0 8px;font-family:Georgia,'Times New Roman',serif;font-weight:normal;font-size:20px;color:${ACCENT};">${escapeHtml(paymentHeading)}</h2>`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:${MUTED};">${escapeHtml(paymentNote)}</p>`,
    matrix
      ? `<p style="margin:8px 0 4px;text-align:center;"><img src="cid:${QR_CONTENT_ID}" width="180" height="180" alt="${escapeHtml(qrLabel)}" style="display:inline-block;width:180px;height:180px;border:0;"></p>` +
        `<p style="margin:0 0 16px;text-align:center;font-size:12px;color:${MUTED};">${escapeHtml(qrLabel)}</p>`
      : '',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows(payment)}</table>`,
    `<p style="margin:28px 0 20px;font-family:Georgia,'Times New Roman',serif;font-size:17px;color:${ACCENT};text-align:center;">${escapeHtml(thanks)}</p>`,
    '</td></tr></table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  const textLines = [
    ...(testNote ? [testNote, ''] : []),
    texts.heading,
    '',
    texts.intro,
    '',
    ...summary.map(([label, value]) => `${label}: ${value}`),
    '',
    `${paymentHeading}:`,
    paymentNote,
    ...payment.map(([label, value]) => `${label}: ${value}`),
    '',
    thanks,
  ];

  return { subject: texts.subject, html, text: textLines.join('\n'), attachments };
}

/** Potvrzení přijetí rezervace (texty v jazyce hosta). */
export function renderConfirmationEmail(data: ReservationResponse, locale: Locale, options: { test?: { originalRecipient: string } } = {}): RenderedEmail {
  const i18n = createI18n(locale);
  const subject = `${options.test ? '[TEST] ' : ''}${i18n.t('email.confirmation.subject', { code: data.reservation.reservationCode })}`;
  return renderReservationEmail(data, locale, { subject, heading: i18n.t('reservation.success.title'), intro: i18n.t('email.confirmation.intro') }, options);
}

/** Komu e-mail poslat: v produkci host, jinde jen testovací schránka (nebo nikomu). */
export function confirmationRecipient(env: ConfirmationEnv, guestEmail: string): { to: string; test: boolean } | null {
  if (env.BOOKING_ENV === 'production') return { to: guestEmail, test: false };
  const testRecipient = env.BOOKING_CONFIRMATION_TEST_EMAIL?.trim();
  return testRecipient ? { to: testRecipient, test: true } : null;
}

/** Odesílatel potvrzení: explicitní BOOKING_EMAIL_FROM; testovací odesílatel Resend jen mimo produkci. */
export function confirmationSender(env: ConfirmationEnv): string | null {
  const from = env.BOOKING_EMAIL_FROM?.trim();
  if (from) return from;
  return env.BOOKING_ENV === 'production' ? null : RESEND_TEST_FROM;
}

/** Interní upozornění na selhání potvrzení – jen kód rezervace, prostředí, druh chyby a čas. */
export function buildConfirmationFailureAlert(alert: { reservationCode: string; env: string; kind: string; failedAt: Date }): { subject: string; text: string } {
  const prefix = alert.env === 'production' ? '' : '[TEST] ';
  const time = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', dateStyle: 'short', timeStyle: 'medium' }).format(alert.failedAt);
  return {
    subject: `${prefix}POZOR: potvrzovací e-mail rezervace ${alert.reservationCode} selhal`,
    text: [
      'Potvrzovací e-mail hostovi se nepodařilo odeslat. Rezervace je vytvořená.',
      'Kontaktujte prosím hosta ručně (údaje v e-chalupách / exportu rezervací).',
      '',
      `Rezervace: ${alert.reservationCode}`,
      `Prostředí: ${alert.env}`,
      `Chyba: ${alert.kind}`,
      `Čas: ${time} (${alert.failedAt.toISOString()})`,
      '',
      'Potvrzení se automaticky neopakuje.',
    ].join('\n'),
  };
}

/** Best-effort upozornění správci; nikdy nevyhazuje a samo žádné další upozornění nespouští. */
async function sendConfirmationFailureAlert(env: ConfirmationEnv, apiKey: string, reservationCode: string, kind: string, deps: ConfirmationDeps & { now: () => Date }): Promise<void> {
  const to = env.CONFLICT_ALERT_EMAIL?.trim();
  if (!to) {
    deps.log('reservations: confirmation failure alert skipped (not configured)');
    return;
  }
  const bookingEnv = env.BOOKING_ENV ?? 'unknown';
  const { subject, text } = buildConfirmationFailureAlert({ reservationCode, env: bookingEnv, kind, failedAt: deps.now() });
  try {
    await sendViaResend(
      apiKey,
      { from: env.CONFLICT_ALERT_FROM?.trim() || RESEND_TEST_FROM, to, subject, text, idempotencyKey: `confirmation-failure-alert-${bookingEnv}-${reservationCode}` },
      deps.fetch,
    );
    deps.log('reservations: confirmation failure alert sent');
  } catch (error) {
    deps.log(`reservations: confirmation failure alert failed (${error instanceof MailError ? error.kind : 'unknown'})`);
  }
}

/**
 * Odešle potvrzení nově vytvořené rezervace. Nikdy nevyhazuje (best-effort); vrací výsledek
 * jen pro testy a logy. Idempotency-Key z kódu rezervace brání duplicitě i na straně Resend.
 * Pořadí kontrol konfigurace: RESEND_API_KEY → příjemce → odesílatel (každá chybějící = skipped).
 */
export async function sendReservationConfirmation(
  env: ConfirmationEnv,
  data: ReservationResponse,
  guest: { email: string; locale: Locale },
  deps: ConfirmationDeps & { now: () => Date },
): Promise<'sent' | 'skipped' | 'failed'> {
  const apiKey = env.RESEND_API_KEY?.trim();
  try {
    if (!apiKey) {
      deps.log('reservations: confirmation email skipped (not configured)');
      return 'skipped';
    }
    const recipient = confirmationRecipient(env, guest.email);
    if (!recipient) {
      deps.log('reservations: confirmation email skipped (no test recipient)');
      return 'skipped';
    }
    const from = confirmationSender(env);
    if (!from) {
      deps.log('reservations: confirmation email skipped (no sender)');
      return 'skipped';
    }
    const email = renderConfirmationEmail(data, guest.locale, recipient.test ? { test: { originalRecipient: guest.email } } : {});
    const message: MailMessage = {
      from,
      to: recipient.to,
      ...email,
      idempotencyKey: `reservation-confirmation-${env.BOOKING_ENV ?? 'unknown'}-${data.reservation.reservationCode}`,
    };
    await sendViaResend(apiKey, message, deps.fetch);
    deps.log('reservations: confirmation email sent');
    return 'sent';
  } catch (error) {
    const kind = error instanceof MailError ? error.kind : 'unknown';
    deps.log(`reservations: confirmation email failed (${kind})`);
    // Jen selhání doručení přes providera (timeout, síť, HTTP) – ne chyba v kódu ani konfiguraci.
    if (error instanceof MailError && apiKey) await sendConfirmationFailureAlert(env, apiKey, data.reservation.reservationCode, kind, deps);
    return 'failed';
  }
}
