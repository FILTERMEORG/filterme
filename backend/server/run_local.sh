#!/usr/bin/env bash
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SERVER_DIR/.venv"
PYTHON_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  echo "Creating virtual environment at $VENV_DIR"
  python3 -m venv "$VENV_DIR"
fi

echo "Installing backend dependencies"
"$PYTHON_BIN" -m pip install -r "$SERVER_DIR/requirements.txt"

cd "$SERVER_DIR"
echo "Starting FilterMe backend at http://127.0.0.1:8000"
exec "$VENV_DIR/bin/python" -m uvicorn main:app --host 127.0.0.1 --port 8000 --reload
