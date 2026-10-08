// CLI: kontrola a ruční aplikace D1 migrací.
//
//   node scripts/d1-migrations.ts check production|preview   – jen čtení, exit 1 při čekajících migracích
//   node scripts/d1-migrations.ts apply production|preview   – ruční aplikace s potvrzením (ne v CI)
//
// Viz README, sekce „Nasazení a migrace D1“.

import { spawn } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { TARGETS, type TargetName } from './lib/d1-migrations.ts';
import { applyTarget, checkTarget, type WorkflowDeps } from './lib/d1-workflow.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Lokální wrangler z node_modules (balíček exportuje jen package.json, ne bin/).
const wranglerBin = join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

const deps: WorkflowDeps = {
  root,
  wrangler: (args, { interactive }) =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [wranglerBin, ...args], { cwd: root, stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'inherit'] });
      let stdout = '';
      child.stdout?.on('data', (chunk) => (stdout += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    }),
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) && !process.env.CI && !process.env.WORKERS_CI,
  prompt: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  fileSize: (path) => {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  now: () => new Date(),
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

const [command, targetName] = process.argv.slice(2);
const target = TARGETS[targetName as TargetName];
if ((command !== 'check' && command !== 'apply') || !target) {
  console.error('Použití: node scripts/d1-migrations.ts <check|apply> <production|preview>');
  process.exit(2);
}
if (command === 'check') process.exit((await checkTarget(target, deps)).ok ? 0 : 1);
process.exit(await applyTarget(target, deps));
