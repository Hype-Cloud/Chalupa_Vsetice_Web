// CLI záloh D1 (GitHub Releases i Cloudflare R2): výpis, stažení, ověření, rozšifrování,
// obnova do nové D1 a ruční / plánovaný běh zálohy. Popis: README, „Automatické zálohy D1“.
//
//   node scripts/backup.ts list --backend github
//   node scripts/backup.ts download --backend github --snapshot latest [--output <adresář>]
//   node scripts/backup.ts verify --file <soubor> [--identity <klíč>]
//   node scripts/backup.ts decrypt --file <soubor> --identity <klíč>
//   node scripts/backup.ts restore --backend github --snapshot latest --target <nová-db> --identity <klíč>
//   node scripts/backup.ts run --backend github        (GitHub Actions)
//
// Konfigurace z proměnných prostředí (BACKUP_*), volitelně --env-file <soubor> (mimo repozitář).

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runCli, type CliDeps } from './lib/backup-cli.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Wrangler jen pro obnovu a R2 (v GitHub Actions se nepoužívá).
const wranglerBin = () => join(dirname(createRequire(import.meta.url).resolve('wrangler/package.json')), 'bin', 'wrangler.js');

// --env-file <soubor>: načte proměnné (process.loadEnvFile); existující proměnné nepřepisuje.
const argv: string[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--env-file' || args[i].startsWith('--env-file=')) {
    const path = args[i].includes('=') ? args[i].slice(args[i].indexOf('=') + 1) : args[++i];
    try {
      process.loadEnvFile(path);
    } catch {
      console.error('Chyba: --env-file nejde načíst');
      process.exit(2);
    }
  } else argv.push(args[i]);
}

const deps: CliDeps = {
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (message) => console.error(message),
  out: (message) => console.log(message),
  now: () => new Date(),
  repoRoot: root,
  home: homedir(),
  tmpdir: tmpdir(),
  isIgnored: (path) => spawnSync('git', ['check-ignore', '-q', '--no-index', path], { cwd: root }).status === 0,
  prompt:
    process.stdin.isTTY && process.stdout.isTTY
      ? async (question) => {
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        }
      : null,
  wrangler: (wargs, { cwd, env }) =>
    new Promise((resolve, reject) => {
      // stdin zavřený: wrangler se na nic neptá; stdout se čte (JSON).
      // stderr se odvede do prázdna: chyby Wrangleru mohou obsahovat fragmenty SQL/PII.
      // Naše CLI vrací pouze bezpečný generický druh chyby a kód ukončení.
      const child = spawn(process.execPath, [wranglerBin(), ...wargs], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stderr.resume(); // never collect or log potentially sensitive SQL
      let stdout = '';
      child.stdout.on('data', (chunk) => (stdout += chunk));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? 1, stdout }));
    }),
};

process.exitCode = await runCli(argv, deps);
