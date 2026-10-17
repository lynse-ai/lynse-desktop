#!/usr/bin/env bash
set -euo pipefail

VERIFY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/verify-sidecar-help.sh"
CASE_DIR=$(mktemp -d)
trap 'rm -rf "$CASE_DIR"' EXIT

cat > "$CASE_DIR/usage" <<'SH'
#!/usr/bin/env bash
printf 'usage: runtime [--srt] [--vad] [--chunk]\n'
exit 1
SH
cat > "$CASE_DIR/loader-error" <<'SH'
#!/usr/bin/env bash
printf 'error while loading shared libraries\n' >&2
exit 1
SH
cat > "$CASE_DIR/crash" <<'SH'
#!/usr/bin/env bash
printf 'usage: runtime [--srt]\n'
exit 139
SH
cat > "$CASE_DIR/long-help" <<'SH'
#!/usr/bin/env bash
printf 'usage: runtime [--srt]\n'
for ((i=0; i<10000; i++)); do printf 'extended help line\n'; done
exit 0
SH
chmod +x "$CASE_DIR/"*

bash "$VERIFY" "$CASE_DIR/usage" --srt --vad --chunk > /dev/null
bash "$VERIFY" "$CASE_DIR/long-help" --srt > /dev/null
for invalid in loader-error crash; do
  if bash "$VERIFY" "$CASE_DIR/$invalid" --srt > /dev/null 2>&1; then
    printf 'ERROR: accepted %s\n' "$invalid" >&2
    exit 1
  fi
done
if bash "$VERIFY" "$CASE_DIR/usage" --missing > /dev/null 2>&1; then
  printf 'ERROR: accepted a missing flag\n' >&2
  exit 1
fi
printf 'Sidecar help checks passed.\n'
