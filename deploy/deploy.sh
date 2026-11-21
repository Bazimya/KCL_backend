#!/usr/bin/env bash
# Pull the latest code for both apps and roll it out. Run on the VPS as the
# `kcl` user (setup-vps.sh runs it the first time):
#   sudo -iu kcl /srv/kcl/KCL_backend/deploy/deploy.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/kcl}"

echo "==> Backend"
cd "$APP_DIR/KCL_backend"
git pull --ff-only
npm ci --omit=dev            # postinstall runs `prisma generate`
npm run release              # prisma migrate deploy

echo "==> Frontend"
cd "$APP_DIR/KCL_frontend"
git pull --ff-only
npm ci
# Build into a fresh folder, then swap it in, so the live site never serves
# a half-written dist/. Needs VITE_API_URL in .env.production.
npx vite build --outDir dist.new --emptyOutDir
rm -rf dist.old
[ -d dist ] && mv dist dist.old
mv dist.new dist
if [ -n "${WEB_ROOT:-}" ]; then rsync -a --delete dist/ "$WEB_ROOT/"; fi   # nginx-style setups only

echo "==> Restart API + web"
pm2 startOrReload "$APP_DIR/KCL_backend/deploy/ecosystem.config.js" --update-env
pm2 save

echo "==> Health check"
for i in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS "http://${KCL_BIND_HOST:-172.17.0.1}:5050/" >/dev/null; then
        echo "API is up."
        exit 0
    fi
    sleep 2
done
echo "API did not respond on ${KCL_BIND_HOST:-172.17.0.1}:5050 - check: pm2 logs kcl-api" >&2
exit 1
