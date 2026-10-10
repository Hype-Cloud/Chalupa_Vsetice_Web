// Potvrzovací e-mail hostovi po vytvoření rezervace (Resend).
//
// - Data: stejný objekt jako úspěšná odpověď API (response.ts → reservationResponse) – kód,
//   cena, splatnost, platební údaje i SPAYD se nepočítají znovu. Datum vytvoření rezervace
//   (hlavička e-mailu) předává handler ze serveru; do veřejné odpovědi API se nepřidává.
// - Jazyk: locale uložené u rezervace (cs | en | de | ua), texty z lib/i18n.
// - Identita provozovatele (jméno, telefon, e-maily, IČO, odkaz do rejstříku, odesílatel) jen
//   z lib/business.ts – renderer žádné údaje o provozovateli nezná napevno.
// - Příjemce: v produkci host; jinde (Preview) jen testovací schránka BOOKING_CONFIRMATION_TEST_EMAIL,
//   skutečná adresa hosta se objeví jen v těle zprávy jako informace.
// - Odesílatel: vždy `BUSINESS_NAME <BUSINESS_EMAIL_RESERVATIONS>` (doména ověřená v Resend).
// - Best-effort: selhání se jen zaloguje (druh chyby), rezervaci ani odpověď API neovlivní.
//   Logy neobsahují jméno, e-mail, telefon, bankovní údaje, SPAYD ani obsah zprávy.
// - Selhání providera (timeout, síť, HTTP 4xx/5xx) → best-effort interní upozornění správci
//   (CONFLICT_ALERT_EMAIL) jen s kódem rezervace, prostředím, druhem chyby a časem. Selhání
//   upozornění se jen zaloguje (žádné další upozornění). Chybějící konfigurace (skipped) není
//   selhání doručení a upozornění negeneruje. Potvrzení se automaticky neopakuje.
// - Renderer renderReservationEmail je obecný (hlavička, nadpis, úvod, souhrn, platba, kontakt,
//   patička) – stejný půjde použít pro potvrzení platby, zrušení nebo připomínku s jinými texty.
// - HTML pro e-mailové klienty: tabulky, inline styly, bez skriptů, webfontů a externích CSS;
//   obrázky (ikona, QR) jako inline přílohy `cid:`.

import { businessIdentity, type BusinessIdentity } from '../../lib/business.ts';
import { bytesToBase64, qrMatrix, qrPngBytes } from '../../lib/booking/qr.ts';
import { createI18n, type Locale } from '../../lib/i18n/index.ts';
import type { Rgb } from '../../lib/png.ts';
import { houseIconBase64 } from '../email/brandIcon.ts';
import { MailError, RESEND_TEST_FROM, sendViaResend, type MailAttachment, type MailMessage } from '../email/resend.ts';
import type { ReservationResponse } from './response.ts';

export interface ConfirmationEnv {
  /** production / preview – rozhoduje o příjemci. */
  BOOKING_ENV?: string;
  /** Secret: API klíč Resend (stejný jako pro interní upozornění). */
  RESEND_API_KEY?: string;
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
/** Content-ID ikony domu v hlavičce. */
export const BRAND_ICON_CONTENT_ID = 'znacka';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: MailAttachment[];
}

