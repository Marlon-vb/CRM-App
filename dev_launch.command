#!/bin/bash
# Dev-mode launcher: kill anything on :3456, rebuild app/dist, start Electron
# against the LIVE backend in desktop/. Used to smoke-test edits without
# having to rebuild the packaged .app.
#
# Quit this terminal window (or Ctrl+C) to stop Cadence.

set -e
cd "$(dirname "$0")"

echo "→ Stopping any running Cadence instances..."
pkill -f "Electron.*Cadence" 2>/dev/null || true
pkill -f "node.*backend/server" 2>/dev/null || true
PIDS=$(lsof -ti:3456 2>/dev/null || true)
if [ -n "$PIDS" ]; then
  echo "   killing PID(s) on :3456 — $PIDS"
  echo "$PIDS" | xargs kill -9 2>/dev/null || true
  sleep 1
fi

echo "→ Building frontend (app/dist)..."
npm --prefix app run build

echo "→ Launching Cadence (Electron + live backend)..."
cd desktop && npm start
