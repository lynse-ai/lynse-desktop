#!/usr/bin/env bash
# Verify that a runtime executable starts and advertises the required flags.
set -euo pipefail

binary="${1:?Usage: verify-sidecar-help.sh <binary> [required flags...]}"
shift
if help_text=$("$binary" --help 2>&1); then
  help_status=0
else
  help_status=$?
fi

# FunASR prints valid usage and returns 1 for --help. Other failures (including
# loader errors and crashes) must still block packaging. Capture first so a
# short-circuiting grep cannot turn a successful producer into SIGPIPE.
if [[ "$help_status" -ne 0 ]]; then
  if [[ "$help_status" -ne 1 ]] || ! grep -Eiq '^[[:space:]]*usage:' <<< "$help_text"; then
    printf 'ERROR: %s --help failed (exit %s)\n%s\n' "$binary" "$help_status" "$help_text" >&2
    exit 1
  fi
fi

for flag in "$@"; do
  if ! grep -Fq -- "$flag" <<< "$help_text"; then
    printf 'ERROR: %s does not advertise %s\n%s\n' "$binary" "$flag" "$help_text" >&2
    exit 1
  fi
done
printf '%s\n' "$help_text"
