#!/usr/bin/env bash
# Pull the latest code for both apps and roll it out. Run on the VPS as the
# `kcl` user (setup-vps.sh runs it the first time):
#   sudo -iu kcl /srv/kcl/KCL_backend/deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/kcl}"
WEB_ROOT="${WEB_ROOT:-/var/www/kcl}"

echo "==> Backend"
cd "$APP_DIR/KCL_backend"
git pull --ff-only
npm ci --omit=dev            # postinstall runs `prisma generate`
npm run release              # prisma migrate deploy
pm2 startOrReload deploy/ecosystem.config.js
pm2 save

echo "==> Frontend"
cd "$APP_DIR/KCL_frontend"
git pull --ff-only
npm ci
npm run build                # needs VITE_API_URL in .env.production
rsync -a --delete dist/ "$WEB_ROOT/"

echo "==> Health check"
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS http://127.0.0.1:5050/ >/dev/null; then
        echo "API is up."
        exit 0
    fi
    sleep 2
done
echo "API did not respond on 127.0.0.1:5050 - check: pm2 logs kcl-api" >&2
exit 1
