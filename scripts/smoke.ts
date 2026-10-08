// CLI: smoke test veřejných endpointů po nasazení (bez tokenů a bez zápisu).
//
//   node scripts/smoke.ts https://chalupavsetice.cz --env production
//   node scripts/smoke.ts https://<preview-url> --env preview
//
// Viz README, sekce „Nasazení a migrace D1“.

import { formatSmoke, parseBaseUrl, runSmoke, type SmokeEnv } from './lib/smoke.ts';

const args = process.argv.slice(2);
const envIndex = args.indexOf('--env');
const env = envIndex === -1 ? 'production' : args[envIndex + 1];
const positional = args.filter((a, i) => !a.startsWith('--') && (envIndex === -1 || i !== envIndex + 1));
const url = positional.length === 1 ? positional[0] : undefined;
if (!url || (env !== 'production' && env !== 'preview')) {
  console.error('Použití: node scripts/smoke.ts <https://origin> [--env production|preview]');
  process.exit(2);
}
let base: URL;
try {
  base = parseBaseUrl(url);
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
console.log(`Smoke test ${base.origin} (${env})`);
const { text, ok } = formatSmoke(await runSmoke(base, env as SmokeEnv, (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(15_000) })));
console.log(text);
process.exit(ok ? 0 : 1);
