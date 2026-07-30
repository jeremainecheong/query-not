#!/usr/bin/env bash
#
# Full end-to-end verification from a cold start.
#
# Seeds a database, starts the agent and the web server, runs the unit tests,
# the API suite and the browser suite, then tears everything down. Exits
# non-zero if anything fails.
#
#   PGURL=postgres://user:pw@host/db ./e2e/run.sh
#
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PGURL="${QUERYNOT_DATABASE_URL:-postgres://querynot_ro:test@127.0.0.1:5432/querynot}"
AGENT_PORT="${QUERYNOT_PORT:-5174}"
WEB_PORT="${QUERYNOT_WEB_PORT:-5173}"
LOGS="$(mktemp -d)"
AGENT_PID=""
WEB_PID=""
STATUS=0

cleanup() {
  [ -n "$AGENT_PID" ] && kill "$AGENT_PID" 2>/dev/null
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1"; STATUS=1; }

wait_for() {
  local url="$1" name="$2" tries=0
  until curl -sf --noproxy '*' "$url" >/dev/null 2>&1; do
    tries=$((tries + 1))
    if [ "$tries" -gt 120 ]; then
      fail "$name did not come up — see $LOGS"
      return 1
    fi
  done
  printf '  %s up\n' "$name"
}

step "Building core"
npx tsc -p packages/core/tsconfig.json || fail "core build"

step "Typechecking every package"
for pkg in core agent web; do
  npx tsc -p "packages/$pkg/tsconfig.json" --noEmit || fail "$pkg typecheck"
done

step "Unit tests"
node --test --experimental-strip-types "packages/*/test/**/*.test.ts" || fail "unit tests"

step "Starting the agent"
QUERYNOT_DATABASE_URL="$PGURL" QUERYNOT_PORT="$AGENT_PORT" \
  node --experimental-strip-types packages/agent/src/server.ts >"$LOGS/agent.log" 2>&1 &
AGENT_PID=$!
wait_for "http://localhost:$AGENT_PORT/api/health" "agent" || { cat "$LOGS/agent.log"; exit 1; }

step "Starting the web server"
(cd packages/web && npx vite --host 127.0.0.1 --port "$WEB_PORT" >"$LOGS/web.log" 2>&1) &
WEB_PID=$!
wait_for "http://127.0.0.1:$WEB_PORT/" "web" || { cat "$LOGS/web.log"; exit 1; }

step "API end-to-end"
QUERYNOT_AGENT_URL="http://localhost:$AGENT_PORT" node e2e/api.e2e.mjs || fail "API e2e"

step "Browser end-to-end"
QUERYNOT_WEB_URL="http://127.0.0.1:$WEB_PORT/" node e2e/ui.e2e.mjs || fail "UI e2e"

# The dev server and the production bundle are different artifacts. Verifying
# only the first ships a build nobody has run.
step "Production bundle"
npm run build --workspace @query-not/web >/dev/null 2>&1 || fail "web build"
kill "$AGENT_PID" 2>/dev/null; AGENT_PID=""
sleep 1
QUERYNOT_DATABASE_URL="$PGURL" QUERYNOT_PORT="$AGENT_PORT" \
  node --experimental-strip-types packages/agent/src/server.ts >"$LOGS/agent-prod.log" 2>&1 &
AGENT_PID=$!
if wait_for "http://localhost:$AGENT_PORT/api/health" "agent (serving UI)"; then
  grep -q 'serving the UI' "$LOGS/agent-prod.log" || fail "agent did not pick up the built UI"
  QUERYNOT_WEB_URL="http://localhost:$AGENT_PORT/" node e2e/ui.e2e.mjs >/dev/null 2>&1 \
    || fail "UI e2e against the production bundle"
  printf '  the built UI serves from the agent on one port\n'
fi

if [ "$STATUS" -eq 0 ]; then
  printf '\n\033[32m\033[1mAll green.\033[0m\n'
else
  printf '\n\033[31m\033[1mFailures above. Logs in %s\033[0m\n' "$LOGS"
fi
exit "$STATUS"
