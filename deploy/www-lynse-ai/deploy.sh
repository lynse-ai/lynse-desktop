#!/bin/bash
# Deploy the lynse-desktop web app (Next standalone bundle) to www.lynse.ai.
#
# Prerequisites:
#   - apps/web built with NEXT_PUBLIC_BASE_PATH=/app and output "standalone"
#     (the bundle path is passed as $1, see build command in this repo's docs)
#   - ssh alias `tencent` -> ubuntu@43.130.12.243 (key ~/.ssh/lynseWbEd25519.pem)
#   - ubuntu has passwordless sudo for nginx (same as deploy-revelspark.sh)
#
# Usage: deploy/www-lynse-ai/deploy.sh <path-to-standalone-bundle>
set -euo pipefail

BUNDLE=${1:?usage: deploy.sh <standalone-bundle-dir>}
# Monorepo standalone layout: server.js lives at apps/web/server.js under the
# bundle root, and the compose service runs `node apps/web/server.js`.
[ -f "$BUNDLE/apps/web/server.js" ] || { echo "no apps/web/server.js in $BUNDLE" >&2; exit 2; }

HOST=${LYNSE_WEB_HOST:-tencent}
REMOTE_DIR='~/apps/lynse-web'
STAMP=$(date +%Y%m%d-%H%M%S)

echo "== 1. upload bundle ($STAMP) =="
ssh "$HOST" "mkdir -p $REMOTE_DIR/bundle $REMOTE_DIR/backups"
rsync -a --delete "$BUNDLE"/ "$HOST:$REMOTE_DIR/bundle/"
scp "$(dirname "$0")/compose.yml" "$HOST:$REMOTE_DIR/compose.yml"

echo "== 2. (re)start container =="
ssh "$HOST" "cd $REMOTE_DIR && docker compose -p lynse-web-app -f compose.yml up -d --force-recreate && sleep 5 && docker compose -p lynse-web-app -f compose.yml ps"

echo "== 3. nginx /app/ activation (idempotent) =="
scp "$(dirname "$0")/app-nginx.conf" "$HOST:/tmp/lynse-web-app-nginx.conf"
ssh "$HOST" 'bash -s' <<'ACTIVATE'
set -eu
SITE=/etc/nginx/sites-enabled/revelspark
SNIPPET=/etc/nginx/snippets/lynse-web-app.conf
sudo mkdir -p /etc/nginx/snippets "$HOME/apps/lynse-web/backups"
sudo cp /tmp/lynse-web-app-nginx.conf "$SNIPPET"
sudo chmod 644 "$SNIPPET"
if ! sudo grep -q "lynse-web-app.conf" "$SITE"; then
    sudo cp "$SITE" "$HOME/apps/lynse-web/backups/revelspark.bak.$(date +%s)"
    sudo sed -i '/server_name\s\+www\.lynse\.ai\s\+lynse\.ai\s*;/a\    include /etc/nginx/snippets/lynse-web-app.conf;' "$SITE"
    if ! sudo grep -q "lynse-web-app.conf" "$SITE"; then
        echo "failed to insert include into $SITE" >&2; exit 1
    fi
fi
if ! sudo nginx -t; then
    latest=$(ls -1t "$HOME/apps/lynse-web/backups"/revelspark.bak.* 2>/dev/null | head -1)
    [ -n "$latest" ] && sudo cp "$latest" "$SITE"
    sudo nginx -t && sudo systemctl reload nginx || true
    echo "nginx test failed; site config restored" >&2
    exit 1
fi
sudo systemctl reload nginx
echo "nginx activated"
ACTIVATE

echo "== 4. health checks =="
sleep 3
ssh "$HOST" 'docker compose -p lynse-web-app -f ~/apps/lynse-web/compose.yml ps; curl -fsS -o /dev/null -w "local /app/: %{http_code}\n" http://127.0.0.1:3102/app/'
curl -fsS -o /dev/null -w "public /app/: %{http_code}\n" https://www.lynse.ai/app/
echo "deployed bundle $STAMP"
