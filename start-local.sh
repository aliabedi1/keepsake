#!/usr/bin/env bash

set -Eeuo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PYTHON_EXE="$PROJECT_ROOT/.venv/bin/python"
WINDOWS=false
case "${OSTYPE:-}" in
  msys*|cygwin*|win32*)
    WINDOWS=true
    PYTHON_EXE="$PROJECT_ROOT/.venv/Scripts/python.exe"
    ;;
esac
REQUIREMENTS_FILE="$PROJECT_ROOT/requirements.txt"
REQUIREMENTS_STAMP="$PROJECT_ROOT/.venv/.requirements.sha256"
BACKEND_PID=""

cd "$PROJECT_ROOT"

# Bypass environment proxies for local services; preserve external routing.
export NO_PROXY="${NO_PROXY:-},${no_proxy:-},localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"

if [[ ! -x "$PYTHON_EXE" ]] || ! "$PYTHON_EXE" -c 'import sys; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
  PYTHON_COMMAND=()
  # Windows Store aliases exist on PATH even when they cannot run Python.
  for candidate in python3 python py; do
    command -v "$candidate" >/dev/null 2>&1 || continue
    candidate_command=("$candidate")
    if [[ "$candidate" == py ]]; then
      candidate_command+=(-3)
    fi
    if "${candidate_command[@]}" -c 'import sys, venv; sys.exit(sys.version_info.major != 3)' >/dev/null 2>&1; then
      PYTHON_COMMAND=("${candidate_command[@]}")
      break
    fi
  done

  if [[ ${#PYTHON_COMMAND[@]} -eq 0 ]]; then
    if [[ "$WINDOWS" == true ]]; then
      echo "A working Python 3 installation is required. Install Python for Windows with PATH enabled, then reopen Git Bash. Checked python3, python, and py -3." >&2
    else
      echo "Python 3 with the venv module is required. Install Python and your distribution's python3-venv package." >&2
    fi
    exit 1
  fi

  echo "Preparing the local downloader for first use..."
  if ! "${PYTHON_COMMAND[@]}" -m venv .venv; then
    if [[ "$WINDOWS" == true ]]; then
      echo "Could not create the virtual environment. Repair your Python installation with venv and pip enabled, then try again." >&2
    else
      echo "Could not create the virtual environment. Install your distribution's python3-venv package and try again." >&2
    fi
    exit 1
  fi
  if [[ ! -x "$PYTHON_EXE" ]]; then
    echo "The virtual environment did not create the expected interpreter: $PYTHON_EXE" >&2
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
