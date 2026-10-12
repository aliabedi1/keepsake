#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_EXE="$PROJECT_ROOT/.venv/bin/python"
REQUIREMENTS_FILE="$PROJECT_ROOT/requirements.txt"
REQUIREMENTS_STAMP="$PROJECT_ROOT/.venv/.requirements.sha256"
BACKEND_PID=""

cd "$PROJECT_ROOT"

# Bypass environment proxies for local services; preserve external routing.
export NO_PROXY="${NO_PROXY:-},${no_proxy:-},localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

if [[ ! -x "$PYTHON_EXE" ]]; then
  if ! command -v python3 >/dev/null 2>&1; then
    echo "Python 3 is required but the python3 command was not found." >&2
    exit 1
  fi

  echo "Preparing the local downloader for first use..."
  if ! python3 -m venv .venv; then
    echo "Could not create the virtual environment. Install your distribution's python3-venv package and try again." >&2
    exit 1
  fi
fi

if ! command -v sha256sum >/dev/null 2>&1; then
  echo "sha256sum is required but was not found." >&2
  exit 1
fi

REQUIREMENTS_HASH="$(sha256sum "$REQUIREMENTS_FILE" | awk '{print $1}')"
INSTALLED_HASH=""
if [[ -f "$REQUIREMENTS_STAMP" ]]; then
  INSTALLED_HASH="$(<"$REQUIREMENTS_STAMP")"
fi

if [[ "$INSTALLED_HASH" != "$REQUIREMENTS_HASH" ]]; then
  echo "Installing downloader dependencies..."
  "$PYTHON_EXE" -m pip install --disable-pip-version-check -r "$REQUIREMENTS_FILE"
  printf '%s' "$REQUIREMENTS_HASH" > "$REQUIREMENTS_STAMP"
fi

if ! command -v npx >/dev/null 2>&1; then
  echo "Node.js and npm are required but the npx command was not found." >&2
  exit 1
fi

cleanup() {
  if [[ -n "$BACKEND_PID" ]] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

"$PYTHON_EXE" -m uvicorn local_backend.app:app \
  --host 127.0.0.1 \
  --port 8787 &
BACKEND_PID=$!

export WRANGLER_LOG_PATH=".wrangler/wrangler.log"

echo
echo "Keepsake is starting at http://127.0.0.1:3000"
echo "Press Ctrl+C to stop it."
npx vinext dev --hostname 127.0.0.1 --port 3000
