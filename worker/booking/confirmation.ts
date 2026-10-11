// Potvrzovací e-mail hostovi po vytvoření rezervace (Resend).
//
// - Data: stejný objekt jako úspěšná odpověď API (response.ts → reservationResponse) – kód,
//   cena, splatnost, platební údaje i SPAYD se nepočítají znovu.
// - Jazyk: locale uložené u rezervace (cs | en | de | ua), texty z lib/i18n.
// - Identita provozovatele (jméno, telefon, e-maily, IČO, odkaz do rejstříku, odesílatel) jen
//   z lib/business.ts – renderer žádné údaje o provozovateli nezná napevno.
// - Příjemce: v produkci host; jinde (Preview) jen testovací schránka BOOKING_CONFIRMATION_TEST_EMAIL.
//   Obsah je v Preview stejný jako v produkci (kvůli kontrole vzhledu), liší se jen prefix
//   `[TEST]` v předmětu.
// - Odesílatel: vždy `BUSINESS_NAME <BUSINESS_EMAIL_RESERVATIONS>` (doména ověřená v Resend).
// - Best-effort: selhání se jen zaloguje (druh chyby), rezervaci ani odpověď API neovlivní.
//   Logy neobsahují jméno, e-mail, telefon, bankovní údaje, SPAYD ani obsah zprávy.
// - Selhání providera (timeout, síť, HTTP 4xx/5xx) → best-effort interní upozornění správci
//   (CONFLICT_ALERT_EMAIL) jen s kódem rezervace, prostředím, druhem chyby a časem. Selhání
//   upozornění se jen zaloguje (žádné další upozornění). Chybějící konfigurace (skipped) není
//   selhání doručení a upozornění negeneruje. Potvrzení se automaticky neopakuje.
// - Renderer renderReservationEmail je obecný (hlavička, nadpis, úvod, souhrn, platba, kontakt,
//   patička) – stejný půjde použít pro potvrzení platby, zrušení nebo připomínku s jinými texty.
// - HTML pro e-mailové klienty: tabulky, inline styly a bgcolor (platí všude), bez skriptů,
//   webfontů a externích CSS; obrázky (značka, sluchátko, QR) jako inline přílohy `cid:`.
//   Značka a sluchátko jsou předgenerované PNG (worker/email/iconAssets.ts); za běhu se
//   kreslí jen QR.
//   Vložené <style> je jen vylepšení: užší okraje na mobilu, tmavý režim (Apple Mail,
//   Outlook.com) a vypnutí automatických odkazů Apple Mail. Bez něj zůstává světlá varianta.

import { businessIdentity, type BusinessIdentity } from '../../lib/business.ts';
import { bytesToBase64, qrMatrix, qrPngBytes } from '../../lib/booking/qr.ts';
import { createI18n, type Locale } from '../../lib/i18n/index.ts';
import { BRAND_MARK_PNG, PHONE_ICON_DARK_PNG, PHONE_ICON_LIGHT_PNG } from '../email/iconAssets.ts';
import { CREAM, GREEN, WHITE } from '../email/palette.ts';
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
/** Content-ID domku v hlavičce a sluchátka v tlačítku (světlá / tmavá varianta). */
export const BRAND_MARK_CONTENT_ID = 'znacka';
export const PHONE_ICON_CONTENT_ID = 'telefon';
export const PHONE_ICON_DARK_CONTENT_ID = 'telefon-tmavy';

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments: MailAttachment[];
}

export interface EmailOptions {
  /** Identita provozovatele; výchozí z lib/business.ts. */
  business?: BusinessIdentity;
  /** Preview: jen prefix `[TEST]` v předmětu; obsah je stejný jako v produkci. */
  test?: boolean;
}

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

