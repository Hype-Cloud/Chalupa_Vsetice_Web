// Nezávislá kontrola záloh v GitHub Releases (Cloudflare Cron Trigger).
//
// Běží mimo GitHub Actions: upozorní i tehdy, když zálohovací workflow vůbec neproběhne
// (zakázaný rozvrh, chybějící secrets, výpadek Actions, vyčerpaná kvóta). Kontroluje stáří
// poslední denní zálohy (> 48 h), manifest a GitHub SHA-256 digest assetu.
 // Velké age assety nestahuje ani nemaže; toto není náhrada úplného restore-testu. Žádné veřejné HTTP rozhraní (fetch → 404).

import { runGithubMonitor, type GithubEnv } from '../../lib/backup/github-run.ts';

export default {
  async fetch(): Promise<Response> {
    return new Response('Not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: GithubEnv): Promise<void> {
    await runGithubMonitor(env, {
      fetch: (input, init) => fetch(input, init),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (message) => console.log(message),
      now: () => new Date(),
    }).then(
      (result) => console.log(`d1-backup-monitor: ok (${result.status?.latest?.id ?? 'žádná záloha'}, stale=${result.status?.stale})`),
      (error: unknown) => {
        console.log(`d1-backup-monitor: failed (${error instanceof Error ? error.message : 'unknown'})`);
        throw error;
      },
    );
  },
};