export interface EmailOptions {
  /** Datum a čas vytvoření rezervace (ISO 8601) – hlavička e-mailu. */
  createdAt: string;
  /** Identita provozovatele; výchozí z lib/business.ts. */
  business?: BusinessIdentity;
  /** Poznámka o skutečném příjemci (Preview). */
  test?: { originalRecipient: string };
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Barvy webu: tmavě zelená hlavička, světlé pozadí, tlumený text. Kontrast textu v hlavičce
// i tlačítka ≥ 4,5 : 1.
const ACCENT = '#163d33';
const ACCENT_RGB: Rgb = [0x16, 0x3d, 0x33];
const ON_ACCENT = '#ffffff';
const ON_ACCENT_RGB: Rgb = [0xff, 0xff, 0xff];
const ON_ACCENT_MUTED = '#c8d6cf';
const MUTED = '#5c6a63';
const BORDER = '#e2e7e0';
const PAGE = '#f8f9f5';
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Arial,Helvetica,sans-serif';
/** ☎ s výběrem textové (ne emoji) podoby. */
const PHONE_SYMBOL = '☎︎';

/**
 * Obecný e-mail k rezervaci: hlavička (značka, datum vytvoření), nadpis, úvod, souhrn pobytu,
 * platba (instrukce, QR Platba, ruční údaje), telefonický kontakt a patička provozovatele.
 */
export function renderReservationEmail(
  data: ReservationResponse,
  locale: Locale,
  texts: { subject: string; heading: string; intro: string },
  options: EmailOptions,
): RenderedEmail {
  const i18n = createI18n(locale);
  const business = options.business ?? businessIdentity();
  const { reservation: r, payment: p } = data;
  const summary: [string, string][] = [
    [i18n.t('email.reservationCode'), r.reservationCode],
    [i18n.t('reservation.success.stay'), `${i18n.formatDate(r.arrival)} – ${i18n.formatDate(r.departure)}`],
    [i18n.t('reservation.success.nights'), i18n.plural('booking.nights', r.nights)],
    [i18n.t('reservation.success.guests'), i18n.plural('booking.guests', r.guests)],
    [i18n.t('reservation.payment.due'), i18n.formatDeadlineDate(r.paymentDueAt)],
  ];
  const total: [string, string] = [i18n.t('reservation.success.price'), i18n.formatPrice(r.totalCzk)];
  const payment: [string, string][] = [
    [i18n.t('reservation.payment.amount'), i18n.formatPrice(p.amountCzk)],
    [i18n.t('reservation.payment.account'), p.accountNumber],
    [i18n.t('reservation.payment.iban'), p.iban],
    [i18n.t('reservation.payment.variableSymbol'), p.variableSymbol],
  ];
  const received = i18n.t('email.header.received', { date: i18n.formatDeadlineDate(options.createdAt) });
  const paymentHeading = i18n.t('reservation.payment.details');
  const paymentNote = i18n.t('email.paymentNote', { date: i18n.formatDeadlineDate(p.dueAt), vs: p.variableSymbol });
  const thanks = i18n.t('reservation.success.thanks');
  // Čeští hosté vidí číslo bez předvolby, ostatní mezinárodní zápis.
  const phone = locale === 'cs' ? business.phone.national : business.phone.international;
  const cta = { heading: i18n.t('email.cta.heading'), text: i18n.t('email.cta.text'), call: i18n.t('email.cta.call', { phone }) };
  const ico = i18n.t('email.footer.ico', { ico: business.ico });

  // QR ze stejného SPAYD jako API a web; když ho nejde vytvořit, e-mail jde bez QR (ruční údaje stačí).
  const matrix = qrMatrix(p.spayd);
  const attachments: MailAttachment[] = [
    { filename: 'znacka.png', content: houseIconBase64(ACCENT_RGB, ON_ACCENT_RGB), contentId: BRAND_ICON_CONTENT_ID },
    ...(matrix ? [{ filename: 'qr-platba.png', content: bytesToBase64(qrPngBytes(matrix, 6)), contentId: QR_CONTENT_ID }] : []),
  ];

  const testNote = options.test
    ? `TEST (Preview): v produkci by tento e-mail šel na adresu ${options.test.originalRecipient}.`
    : null;

  const row = ([label, value]: [string, string], first: boolean) =>
    `<tr><td style="padding:11px 0;${first ? '' : `border-top:1px solid ${BORDER};`}color:${MUTED};font-size:14px;line-height:20px;">${escapeHtml(label)}</td>` +
    `<td align="right" style="padding:11px 0 11px 16px;${first ? '' : `border-top:1px solid ${BORDER};`}color:${ACCENT};font-size:15px;line-height:20px;text-align:right;">${escapeHtml(value)}</td></tr>`;
  const table = (content: string, margin = '0') =>
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:${margin};border-collapse:collapse;">${content}</table>`;
  const link = (href: string, label: string, color: string) =>
    `<a href="${escapeHtml(href)}" style="color:${color};text-decoration:underline;">${escapeHtml(label)}</a>`;

  const header =
    `<tr><td bgcolor="${ACCENT}" style="background-color:${ACCENT};padding:16px 28px;">` +
    table(
      '<tr>' +
        `<td valign="middle" style="color:${ON_ACCENT};font-family:${SANS};font-size:15px;line-height:24px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;">` +
        `<img src="cid:${BRAND_ICON_CONTENT_ID}" width="24" height="24" alt="" style="display:inline-block;width:24px;height:24px;border:0;vertical-align:middle;margin:0 10px 0 0;">` +
        `<span style="vertical-align:middle;">${escapeHtml(business.name)}</span></td>` +
        `<td align="right" valign="middle" style="color:${ON_ACCENT_MUTED};font-family:${SANS};font-size:12px;line-height:24px;text-align:right;white-space:nowrap;">${escapeHtml(received)}</td>` +
        '</tr>',
    ) +
    '</td></tr>';

  const body = [
    `<tr><td style="padding:32px 28px 8px;">`,
    testNote ? `<p style="margin:0 0 20px;padding:10px 12px;background-color:#f6efe6;color:#784b37;font-size:13px;line-height:18px;">${escapeHtml(testNote)}</p>` : '',
    `<h1 style="margin:0 0 10px;font-family:${SERIF};font-weight:normal;font-size:28px;line-height:34px;color:${ACCENT};">${escapeHtml(texts.heading)}</h1>`,
    `<p style="margin:0 0 24px;font-size:15px;line-height:23px;color:${MUTED};">${escapeHtml(texts.intro)}</p>`,
    // Souhrn; celková cena oddělená výraznější linkou a větším písmem.
    table(
      summary.map((item, i) => row(item, i === 0)).join('') +
        `<tr><td style="padding:14px 0 4px;border-top:2px solid ${ACCENT};color:${ACCENT};font-size:15px;line-height:24px;font-weight:bold;">${escapeHtml(total[0])}</td>` +
        `<td align="right" style="padding:14px 0 4px 16px;border-top:2px solid ${ACCENT};color:${ACCENT};font-family:${SERIF};font-size:24px;line-height:30px;font-weight:bold;text-align:right;white-space:nowrap;">${escapeHtml(total[1])}</td></tr>`,
    ),
    // Platba jako jeden celek: nadpis → instrukce → QR → ruční údaje.
    `<h2 style="margin:40px 0 8px;font-family:${SERIF};font-weight:normal;font-size:21px;line-height:28px;color:${ACCENT};">${escapeHtml(paymentHeading)}</h2>`,
    `<p style="margin:0 0 20px;font-size:15px;line-height:23px;color:${ACCENT};">${escapeHtml(paymentNote)}</p>`,
    matrix
      ? `<p style="margin:0 0 20px;text-align:center;"><img src="cid:${QR_CONTENT_ID}" width="180" height="180" alt="${escapeHtml(i18n.t('email.qrAlt'))}" style="display:inline-block;width:180px;height:180px;border:0;"></p>`
      : '',
    table(payment.map((item, i) => row(item, i === 0)).join('')),
    `<p style="margin:36px 0 0;font-family:${SERIF};font-size:18px;line-height:26px;color:${ACCENT};text-align:center;">${escapeHtml(thanks)}</p>`,
    '</td></tr>',
    // Telefonický kontakt: tlačítko jen s obrysem, aby nepřebilo platební údaje.
    `<tr><td align="center" style="padding:28px 28px 32px;text-align:center;">`,
    `<div style="border-top:1px solid ${BORDER};padding-top:28px;">`,
    `<p style="margin:0 0 4px;font-family:${SERIF};font-size:17px;line-height:24px;color:${ACCENT};">${escapeHtml(cta.heading)}</p>`,
    `<p style="margin:0 0 16px;font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(cta.text)}</p>`,
    `<table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;border-collapse:collapse;"><tr>`,
    `<td align="center" style="border:1px solid ${ACCENT};padding:10px 20px;">`,
    `<a href="${escapeHtml(business.phone.href)}" style="color:${ACCENT};font-size:15px;line-height:20px;font-weight:bold;text-decoration:none;white-space:nowrap;">`,
    `<span aria-hidden="true">${PHONE_SYMBOL}</span>&nbsp; ${escapeHtml(cta.call)}</a>`,
    '</td></tr></table>',
    '</div>',
    '</td></tr>',
  ].join('');

  const footer =
    `<tr><td align="center" style="padding:20px 12px 0;font-size:12px;line-height:20px;color:${MUTED};text-align:center;">` +
    `<span style="color:${ACCENT};">${escapeHtml(business.name)}</span>` +
    ` &nbsp;·&nbsp; ${link(`mailto:${business.emailInfo}`, business.emailInfo, MUTED)}` +
    ` &nbsp;·&nbsp; ${link(business.registerUrl, ico, MUTED)}` +
    '</td></tr>';

  const html = [
    '<!doctype html>',
    `<html lang="${locale === 'ua' ? 'uk' : locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(texts.subject)}</title></head>`,
    `<body style="margin:0;padding:0;background-color:${PAGE};font-family:${SANS};color:${ACCENT};">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};"><tr><td align="center" style="padding:24px 12px 32px;">`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;font-family:${SANS};">`,
    `<tr><td bgcolor="#ffffff" style="background-color:#ffffff;border:1px solid ${BORDER};">`,
    table(header + body),
    '</td></tr>',
    footer,
    '</table>',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  const textLines = [
    ...(testNote ? [testNote, ''] : []),
    `${business.name} · ${received}`,
    '',
    texts.heading,
    '',
    texts.intro,
    '',
    ...[...summary, total].map(([label, value]) => `${label}: ${value}`),
    '',
    paymentHeading,
    paymentNote,
    ...payment.map(([label, value]) => `${label}: ${value}`),
    '',
    thanks,
    '',
    cta.heading,
    cta.text,
    cta.call,
    '',
    '--',
    business.name,
    business.emailInfo,
    ico,
  ];

  return { subject: texts.subject, html, text: textLines.join('\n'), attachments };
}

/** Potvrzení přijetí rezervace (texty v jazyce hosta). */
export function renderConfirmationEmail(data: ReservationResponse, locale: Locale, options: EmailOptions): RenderedEmail {
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

/** Odesílatel potvrzení: vždy z identity provozovatele (`BUSINESS_NAME <BUSINESS_EMAIL_RESERVATIONS>`). */
export const confirmationSender = (business: BusinessIdentity = businessIdentity()) => business.reservationsSender;

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
 * Pořadí kontrol konfigurace: RESEND_API_KEY → příjemce (každá chybějící = skipped).
 */
export async function sendReservationConfirmation(
  env: ConfirmationEnv,
  data: ReservationResponse,
  context: { guestEmail: string; locale: Locale; createdAt: string },
  deps: ConfirmationDeps & { now: () => Date },
): Promise<'sent' | 'skipped' | 'failed'> {
  const apiKey = env.RESEND_API_KEY?.trim();
  try {
    if (!apiKey) {
      deps.log('reservations: confirmation email skipped (not configured)');
      return 'skipped';
    }
    const recipient = confirmationRecipient(env, context.guestEmail);
    if (!recipient) {
      deps.log('reservations: confirmation email skipped (no test recipient)');
      return 'skipped';
    }
    const business = businessIdentity();
    const email = renderConfirmationEmail(data, context.locale, {
      createdAt: context.createdAt,
      business,
      ...(recipient.test ? { test: { originalRecipient: context.guestEmail } } : {}),
    });
    const message: MailMessage = {
      from: confirmationSender(business),
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