// Barvy webu (app/globals.css): tmavě zelená, světle krémově zelená (tlačítka na tmavém
// pozadí), tlumená šedozelená. Žádné jiné odstíny – ani v tmavém režimu.
const MUTED = '#5c6a63';
const BORDER = '#e2e7e0';
const PAGE = '#f8f9f5';
// Tmavý režim (Apple Mail, Outlook.com): tmavě zelené plochy, krémový text a akcenty.
const DARK = { page: '#0f1915', card: '#15211c', line: '#2a3a32', text: '#e8eee0', muted: '#a8b6a9', link: '#cfddc2' };
const SERIF = "Georgia,'Times New Roman',serif";
const SANS = 'Arial,Helvetica,sans-serif';
const WIDTH = 680;
const PAD = 40;

/**
 * Vložené styly (progresivní vylepšení). Gmail při nepodporovaném selektoru zahodí celý blok,
 * proto jsou atributové selektory (Apple, Outlook.com) ve vlastním bloku.
 */
const STYLES = [
  '<style>',
  ':root{color-scheme:light dark;supported-color-schemes:light dark}',
  '@media only screen and (max-width:620px){',
  '.e-outer{padding:12px 8px 24px!important}',
  '.e-px{padding-left:18px!important;padding-right:18px!important}',
  '.e-h1{font-size:24px!important;line-height:30px!important}',
  '.e-val{padding-left:12px!important;font-size:14px!important}',
  '.e-brand{font-size:14px!important;letter-spacing:.5px!important}',
  '.e-stay{font-size:12px!important;white-space:normal!important}',
  '.e-btn a{white-space:normal!important;padding:12px 20px!important}',
  '.e-sep{display:none!important}',
  '.e-item{display:block!important}',
  '}',
  // IBAN se láme jen na velmi úzkém displeji (jinak se zalomí popisky).
  '@media only screen and (max-width:360px){.e-nowrap{white-space:normal!important;overflow-wrap:anywhere!important;word-break:break-all!important}}',
  '@media (prefers-color-scheme:dark){',
  `.e-page{background-color:${DARK.page}!important}`,
  `.e-card{background-color:${DARK.card}!important;border-color:${DARK.line}!important}`,
  `.e-text{color:${DARK.text}!important}`,
  `.e-muted{color:${DARK.muted}!important}`,
  `.e-line{border-color:${DARK.line}!important}`,
  `.e-total{border-color:${CREAM}!important}`,
  `.e-btn{background-color:${CREAM}!important}`,
  `.e-btn a,.e-btn span{color:${GREEN}!important}`,
  '.e-ico{display:none!important}',
  '.e-ico-dark{display:inline-block!important;width:18px!important;height:18px!important;max-height:none!important}',
  `.e-foot a{color:${DARK.link}!important}`,
  '}',
  '</style>',
  '<style>',
  // Apple Mail jinak barví rozpoznaná data, čísla a adresy systémovou modrou.
  'a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}',
  // Outlook.com v tmavém režimu: zachovat značkové barvy hlavičky a tlačítka.
  `[data-ogsb] .e-header,[data-ogsb] .e-btn{background-color:${GREEN}!important}`,
  `[data-ogsc] .e-header,[data-ogsc] .e-btn a,[data-ogsc] .e-btn span{color:${WHITE}!important}`,
  `[data-ogsc] .e-stay{color:${CREAM}!important}`,
  '</style>',
].join('');

/**
 * Obecný e-mail k rezervaci: hlavička (značka, termín pobytu), nadpis, úvod, souhrn pobytu,
 * platba (instrukce, QR Platba, ruční údaje), telefonický kontakt a patička provozovatele.
 */
