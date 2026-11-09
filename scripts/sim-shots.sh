#!/usr/bin/env bash
# Drives the Even Hub simulator headlessly and captures glasses screenshots
# for each mock scenario. Requires: Xvfb, mock server on :1337, vite on :5173.
#   bash scripts/sim-shots.sh
set -euo pipefail
cd "$(dirname "$0")/.."
SIM=$PWD/node_modules/@evenrealities/sim-linux-x64/bin/evenhub-simulator
PORT=9898
mkdir -p shots

shot() { # name url
  pkill -f evenhub-simulator >/dev/null 2>&1 || true
  sleep 0.5
  xvfb-run -a -s "-screen 0 1400x900x24" "$SIM" "$2" --automation-port $PORT >/tmp/sim-$1.log 2>&1 &
  for _ in $(seq 1 40); do sleep 0.5; curl -sf http://127.0.0.1:$PORT/api/ping >/dev/null && break; done
  sleep 6
  curl -s http://127.0.0.1:$PORT/api/screenshot/glasses -o "shots/$1.png"
  echo "shots/$1.png"
}

shot normal      "http://localhost:5173/?ns=http://localhost:1337"
shot low         "http://localhost:5173/?ns=http://localhost:1337/low"
shot urgent-high "http://localhost:5173/?ns=http://localhost:1337/uhigh"
shot stale       "http://localhost:5173/?ns=http://localhost:1337/stale"
shot mmol        "http://localhost:5173/?ns=http://localhost:1337/flat&units=mmol"
shot unconfigured "http://localhost:5173/"
shot bad-token   "http://localhost:5173/?ns=http://localhost:1337&token=wrong"

# Interaction: tap should refresh (value changes with the drifting mock),
# double-tap should exit (console shows shutDown).
shot tap-before "http://localhost:5173/?ns=http://localhost:1337"
curl -s -X POST http://127.0.0.1:$PORT/api/input -H 'Content-Type: application/json' -d '{"action":"click"}' >/dev/null
sleep 3
curl -s http://127.0.0.1:$PORT/api/screenshot/glasses -o shots/tap-after.png
echo shots/tap-after.png
curl -s -X POST http://127.0.0.1:$PORT/api/input -H 'Content-Type: application/json' -d '{"action":"double_click"}' >/dev/null
sleep 2
curl -s http://127.0.0.1:$PORT/api/console | grep -oE '"message":"[^"]*(shutDown|exit|Exit)[^"]*"' | head -3 || true
curl -s http://127.0.0.1:$PORT/api/screenshot/glasses -o shots/after-exit.png
echo shots/after-exit.png
pkill -f evenhub-simulator >/dev/null 2>&1 || true
