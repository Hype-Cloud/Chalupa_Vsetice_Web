// Cron Trigger (wrangler.jsonc → triggers.crons): detekce kolizí nezávislá na návštěvě webu.
//
// 1. Ověří prostředí D1 (meta.environment = BOOKING_ENV); jinak nic nedělá.
// 2. Stáhne čerstvý export e-chalup (stejná funkce a parser jako GET /api/availability)
//    a spustí reconcileConflicts(). Selhání exportu nic neuzavírá; neúplný export kolize jen přidává.
// 3. Odešle čekající upozornění správci (processPendingAlerts) – i když export právě selhal,
//    protože čekající kolize jsou dříve zjištěné a stále trvají.
// Nic se automaticky neruší. Chyba Cronu neovlivní veřejný kalendář ani rezervace.

import { fetchFreshExternalSnapshot, UpstreamError } from '../availability.ts';
import { processPendingAlerts, type AlertEnv } from './alerts.ts';
import { reconcileConflicts } from './conflicts.ts';
import { databaseEnvironment } from './db.ts';

export interface CronEnv extends AlertEnv {
  DB?: D1Database;
  ECHALUPY_ICAL_URL?: string;
}

export interface CronDeps {
  fetch: typeof fetch;
  now: () => Date;
  log: (message: string) => void;
}

export async function runScheduledConflictCheck(env: CronEnv, deps: CronDeps): Promise<void> {
  const db = env.DB;
  if (!db || !env.BOOKING_ENV) {
    deps.log('conflicts-cron: not configured');
    return;
  }
  try {
    if ((await databaseEnvironment(db)) !== env.BOOKING_ENV) {
      deps.log('conflicts-cron: database environment mismatch');
      return;
    }
  } catch {
    deps.log('conflicts-cron: database unavailable');
    return;
  }

  const now = deps.now();
  const url = env.ECHALUPY_ICAL_URL?.trim();
  if (!url) {
    deps.log('conflicts-cron: export not configured');
  } else {
    try {
      const snapshot = await fetchFreshExternalSnapshot(url, now, deps);
      if (snapshot.skipped > 0) deps.log('conflicts-cron: incomplete snapshot');
      const result = await reconcileConflicts(db, { events: snapshot.events, range: snapshot.range, complete: snapshot.skipped === 0 }, now);
      if (result.newConflicts.length > 0 || result.active > 0) deps.log(`conflicts-cron: ${result.newConflicts.length} new, ${result.active} active`);
    } catch (error) {
      // Žádné uzavírání kolizí; do logu jen druh chyby, nikdy URL exportu.
      deps.log(error instanceof UpstreamError ? `conflicts-cron: upstream unavailable (${error.kind})` : 'conflicts-cron: reconciliation failed');
    }
  }

  try {
    await processPendingAlerts(db, env, deps, now);
  } catch {
    deps.log('conflicts-mail: processing failed');
  }
}
