// Samostatný Worker `chalupa-vsetice-d1-backup` (wrangler.backup.jsonc): jen Workflow
// automatické zálohy D1 → R2 spouštěný přes `workflows[].schedules`. Žádné veřejné HTTP
// rozhraní (workers.dev i Preview URL vypnuté, fetch vrací 404). Logika: workflow.ts, backup.ts.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { workersStreams } from './backup.ts';
import { runBackupWorkflow, type BackupEnv, type BackupEvent, type BackupParams } from './workflow.ts';

export class D1BackupWorkflow extends WorkflowEntrypoint<BackupEnv, BackupParams> {
  async run(event: Readonly<WorkflowEvent<BackupParams>>, step: WorkflowStep) {
    return runBackupWorkflow(event as BackupEvent, step, this.env, {
      fetch: (input, init) => fetch(input, init),
      bucket: this.env.BACKUPS,
      streams: workersStreams,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: () => new Date(),
      log: (message) => console.log(message),
    });
  }
}

export default {
  fetch: () => new Response(null, { status: 404 }),
} satisfies ExportedHandler<BackupEnv>;
