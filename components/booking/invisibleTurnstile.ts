// Cloudflare Turnstile v režimu Invisible: token se získává až při odeslání rezervace.
//
// - Režim widgetu (Managed / Non-Interactive / Invisible) určuje site key v Cloudflare dashboardu.
//   Pro Invisible site key se nic nezobrazuje a widget nezabírá místo; `appearance:
//   'interaction-only'` je jen pojistka pro případ chybně nastaveného (viditelného) klíče.
// - Widget se připraví předem (`prepare`: `render` s `execution: 'execute'` – načte iframe, ale
//   challenge nespustí), takže po kliknutí zbývá jen `execute`. Každý widget vydá nejvýš jeden
//   token: po tokenu nebo chybě se odstraní a na pozadí se připraví čerstvý pro další odeslání.
//   Token je jednorázový a nikdy se nepoužije pro jinou logickou operaci; callbacky starých
//   widgetů se ignorují.
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
  /** Připraví widget předem (načtení skriptu a iframe), aby po kliknutí zbývalo jen execute. */
  prepare: () => Promise<void>;
  getToken: () => Promise<string>;
  dispose: () => void;
}

type Outcome = { token: string } | { error: TurnstileFailure };

export function createInvisibleTurnstile(options: InvisibleTurnstileOptions): TokenSource {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let api: TurnstileApi | null = null;
  /** Připravený (dosud nespuštěný) widget, nebo widget s rozběhnutou challenge. */
  let widget: { id: string; used: boolean } | null = null;
  let preparing: Promise<void> | null = null;
  let disposed = false;
  /** Rozběhnutá challenge: výsledek patří jen widgetu, který ji spustil. */
  let active: { widgetId: string; settle: (outcome: Outcome) => void } | null = null;

  const removeWidget = () => {
    if (api && widget) {
      try {
        api.remove(widget.id);
      } catch {
        // Widget už neexistuje (např. odpojený kontejner) – nic dalšího není potřeba.
      }
    }
    widget = null;
  };
  const deliver = (widgetId: string, outcome: Outcome) => {
    if (active && active.widgetId === widgetId) active.settle(outcome);
  };

  const render = async () => {
    try {
      api = await options.load();
    } catch {
      throw new TurnstileError('turnstile-unavailable');
    }
    const container = options.container();
    if (disposed || !container) throw new TurnstileError('turnstile-unavailable');
    removeWidget();
    let id = '';
    try {
      id =
        api.render(container, {
          sitekey: options.siteKey,
          action: TURNSTILE_ACTION,
          language: options.language(),
          execution: 'execute',
          appearance: 'interaction-only',
          'refresh-expired': 'never',
          retry: 'never',
          callback: (token: unknown) => deliver(id, typeof token === 'string' && token !== '' ? { token } : { error: 'turnstile-failed' }),
          'error-callback': () => {
            deliver(id, { error: 'turnstile-failed' });
            return true; // chyba je ošetřená, Turnstile ji nemá dál hlásit
          },
          'timeout-callback': () => deliver(id, { error: 'turnstile-failed' }),
          'unsupported-callback': () => deliver(id, { error: 'turnstile-failed' }),
          // Token se používá hned po získání; vypršení řeší server (Siteverify) – nic se neobnovuje.
          'expired-callback': () => undefined,
        }) ?? '';
    } catch {
      throw new TurnstileError('turnstile-unavailable');
    }
    if (!id) throw new TurnstileError('turnstile-unavailable');
    widget = { id, used: false };
  };

  /** Čerstvý nespuštěný widget (souběžná volání sdílí jednu přípravu). */
  const prepare = (): Promise<void> => {
    if (disposed) return Promise.reject(new TurnstileError('turnstile-unavailable'));
    if (widget && !widget.used) return Promise.resolve();
    preparing ??= render().finally(() => (preparing = null));
    return preparing;
  };
  /** Po tokenu nebo chybě: použitý widget pryč a na pozadí nový pro další odeslání. */
  const recycle = () => {
    removeWidget();
    if (!disposed) prepare().catch(() => undefined);
  };

  return {
    prepare,
    dispose: () => {
      disposed = true;
      active?.settle({ error: 'turnstile-unavailable' });
      removeWidget();
    },
    getToken: async () => {
      active?.settle({ error: 'turnstile-unavailable' });
      await prepare();
      if (disposed || !api || !widget || widget.used) throw new TurnstileError(disposed ? 'turnstile-unavailable' : 'turnstile-failed');
      const turnstile = api;
      const current = widget;
      const container = options.container();
      if (!container) throw new TurnstileError('turnstile-unavailable');
      current.used = true;
      return new Promise<string>((resolve, reject) => {
        let settled = false;
        const settle = (outcome: Outcome) => {
          if (settled) return;
          settled = true;
          clearTimer(timer);
          if (active?.settle === settle) active = null;
          if (widget === current) recycle();
          if ('token' in outcome) resolve(outcome.token);
          else reject(new TurnstileError(outcome.error));
        };
        const timer = setTimer(() => settle({ error: 'turnstile-failed' }), options.timeoutMs ?? TOKEN_TIMEOUT_MS);
        active = { widgetId: current.id, settle };
        try {
          turnstile.execute(container);
        } catch {
          settle({ error: 'turnstile-unavailable' });
        }
      });
    },
  };
}
