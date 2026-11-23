#!/usr/bin/env bash
# TypeScript kontrola s přesnou baseline: projde jen bez chyb, nebo s jedinou známou diagnostikou
# shodnou s `main` (vite.config.ts – typ `configPath: false` pluginu @cloudflare/vite-plugin;
# runtime hodnotu nelze změnit bez dopadu na build). Jakákoli jiná nebo další diagnostika = chyba.
set -uo pipefail
cd "$(dirname "$0")/.."
BASELINE="vite.config.ts(4,60): error TS2322: Type 'boolean' is not assignable to type 'string'."
output="$(pnpm exec tsc --noEmit --pretty false 2>&1)"
code=$?
if [ "$code" -eq 0 ]; then
  echo "TypeScript: bez chyb."
  exit 0
fi
if [ "$output" = "$BASELINE" ]; then
  # Bez formátu diagnostiky tsc, aby z úspěchu nevznikla chybová anotace v CI.
  echo "TypeScript: jen známá baseline diagnostika TS2322 ve vite.config.ts:4:60 (shodná s main)."
  exit 0
fi
echo "TypeScript: nové nebo změněné diagnostiky (baseline povoluje jen TS2322 ve vite.config.ts:4:60)."
printf '%s\n' "$output"
exit 1