export function renderReservationEmail(
  data: ReservationResponse,
  locale: Locale,
  texts: { subject: string; heading: string; intro: string[] },
  options: EmailOptions = {},
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
  const stay = i18n.formatDateRange(r.arrival, r.departure);
  const paymentHeading = i18n.t('reservation.payment.details');
  const thanks = i18n.t('reservation.success.thanks');
  // Čeští hosté vidí číslo bez předvolby, ostatní mezinárodní zápis.
  const phone = locale === 'cs' ? business.phone.national : business.phone.international;
  const cta = { heading: i18n.t('email.cta.heading'), text: i18n.t('email.cta.text'), call: i18n.t('email.cta.call', { phone }) };
  const ico = i18n.t('email.footer.ico', { ico: business.ico });

  // QR ze stejného SPAYD jako API a web; když ho nejde vytvořit, e-mail jde bez QR (ruční údaje stačí).
  const matrix = qrMatrix(p.spayd);
  const attachments: MailAttachment[] = [
    // Statické ikony jsou předgenerované (scripts/email-icons.ts) – žádné rastrování za běhu.
    { filename: 'znacka.png', content: BRAND_MARK_PNG, contentId: BRAND_MARK_CONTENT_ID },
    { filename: 'telefon.png', content: PHONE_ICON_LIGHT_PNG, contentId: PHONE_ICON_CONTENT_ID },
    { filename: 'telefon-tmavy.png', content: PHONE_ICON_DARK_PNG, contentId: PHONE_ICON_DARK_CONTENT_ID },
    ...(matrix ? [{ filename: 'qr-platba.png', content: bytesToBase64(qrPngBytes(matrix, 6)), contentId: QR_CONTENT_ID }] : []),
  ];

  const table = (content: string, attrs = 'width="100%"', style = '') =>
    `<table role="presentation" ${attrs} cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;${style}">${content}</table>`;
  const row = ([label, value]: [string, string], first: boolean, nowrap = false) => {
    const line = first ? '' : `border-top:1px solid ${BORDER};`;
    return (
      `<tr><td class="e-muted${first ? '' : ' e-line'}" style="padding:12px 0;${line}color:${MUTED};font-size:14px;line-height:21px;">${escapeHtml(label)}</td>` +
      `<td class="e-text e-val${first ? '' : ' e-line'}${nowrap ? ' e-nowrap' : ''}" align="right" style="padding:12px 0 12px 24px;${line}color:${GREEN};font-size:15px;line-height:21px;text-align:right;${nowrap ? 'white-space:nowrap;' : ''}">${escapeHtml(value)}</td></tr>`
    );
  };
  const link = (href: string, label: string) => `<a href="${escapeHtml(href)}" style="color:${MUTED};text-decoration:underline;">${escapeHtml(label)}</a>`;

  const header =
    `<tr><td class="e-header e-px" bgcolor="${GREEN}" style="background-color:${GREEN};padding:14px ${PAD}px;color:${WHITE};">` +
    table(
      '<tr>' +
        `<td valign="middle" style="padding:0;">` +
        table(
          // Domek jako logo webu (24 px), bílý na průhledném pozadí přímo na hlavičce – bez
          // vlastní plochy. Jméno jednotnou normální vahou ve verzálkách s prostrkáním.
          `<tr><td width="24" valign="middle" style="width:24px;padding:0;"><img src="cid:${BRAND_MARK_CONTENT_ID}" width="24" height="24" alt="" style="display:block;width:24px;height:24px;border:0;"></td>` +
            `<td valign="middle" class="e-brand" style="padding:0 0 0 14px;color:${WHITE};font-family:${SANS};font-size:15px;line-height:20px;font-weight:normal;letter-spacing:1.5px;text-transform:uppercase;white-space:nowrap;">${escapeHtml(business.name)}</td></tr>`,
          '',
        ) +
        '</td>' +
        `<td class="e-stay" align="right" valign="middle" style="padding:0 0 0 16px;color:${CREAM};font-family:${SANS};font-size:13px;line-height:20px;text-align:right;white-space:nowrap;">${escapeHtml(stay)}</td>` +
        '</tr>',
    ) +
    '</td></tr>';

  const body = [
    `<tr><td class="e-px" style="padding:36px ${PAD}px 8px;">`,
    `<h1 class="e-text e-h1" style="margin:0 0 10px;font-family:${SERIF};font-weight:normal;font-size:28px;line-height:34px;color:${GREEN};">${escapeHtml(texts.heading)}</h1>`,
    // Úvod: první odstavec (poděkování, splatnost, instrukce, kontakt) plnou barvou, uvedení
    // souhrnu tlumeně.
    ...texts.intro.map((paragraph, i, all) =>
      `<p class="${i === 0 ? 'e-text' : 'e-muted'}" style="margin:0 0 ${i === all.length - 1 ? 28 : 12}px;font-size:15px;line-height:23px;color:${i === 0 ? GREEN : MUTED};">${escapeHtml(paragraph)}</p>`,
    ),
    // Souhrn; celková cena jen tučněji, o stupeň větší a s výraznější linkou nad sebou.
    table(
      summary.map((item, i) => row(item, i === 0)).join('') +
        `<tr><td class="e-text e-total" style="padding:14px 0 0;border-top:1px solid ${GREEN};color:${GREEN};font-size:16px;line-height:22px;font-weight:bold;">${escapeHtml(total[0])}</td>` +
        `<td class="e-text e-total" align="right" style="padding:14px 0 0 24px;border-top:1px solid ${GREEN};color:${GREEN};font-size:16px;line-height:22px;font-weight:bold;text-align:right;white-space:nowrap;">${escapeHtml(total[1])}</td></tr>`,
    ),
    // Platba: nadpis → QR → ruční údaje (splatnost je v úvodu a souhrnu, VS v údajích).
    `<h2 class="e-text" style="margin:44px 0 20px;font-family:${SERIF};font-weight:normal;font-size:21px;line-height:28px;color:${GREEN};">${escapeHtml(paymentHeading)}</h2>`,
    matrix
      ? `<p style="margin:0 0 22px;text-align:center;"><img src="cid:${QR_CONTENT_ID}" width="180" height="180" alt="${escapeHtml(i18n.t('email.qrAlt'))}" style="display:inline-block;width:180px;height:180px;border:0;"></p>`
      : '',
    // Účet a IBAN v jednom kuse (opisují se), popisky se případně zalomí.
    table(payment.map((item, i) => row(item, i === 0, i === 1 || i === 2)).join('')),
    `<p class="e-text" style="margin:40px 0 0;font-family:${SERIF};font-size:18px;line-height:26px;color:${GREEN};text-align:center;">${escapeHtml(thanks)}</p>`,
    '</td></tr>',
    // Telefonický kontakt: plné tlačítko se sluchátkem. Světlá ikona je výchozí; tmavá se
    // zobrazí jen tam, kde klient použije tmavý režim z <style> (tlačítko pak krémové).
    `<tr><td class="e-px" align="center" style="padding:32px ${PAD}px 36px;text-align:center;">`,
    `<div class="e-line" style="border-top:1px solid ${BORDER};padding-top:32px;">`,
    `<p class="e-text" style="margin:0 0 4px;font-family:${SERIF};font-size:18px;line-height:25px;color:${GREEN};">${escapeHtml(cta.heading)}</p>`,
    `<p class="e-muted" style="margin:0 0 18px;font-size:14px;line-height:21px;color:${MUTED};">${escapeHtml(cta.text)}</p>`,
    table(
      `<tr><td class="e-btn" align="center" bgcolor="${GREEN}" style="background-color:${GREEN};border-radius:6px;">` +
        `<a href="${escapeHtml(business.phone.href)}" style="display:inline-block;padding:13px 26px;border-radius:6px;color:${WHITE};font-family:${SANS};font-size:15px;line-height:20px;font-weight:bold;text-decoration:none;white-space:nowrap;">` +
        `<img class="e-ico" src="cid:${PHONE_ICON_CONTENT_ID}" width="18" height="18" alt="" style="display:inline-block;width:18px;height:18px;border:0;vertical-align:middle;">` +
        `<img class="e-ico-dark" src="cid:${PHONE_ICON_DARK_CONTENT_ID}" width="18" height="18" alt="" style="display:none;width:0;height:0;max-height:0;border:0;vertical-align:middle;mso-hide:all;">` +
        `<span style="color:${WHITE};vertical-align:middle;padding-left:10px;">${escapeHtml(cta.call)}</span></a></td></tr>`,
      'align="center"',
      'margin:0 auto;',
    ),
    '</div>',
    '</td></tr>',
  ].join('');

  // Patička: řádky položek oddělených tečkou (na mobilu pod sebou). Další řádek (např. odkaz
  // na ubytovací řád) se přidá jako další pole položek – bez změny layoutu. Odkazy jen na
  // vlastní web a info e-mail; IČ je prostý text.
  const footerRows: string[][] = [[link(business.websiteUrl, business.name), link(`mailto:${business.emailInfo}`, business.emailInfo), escapeHtml(ico)]];
  const footer =
    `<tr><td class="e-foot e-muted" align="center" style="padding:28px 16px 0;color:${MUTED};font-family:${SANS};font-size:13px;line-height:22px;text-align:center;">` +
    footerRows
      .map((items) => `<p style="margin:0;">${items.map((item) => `<span class="e-item" style="white-space:nowrap;">${item}</span>`).join(' <span class="e-sep" aria-hidden="true" style="padding:0 6px;">·</span> ')}</p>`)
      .join('') +
    '</td></tr>';

  const html = [
    '<!doctype html>',
    `<html lang="${locale === 'ua' ? 'uk' : locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">',
    '<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">',
    `<title>${escapeHtml(texts.subject)}</title>${STYLES}</head>`,
    `<body class="e-page" style="margin:0;padding:0;background-color:${PAGE};font-family:${SANS};color:${GREEN};">`,
    `<table class="e-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PAGE}" style="background-color:${PAGE};"><tr><td class="e-outer" align="center" style="padding:32px 16px 40px;">`,
    // Outlook (Windows) nezná max-width: pevná šířka přes podmíněnou tabulku.
    `<!--[if mso]><table role="presentation" width="${WIDTH}" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->`,
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:${WIDTH}px;font-family:${SANS};">`,
    `<tr><td class="e-card" bgcolor="${WHITE}" style="background-color:${WHITE};border:1px solid ${BORDER};">`,
    table(header + body),
    '</td></tr>',
    footer,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table>',
    '</body></html>',
  ].join('');

  const textLines = [
    `${business.name} · ${stay}`,
    '',
    texts.heading,
    '',
    ...texts.intro.flatMap((paragraph) => [paragraph, '']),
    ...[...summary, total].map(([label, value]) => `${label}: ${value}`),
    '',
    paymentHeading,
    ...payment.map(([label, value]) => `${label}: ${value}`),
    '',
    thanks,
    '',
    cta.heading,
    cta.text,
    cta.call,
    '',
    '--',
    ...[[business.name, business.emailInfo, ico]].map((items) => items.join(' · ')),
  ];

  return { subject: texts.subject, html, text: textLines.join('\n'), attachments };
}

