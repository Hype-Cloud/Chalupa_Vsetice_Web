// Cloudflare Turnstile v režimu Invisible: token se získává až při odeslání rezervace.
//
// - Režim widgetu (Managed / Non-Interactive / Invisible) určuje site key v Cloudflare dashboardu.
//   Pro Invisible site key se nic nezobrazuje a widget nezabírá místo; `appearance:
//   'interaction-only'` je jen pojistka pro případ chybně nastaveného (viditelného) klíče.
// - Každý požadavek na token = čerstvý widget (`remove` → `render` s `execution: 'execute'` →
//   `execute`). Token je jednorázový a nikdy se nepoužije pro jinou logickou operaci; pozdní
//   callbacky starého widgetu se ignorují.
// - Token se po vypršení sám neobnovuje (`refresh-expired: 'never'`) ani se challenge sám
//   neopakuje (`retry: 'never'`) – nový token vznikne jen na vyžádání (nové odeslání).
// - Selhání: nenačtený skript / chybějící kontejner = `turnstile-unavailable`; neúspěšná nebo
//   nedokončená challenge (chyba, timeout, nepodporovaný prohlížeč) = `turnstile-failed`.

export interface TurnstileApi {
  render: (container: HTMLElement, options: Record<string, unknown>) => string | null | undefined;
  execute: (container: HTMLElement | string, options?: Record<string, unknown>) => void;
  remove: (widgetId: string) => void;
}

export type TurnstileFailure = 'turnstile-unavailable' | 'turnstile-failed';

export class TurnstileError extends Error {
  readonly code: TurnstileFailure;
  constructor(code: TurnstileFailure) {
    super(code);
    this.code = code;
  }
}

/** Akce widgetu (vrací ji Siteverify; max. 32 znaků, jen písmena, číslice, `_` a `-`). */
export const TURNSTILE_ACTION = 'reservation';
/** Nejdelší čekání na token; Invisible challenge obvykle trvá jednotky sekund. */
export const TOKEN_TIMEOUT_MS = 30_000;

export interface InvisibleTurnstileOptions {
  load: () => Promise<TurnstileApi>;
  container: () => HTMLElement | null;
  siteKey: string;
  /** Jazyk pro případ, že by se widget musel zobrazit (pojistka u chybně nastaveného klíče). */
  language: () => string;
  timeoutMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Zdroj jednorázových tokenů; každé volání getToken() spustí novou challenge. */
export interface TokenSource {
  getToken: () => Promise<string>;
  dispose: () => void;
}

export function createInvisibleTurnstile(options: InvisibleTurnstileOptions): TokenSource {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let api: TurnstileApi | null = null;
  let widget: string | null = null;
  let disposed = false;
  /** Pořadí požadavků – callback starší challenge se nikdy nepřiřadí novějšímu požadavku. */
  let current = 0;
  /** Ukončení rozběhnuté challenge (nový požadavek nebo odpojení formuláře). */
  let abortActive: (() => void) | null = null;

  const removeWidget = () => {
    if (api && widget) {
      try {
        api.remove(widget);
      } catch {
        // Widget už neexistuje (např. odpojený kontejner) – nic dalšího není potřeba.
      }
    }
    widget = null;
  };

  return {
    dispose: () => {
      disposed = true;
      current++;
      abortActive?.();
      removeWidget();
    },
    getToken: async () => {
      abortActive?.();
      const request = ++current;
      try {
        api = await options.load();
      } catch {
        throw new TurnstileError('turnstile-unavailable');
      }
      const container = options.container();
      if (disposed || request !== current || !container) throw new TurnstileError(disposed || !container ? 'turnstile-unavailable' : 'turnstile-failed');
      removeWidget();
      const turnstile = api;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (outcome: { token: string } | { error: TurnstileFailure }) => {
          if (settled) return;
          settled = true;
          abortActive = null;
          clearTimer(timer);
          if ('token' in outcome) resolve(outcome.token);
          else {
            removeWidget();
            reject(new TurnstileError(outcome.error));
          }
        };
        const timer = setTimer(() => settle({ error: 'turnstile-failed' }), options.timeoutMs ?? TOKEN_TIMEOUT_MS);
        abortActive = () => settle({ error: 'turnstile-unavailable' });
        try {
          widget =
            turnstile.render(container, {
              sitekey: options.siteKey,
              action: TURNSTILE_ACTION,
              language: options.language(),
              execution: 'execute',
              appearance: 'interaction-only',
              'refresh-expired': 'never',
              retry: 'never',
              callback: (token: unknown) => settle(typeof token === 'string' && token !== '' ? { token } : { error: 'turnstile-failed' }),
              'error-callback': () => {
                settle({ error: 'turnstile-failed' });
                return true; // chyba je ošetřená, Turnstile ji nemá dál hlásit
              },
              'timeout-callback': () => settle({ error: 'turnstile-failed' }),
              'unsupported-callback': () => settle({ error: 'turnstile-failed' }),
              // Token se používá hned po získání; vypršení řeší server (Siteverify) – nic se neobnovuje.
              'expired-callback': () => undefined,
            }) ?? null;
          turnstile.execute(container);
        } catch {
          settle({ error: 'turnstile-unavailable' });
        }
      });
    },
  };
}
