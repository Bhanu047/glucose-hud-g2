#!/usr/bin/env bash
# Drives the Even Hub simulator headlessly and captures glasses screenshots.
# Needs: Xvfb, `node mock/nightscout.mjs` (:1337), `node scripts/dev-relay.mjs`
# (:8787) and `npx vite --port 5173` running.
#   bash scripts/sim-shots.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SIM=$PWD/node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator
PORT=9898
APP=http://localhost:5173/
RELAY=http://localhost:8787
mkdir -p shots

enc() { python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$1"; }

start() { # url
  pkill -f evenhub-simulator >/dev/null 2>&1 || true
  sleep 0.5
  xvfb-run -a -s "-screen 0 1400x900x24" "$SIM" "$1" --automation-port $PORT >/tmp/sim.log 2>&1 &
  for _ in $(seq 1 40); do sleep 0.5; curl -sf http://127.0.0.1:$PORT/api/ping >/dev/null && break; done
  sleep 7
}
snap() { curl -s http://127.0.0.1:$PORT/api/screenshot/glasses -o "shots/$1.png"; echo "shots/$1.png"; }
input() { curl -s -X POST http://127.0.0.1:$PORT/api/input -H 'Content-Type: application/json' -d "{\"action\":\"$1\"}" >/dev/null; }

PEOPLE='[{"name":"Mia","source":"libre","username":"a@b.c","password":"pw","patientId":"pt-mia"},{"name":"Dad","source":"libre","username":"a@b.c","password":"pw","patientId":"pt-dad"}]'

# Caregiver mode via LibreLinkUp: Mia is falling (predicted LOW); swipe → Dad
start "${APP}?relay=$(enc $RELAY)&people=$(enc "$PEOPLE")"
snap v2-libre-mia
input down; sleep 4; snap v2-libre-dad
input up;   sleep 4; snap v2-libre-mia-again
curl -s "http://127.0.0.1:$PORT/api/console" | grep -oE '"message":"[^"]*(failed|error|Error)[^"]*"' | head -5 || true

start "${APP}?src=dexcom&user=u&pass=pw&relay=$(enc $RELAY)"
snap v2-dexcom

start "${APP}?ns=$(enc http://localhost:1337/normal)"; snap v2-ns-normal
start "${APP}?ns=$(enc http://localhost:1337/low)"; snap v2-ns-low
start "${APP}?ns=$(enc http://localhost:1337/uhigh)"; snap v2-ns-uhigh
start "${APP}?ns=$(enc http://localhost:1337/stale)"; snap v2-ns-stale
start "${APP}?ns=$(enc http://localhost:1337/flat)&units=mmol"; snap v2-ns-mmol
start "${APP}?src=libre&user=a@b.c&pass=wrong&relay=$(enc $RELAY)"; snap v2-error
start "${APP}"; snap v2-unconfigured

pkill -f evenhub-simulator >/dev/null 2>&1 || true