/** Potvrzení přijetí rezervace (texty v jazyce hosta). */
export function renderConfirmationEmail(data: ReservationResponse, locale: Locale, options: EmailOptions = {}): RenderedEmail {
  const i18n = createI18n(locale);
  const subject = `${options.test ? '[TEST] ' : ''}${i18n.t('email.confirmation.subject', { code: data.reservation.reservationCode })}`;
  const intro = [i18n.t('email.confirmation.intro', { date: i18n.formatDeadlineDate(data.payment.dueAt) }), i18n.t('email.confirmation.summaryLead')];
  return renderReservationEmail(data, locale, { subject, heading: i18n.t('reservation.success.title'), intro }, options);
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
async function sendConfirmationFailureAlert(
  env: ConfirmationEnv,
  apiKey: string,
  reservation: { id: string; code: string },
  kind: string,
  deps: ConfirmationDeps & { now: () => Date },
): Promise<void> {
  const to = env.CONFLICT_ALERT_EMAIL?.trim();
  if (!to) {
    deps.log('reservations: confirmation failure alert skipped (not configured)');
    return;
  }
  const bookingEnv = env.BOOKING_ENV ?? 'unknown';
  const { subject, text } = buildConfirmationFailureAlert({ reservationCode: reservation.code, env: bookingEnv, kind, failedAt: deps.now() });
  try {
    await sendViaResend(
      apiKey,
      { from: env.CONFLICT_ALERT_FROM?.trim() || RESEND_TEST_FROM, to, subject, text, idempotencyKey: `confirmation-failure-alert-${bookingEnv}-${reservation.id}` },
      deps.fetch,
    );
    deps.log('reservations: confirmation failure alert sent');
  } catch (error) {
    deps.log(`reservations: confirmation failure alert failed (${error instanceof MailError ? error.kind : 'unknown'})`);
  }
}

/** Údaje jen pro server (nikdy v API, e-mailu ani logu): identita rezervace a uložený kontakt hosta. */
export interface ConfirmationTarget {
  /** Interní `reservations.id` (UUID) – klíč idempotence u Resend. Veřejný kód se může po
   *  úklidu Preview DB opakovat, UUID ne. */
  reservationId: string;
  /** E-mail a jazyk uložené u rezervace (při replay z DB, ne z opakovaného požadavku). */
  guestEmail: string;
  locale: Locale;
}

/** Klíč idempotence potvrzení u Resend – stejný pro první pokus i replay téže rezervace. */
export const confirmationIdempotencyKey = (env: ConfirmationEnv, reservationId: string) =>
  `reservation-confirmation-${env.BOOKING_ENV ?? 'unknown'}-${reservationId}`;

/**
 * Odešle potvrzení rezervace (nové i replay). Nikdy nevyhazuje (best-effort); vrací výsledek
 * jen pro testy a logy. Klíč idempotence z interního UUID rezervace: replay po ztracené
 * odpovědi použije stejný klíč, takže Resend už přijatý e-mail nezdvojí a nepřijatý doručí.
 * Pořadí kontrol konfigurace: RESEND_API_KEY → příjemce (každá chybějící = skipped).
 */
export async function sendReservationConfirmation(
  env: ConfirmationEnv,
  data: ReservationResponse,
  target: ConfirmationTarget,
  deps: ConfirmationDeps & { now: () => Date },
): Promise<'sent' | 'skipped' | 'failed'> {
  // Nic (ani render) neběží synchronně v handleru: práce začne až po předání Promise do
  // ctx.waitUntil, odpověď API na ni nečeká.
  await Promise.resolve();
  const apiKey = env.RESEND_API_KEY?.trim();
  try {
    if (!apiKey) {
      deps.log('reservations: confirmation email skipped (not configured)');
      return 'skipped';
    }
    const recipient = confirmationRecipient(env, target.guestEmail);
    if (!recipient) {
      deps.log('reservations: confirmation email skipped (no test recipient)');
      return 'skipped';
    }
    const business = businessIdentity();
    const email = renderConfirmationEmail(data, target.locale, {
      business,
      test: recipient.test,
    });
    const message: MailMessage = {
      from: confirmationSender(business),
      to: recipient.to,
      ...email,
      idempotencyKey: confirmationIdempotencyKey(env, target.reservationId),
    };
    await sendViaResend(apiKey, message, deps.fetch);
    deps.log('reservations: confirmation email sent');
    return 'sent';
  } catch (error) {
    const kind = error instanceof MailError ? error.kind : 'unknown';
    deps.log(`reservations: confirmation email failed (${kind})`);
    // Jen selhání doručení přes providera (timeout, síť, HTTP) – ne chyba v kódu ani konfiguraci.
    if (error instanceof MailError && apiKey) {
      await sendConfirmationFailureAlert(env, apiKey, { id: target.reservationId, code: data.reservation.reservationCode }, kind, deps);
    }
    return 'failed';
  }
}
