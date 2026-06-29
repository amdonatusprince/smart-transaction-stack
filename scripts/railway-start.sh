#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${DB_PATH:-/data/txstack.sqlite}"
PORT="${PORT:-8787}"

mkdir -p "$(dirname "$DB_PATH")"

echo "Snapsis Railway: dashboard on :${PORT}, db at ${DB_PATH}"

pnpm exec tsx src/cli/index.ts dashboard --port "$PORT" &
dashboard_pid=$!

cleanup() {
  kill "$dashboard_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "Waiting for dashboard health check..."
for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
    echo "Dashboard is up"
    break
  fi
  if ! kill -0 "$dashboard_pid" 2>/dev/null; then
    echo "Dashboard process exited before becoming healthy"
    exit 1
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${PORT}/health" >/dev/null; then
  echo "Dashboard failed to start within 30s"
  exit 1
fi

if [ "${RAILWAY_RUN_WORKER:-1}" != "1" ]; then
  echo "RAILWAY_RUN_WORKER=0 — dashboard only; waiting on dashboard process"
  wait "$dashboard_pid"
  exit 0
fi

SIMULATE_COUNT="${SIMULATE_COUNT:-20}"
SIMULATE_INTERVAL_MS="${SIMULATE_INTERVAL_MS:-3000}"

echo "Starting one-shot evidence run (${SIMULATE_COUNT} transactions, mix of success and failure)"
pnpm exec tsx src/cli/index.ts simulate --count "$SIMULATE_COUNT" --interval "$SIMULATE_INTERVAL_MS" --live || true

echo "Evidence run complete — dashboard stays up for review"
wait "$dashboard_pid"
