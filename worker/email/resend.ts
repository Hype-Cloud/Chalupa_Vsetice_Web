// Odeslání e-mailu přes Resend HTTP API – sdílené pro interní upozornění (booking/alerts.ts)
// i potvrzení rezervace (booking/confirmation.ts). Bez business logiky; chyby bez obsahu odpovědi
// providera (může obsahovat adresy nebo text zprávy) a bez obsahu zprávy.

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';
/** Testovací odesílatel Resend – doručí jen na e-mail účtu Resend. */
export const RESEND_TEST_FROM = 'Chalupa Všetice <onboarding@resend.dev>';
const SEND_TIMEOUT_MS = 10_000;

export interface MailAttachment {
  filename: string;
  /** Obsah v base64. */
  content: string;
  /** Inline příloha pro `<img src="cid:…">`. */
  contentId?: string;
}

export interface MailMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: MailAttachment[];
  /** Resend Idempotency-Key: stejný klíč do 24 h = e-mail se nepošle podruhé. */
  idempotencyKey: string;
}

export class MailError extends Error {
  readonly kind: string;
  constructor(kind: string) {
    super(kind);
    this.kind = kind;
  }
}

/** Jeden e-mail přes Resend HTTP API. @throws MailError (jen druh chyby: timeout, network, http-NNN) */
export async function sendViaResend(apiKey: string, message: MailMessage, fetchFn: typeof fetch): Promise<void> {
  const body: Record<string, unknown> = { from: message.from, to: [message.to], subject: message.subject, text: message.text };
  if (message.html) body.html = message.html;
  if (message.attachments?.length) {
    body.attachments = message.attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.contentId ? { content_id: a.contentId } : {}) }));
  }
  let response: Response;
  try {
    response = await fetchFn(RESEND_ENDPOINT, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': message.idempotencyKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (error) {
    throw new MailError(error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'network');
  }
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new MailError(`http-${response.status}`);
}
