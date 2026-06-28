#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/data/txstack.sqlite}"
PORT="${PORT:-8787}"

mkdir -p "$(dirname "$DB_PATH")"

echo "Snapsis Railway: dashboard on :${PORT}, db at ${DB_PATH}"

pnpm run build:article

pnpm exec tsx src/cli/index.ts dashboard --port "$PORT" &
dashboard_pid=$!

cleanup() {
  kill "$dashboard_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if [ "${RAILWAY_RUN_WORKER:-1}" != "1" ]; then
  echo "RAILWAY_RUN_WORKER=0 — dashboard only; waiting on dashboard process"
  wait "$dashboard_pid"
  exit 0
fi

echo "Starting live worker loop (simulate → pause → repeat)"
while true; do
  pnpm exec tsx src/cli/index.ts simulate --count 20 --interval 3000 --live || true
  sleep 5
done
