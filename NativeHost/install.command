#!/bin/sh
# TabGroup Master -- Native Host Setup (macOS, double-clickable in Finder)
#
# OPTIONAL. The extension works without it. This only enables importing your
# CLOSED / saved tab groups. No sudo / admin required.

cd "$(dirname "$0")" || exit 1

echo "============================================================"
echo "TabGroup Master -- Native Host Setup (macOS)"
echo "============================================================"

PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
  echo "[ERROR] Python 3 not found. Install it from https://python.org and re-run."
  exit 1
fi

"$PY" -c "import cramjam" >/dev/null 2>&1 || {
  echo "[1/2] Installing dependency 'cramjam'..."
  "$PY" -m pip install --user --quiet cramjam
}

echo "[2/2] Registering native host..."
"$PY" setup.py

echo ""
echo "Restart your browser and reload the extension."
