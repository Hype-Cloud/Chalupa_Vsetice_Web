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
  echo "TypeScript: jen známá baseline diagnostika (shodná s main): $BASELINE"
  exit 0
fi
echo "TypeScript: nové nebo změněné diagnostiky (baseline povoluje jen: $BASELINE)"
printf '%s\n' "$output"
exit 1
