#!/usr/bin/env bash
# Compile the Python STT/voiceprint bridge sources into -O bytecode, one set
# per supported CPython minor version. Release bundles ship ONLY these .pyc
# files (under resources/compiled/); the .py sources stay in the repository
# and out of the app, so extracting an installer yields no readable bridges.
#
#   bash apps/tauri/scripts/compile-sidecar-bytecode.sh
#
# Runs automatically as part of `tauri build` (beforeBuildCommand). Needs one
# CPython per supported minor version, resolved in order from: named
# interpreters on PATH (python3.12), the Windows `py` launcher (py -3.12), and
# uv-managed installations (auto-installed when uv is on PATH).
#
# The supported versions MUST mirror SIDECAR_PYTHON_TAGS in
# apps/tauri/src-tauri/src/lib.rs — update both together. The runtime resolves
# <stem>.<tag>.pyc by asking the bridge's venv interpreter for its version, so
# a version missing here is an engine that dead-ends on those user machines.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SRC_DIR="$ROOT/apps/tauri/src-tauri/resources"
OUT_DIR="$SRC_DIR/compiled"

VERSIONS=(3.9 3.10 3.11 3.12 3.13 3.14)
BRIDGES=(funasr_transcribe mlx_transcribe qwen3_transcribe whisperx_transcribe sherpa_voiceprint)

# find_interpreter's stdout is captured by the caller — diagnostics go to stderr.
log() { printf '==> %s\n' "$*" >&2; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

tag_of() { # 3.9 -> 309 (mirrors Rust format_version_tag)
  local minor="${1#*.}"
  printf '%s%02d' "${1%%.*}" "$((10#$minor))"
}

# Resolve an interpreter for $1 (e.g. 3.12); prints the path or nothing.
find_interpreter() {
  local version="$1" minor="${1#*.}" candidate
  for candidate in "python$version" "python3$minor"; do
    if command -v "$candidate" >/dev/null 2>&1 \
      && "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3, 9) else 1)' 2>/dev/null; then
      command -v "$candidate"
      return 0
    fi
  done
  if command -v py >/dev/null 2>&1 && py -"$minor" -c 'import sys' >/dev/null 2>&1; then
    py -"$minor" -c 'import sys; print(sys.executable)'
    return 0
  fi
  if command -v uv >/dev/null 2>&1; then
    if ! uv python find "$version" >/dev/null 2>&1; then
      log "uv: installing CPython $version"
      uv python install "$version" >/dev/null 2>&1 || true
    fi
    # uv's freshly-installed alias dirs can lag the install by a moment —
    # only accept a path that actually runs.
    for _ in 1 2 3; do
      if path="$(uv python find "$version" 2>/dev/null)" \
        && [[ -x "$path" ]] && "$path" --version >/dev/null 2>&1; then
        printf '%s\n' "$path"
        return 0
      fi
      sleep 1
    done
  fi
  return 1
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

declare -a MISSING=()
for version in "${VERSIONS[@]}"; do
  if interpreter="$(find_interpreter "$version")"; then
    tag="$(tag_of "$version")"
    for stem in "${BRIDGES[@]}"; do
      src="$SRC_DIR/$stem.py"
      [[ -s "$src" ]] || die "$src is missing — the bridge list in this script is stale"
      # optimize=2 (-OO) strips docstrings as well as asserts; none of the
      # bridges rely on assert side effects, and the docstrings are the most
      # readable part of a decompiled file.
      "$interpreter" -c 'import py_compile, sys; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True, optimize=2)' \
        "$src" "$OUT_DIR/$stem.$tag.pyc"
    done
    log "CPython $version ($interpreter): ${#BRIDGES[@]} bridges compiled"
  else
    MISSING+=("$version")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  die "No interpreter found for: ${MISSING[*]}.
  Install them (uv: 'uv python install ${MISSING[*]}'), then rerun — a release
  built without these tags strands users whose venv picked that version."
fi

log "Bytecode ready: $(find "$OUT_DIR" -name '*.pyc' | wc -l | tr -d ' ') files in $OUT_DIR"
