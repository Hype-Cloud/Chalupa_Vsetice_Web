// Testovací Worker pro tests/backup.test.ts: spouští runBackupWorkflow ve workerd (Miniflare)
// se skutečným R2, DigestStream a FixedLengthStream. Odchozí fetch (D1 API, podepsaná URL,
// Resend) obsluhuje falešná služba v testu. Kroky Workflow simuluje jednoduchý `step.do`
// s opakováním podle `retries.limit` (bez čekání).

import { copySnapshot, workersStreams } from '../../worker/backup/backup.ts';
import { runBackupWorkflow, type BackupEnv, type BackupEvent, type BackupStep } from '../../worker/backup/workflow.ts';

interface HarnessInput {
  event: { instanceId: string; timestamp: string; payload?: { mode?: 'backup' | 'monitor' | 'alert-test' }; schedule?: { cron: string; scheduledTime: string } };
  env?: Partial<Record<keyof Omit<BackupEnv, 'BACKUPS'>, string>>;
  now?: string;
}

export default {
  async fetch(request: Request, env: BackupEnv): Promise<Response> {
    // Souběžné povýšení různých zdrojů do stejného snapshotu (test podmíněného zápisu R2).
    if (new URL(request.url).pathname === '/copy-race') {
      const { sources, target, policy } = (await request.json()) as { sources: { key: string; bytes: number; md5: string }[]; target: string; policy: 'verify' | 'keep' };
      const metadata = { database: 'test', environment: 'production', bookmark: '', createdAt: '2030-01-15T02:15:00.000Z', migrations: 0 };
      const results = await Promise.allSettled(sources.map((s) => copySnapshot(env.BACKUPS, s.key, target, s, metadata, policy)));
      return Response.json(results.map((r) => (r.status === 'fulfilled' ? r.value : `error:${(r.reason as { kind?: string }).kind ?? String(r.reason)}`)));
    }
    const input = (await request.json()) as HarnessInput;
    const steps: { name: string; attempts: number; ok: boolean }[] = [];
    const logs: string[] = [];
    const step: BackupStep = {
      async do(name, config, callback) {
        const limit = config.retries?.limit ?? 0;
        let attempts = 0;
        for (;;) {
          attempts++;
          try {
            const value = await callback();
            steps.push({ name, attempts, ok: true });
            // Výsledek kroku musí jít serializovat (stav Workflow).
            return JSON.parse(JSON.stringify(value ?? null));
          } catch (error) {
            if (attempts > limit) {
              steps.push({ name, attempts, ok: false });
              throw error;
            }
          }
        }
      },
    };
    const event: BackupEvent = {
      instanceId: input.event.instanceId,
      timestamp: new Date(input.event.timestamp),
      payload: input.event.payload,
      schedule: input.event.schedule,
    };
    const now = input.now ? new Date(input.now) : null;
    try {
      const result = await runBackupWorkflow(event, step, { ...env, ...input.env } as BackupEnv, {
        fetch: (url, init) => fetch(url, init),
        bucket: env.BACKUPS,
        streams: workersStreams,
        sleep: async () => undefined,
        now: () => now ?? new Date(),
        log: (message) => logs.push(message),
      });
      return Response.json({ ok: true, result, steps, logs });
    } catch (error) {
      return Response.json({ ok: false, error: (error as { kind?: string }).kind ?? String(error), steps, logs });
    }
  },
} satisfies ExportedHandler<BackupEnv>;
