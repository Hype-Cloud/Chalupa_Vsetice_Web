/** Prostředí pro kopírování (v testech podvržené). */
export interface ClipboardEnv {
  clipboard?: { writeText(text: string): Promise<void> };
  document?: Pick<Document, 'createElement' | 'body' | 'execCommand'>;
}

/**
 * Zkopíruje přesnou hodnotu do schránky: Clipboard API, jinak záložně skrytý textarea
 * a `execCommand('copy')` (starší prohlížeče, nezabezpečený kontext). Nikdy nevyhazuje.
 */
export async function copyText(text: string, env: ClipboardEnv = { clipboard: globalThis.navigator?.clipboard, document: globalThis.document }): Promise<boolean> {
  try {
    if (env.clipboard) {
      await env.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Zkusit záložní cestu.
  }
  const doc = env.document;
  if (!doc?.body) return false;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  area.style.top = '0';
  doc.body.appendChild(area);
  try {
    area.select();
    return doc.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
  }
}
