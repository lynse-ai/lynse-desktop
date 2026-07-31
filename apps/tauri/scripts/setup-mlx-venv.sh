#!/usr/bin/env bash
# Create the Python virtual environment that backs the macOS MLX-Whisper STT
# engine. The shipped app provisions this automatically on first use
# (see `ensure_mlx_venv` in lib.rs), but creating it ahead of time is useful
# for local development and for CI that wants to pre-bake the runtime.
#
# Usage: bash apps/tauri/scripts/setup-mlx-venv.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
VENV="$ROOT/.venv-mlx"

if [[ -x "$VENV/bin/python" ]]; then
  echo "MLX venv already exists at $VENV"
else
  echo "Creating MLX venv at $VENV ..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --disable-pip-version-check "mlx-whisper" "imageio-ffmpeg"
  echo "MLX venv ready."
fi

# Smoke test: confirm the bridge imports cleanly.
"$VENV/bin/python" - <<'PY'
try:
    from mlx_whisper import transcribe  # noqa: F401
    import imageio_ffmpeg  # noqa: F401
    print("mlx-whisper + imageio-ffmpeg import OK")
except Exception as exc:  # pragma: no cover
    raise SystemExit(f"MLX venv check failed: {exc}")
PY
