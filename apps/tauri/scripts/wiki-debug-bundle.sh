#!/usr/bin/env bash
# Collect a wiki-organize debug bundle for AI diagnosis.
#
# Gathers the structured workbench log lines (wiki-run/catalog/compile/model/
# embed + cloud transport/capabilities/memory), a raw tail for context, and the
# live workbench state.json progress snapshot into one markdown document that
# an LLM can read to locate the failing stage.
#
# Usage: wiki-debug-bundle.sh [tail_lines]   (default 400)
# Output: /tmp/wiki-debug-bundle.md (path printed to stdout)
set -euo pipefail

LOG_DIR="$HOME/Library/Logs/com.lynse.sparknote"
WORKBENCH_DIR="$HOME/Library/Application Support/com.lynse.sparknote/workbench"
OUT="${TMPDIR:-/tmp}/wiki-debug-bundle.md"
LINES="${1:-400}"

# Newest daily log file (tauri-plugin-log writes lynse-YYYY-MM-DD.log).
LOG_FILE="$(ls -t "$LOG_DIR"/lynse-*.log 2>/dev/null | head -1 || true)"

{
  echo "# Wiki organize debug bundle"
  echo "- Collected: $(date '+%F %T')"
  echo "- Log file: ${LOG_FILE:-<none found>}"
  echo

  if [ -n "${LOG_FILE:-}" ]; then
    echo "## Structured workbench lines (last $LINES matches)"
    echo '```'
    grep -E '\[(wiki-run|wiki-catalog|wiki-compile|wiki-model|wiki-embed|cloud-transport|cloud-capabilities|cloud-memory)\]|Knowledge (profile refresh|cloud synchronization)|Wiki organize' \
      "$LOG_FILE" | tail -"$LINES" || echo "(no structured workbench lines yet)"
    echo '```'
    echo
    echo "## Raw log tail (last 60 lines)"
    echo '```'
    tail -60 "$LOG_FILE"
    echo '```'
  else
    echo "(no log file found under $LOG_DIR)"
  fi

  echo
  echo "## Workbench state (newest scope)"
  local_scope="$(ls -t "$WORKBENCH_DIR" 2>/dev/null | grep -v identities | head -1 || true)"
  if [ -n "${local_scope:-}" ] && [ -f "$WORKBENCH_DIR/$local_scope/state.json" ]; then
    python3 - "$WORKBENCH_DIR/$local_scope/state.json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    state = json.load(f)
keys = ["generation", "error"]
progress = state.get("wikiProgress") or {}
print(json.dumps({
    **{k: state.get(k) for k in keys},
    "wikiProgress": progress,
}, ensure_ascii=False, indent=2))
PY
  else
    echo "(no workbench scope state.json found under $WORKBENCH_DIR)"
  fi
} > "$OUT"

echo "$OUT"
