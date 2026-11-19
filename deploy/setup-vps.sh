#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04 / 24.04 VPS for Kigali Coffee Lab:
# Node 20 + pm2, MySQL, nginx, HTTPS (Let's Encrypt), firewall, nightly
# backups, both apps cloned, built and running. Safe to re-run: existing
# secrets, database and .env files are kept.
#
# Before running: point BOTH domains' DNS A records at this server's IP.
#
# Run as root on the server:
#   curl -fsSLO https://raw.githubusercontent.com/Bazimya/KCL_backend/main/deploy/setup-vps.sh
#   sudo APP_DOMAIN=kigalicoffeelab.com API_DOMAIN=api.kigalicoffeelab.com \
#        LETSENCRYPT_EMAIL=you@example.com \
#        INITIAL_ADMIN_EMAIL=admin@kigalicoffeelab.com \
#        INITIAL_ADMIN_PASSWORD='a-unique-password-16+chars' \
#        bash setup-vps.sh
#
# Optional: SKIP_TLS=1 (DNS not ready yet - rerun later without it),
# BACKEND_REPO / FRONTEND_REPO (e.g. SSH URLs for private repos - add the
# server's SSH key to GitHub as a deploy key first), BRANCH (default main).
set -euo pipefail

: "${APP_DOMAIN:?Set APP_DOMAIN, e.g. kigalicoffeelab.com}"
: "${API_DOMAIN:?Set API_DOMAIN, e.g. api.kigalicoffeelab.com}"
if [ "${SKIP_TLS:-0}" != "1" ]; then
    : "${LETSENCRYPT_EMAIL:?Set LETSENCRYPT_EMAIL (or SKIP_TLS=1)}"
fi
[ "$(id -u)" -eq 0 ] || { echo "Run as root (sudo)." >&2; exit 1; }

BACKEND_REPO="${BACKEND_REPO:-https://github.com/Bazimya/KCL_backend.git}"
FRONTEND_REPO="${FRONTEND_REPO:-https://github.com/Bazimya/KCL_frontend.git}"
BRANCH="${BRANCH:-main}"
APP_USER=kcl
APP_DIR=/srv/kcl
WEB_ROOT=/var/www/kcl
UPLOADS_DIR=/var/lib/kcl/uploads
BACKUP_DIR=/var/backups/kcl
DB_NAME=kigali_coffee_lab
DB_USER=kcl
BACKEND="$APP_DIR/KCL_backend"
FRONTEND="$APP_DIR/KCL_frontend"
as_app() { sudo -iu "$APP_USER" bash -c "$1"; }

echo "==> Packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git rsync nginx mysql-server ufw openssl
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
fi
command -v pm2 >/dev/null || npm install -g pm2
if [ "${SKIP_TLS:-0}" != "1" ]; then apt-get install -y certbot python3-certbot-nginx; fi

echo "==> App user and folders"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --shell /bin/bash "$APP_USER"
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
mkdir -p "$APP_DIR" "$WEB_ROOT" "$UPLOADS_DIR" "$BACKUP_DIR" /var/log/kcl
chown "$APP_USER:$APP_USER" "$APP_DIR" "$WEB_ROOT" "$BACKUP_DIR" /var/log/kcl
chown -R "$APP_USER:$APP_USER" "$(dirname "$UPLOADS_DIR")"

echo "==> Code"
[ -d "$BACKEND/.git" ]  || as_app "git clone --branch '$BRANCH' '$BACKEND_REPO' '$BACKEND'"
[ -d "$FRONTEND/.git" ] || as_app "git clone --branch '$BRANCH' '$FRONTEND_REPO' '$FRONTEND'"

echo "==> MySQL"
if [ ! -f "$BACKEND/.env" ]; then
    DB_PASS="$(openssl rand -hex 24)"
    mysql <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL

    echo "==> Backend .env (secrets generated here, never committed)"
    umask 077
    cat > "$BACKEND/.env" <<ENV
NODE_ENV=production
PORT=5050
DATABASE_URL=mysql://$DB_USER:$DB_PASS@127.0.0.1:3306/$DB_NAME
FRONTEND_URL=https://$APP_DOMAIN
PUBLIC_APP_URL=https://$APP_DOMAIN
UPLOADS_DIR=$UPLOADS_DIR
JWT_KEY=$(openssl rand -hex 32)
PASSWORD_KEY=$(openssl rand -hex 32)
TRUST_PROXY=1
ENV
    # mysqldump credentials for deploy/backup.sh
    printf '[client]\nuser=%s\npassword=%s\n' "$DB_USER" "$DB_PASS" > "$APP_HOME/.my.cnf"
    umask 022
    chown "$APP_USER:$APP_USER" "$BACKEND/.env" "$APP_HOME/.my.cnf"
    chmod 600 "$BACKEND/.env" "$APP_HOME/.my.cnf"
else
    echo "    $BACKEND/.env exists - keeping its database and secrets."
fi

echo "==> Frontend build config"
printf 'VITE_API_URL=https://%s\n' "$API_DOMAIN" > "$FRONTEND/.env.production"
chown "$APP_USER:$APP_USER" "$FRONTEND/.env.production"

echo "==> Sample catalog images -> persistent uploads folder"
for d in products drinks staff; do
    if [ -d "$BACKEND/uploads/$d" ]; then
        as_app "mkdir -p '$UPLOADS_DIR/$d' && cp -rn '$BACKEND/uploads/$d/.' '$UPLOADS_DIR/$d/'"
    fi
done

echo "==> Build, migrate and start"
chmod +x "$BACKEND/deploy/"*.sh
as_app "'$BACKEND/deploy/deploy.sh'"
pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || true

if [ -n "${INITIAL_ADMIN_EMAIL:-}" ] && [ -n "${INITIAL_ADMIN_PASSWORD:-}" ]; then
    echo "==> First admin account"
    as_app "cd '$BACKEND' && INITIAL_ADMIN_EMAIL=$(printf %q "$INITIAL_ADMIN_EMAIL") INITIAL_ADMIN_PASSWORD=$(printf %q "$INITIAL_ADMIN_PASSWORD") npm run seed"
fi

echo "==> nginx"
sed -e "s/__APP_DOMAIN__/$APP_DOMAIN/g" -e "s/__API_DOMAIN__/$API_DOMAIN/g" \
    "$BACKEND/deploy/nginx-kcl.conf.template" > /etc/nginx/sites-available/kcl
ln -sf /etc/nginx/sites-available/kcl /etc/nginx/sites-enabled/kcl
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 'Nginx Full' >/dev/null
ufw --force enable >/dev/null

if [ "${SKIP_TLS:-0}" != "1" ]; then
    echo "==> HTTPS certificates"
    certbot --nginx --non-interactive --agree-tos --redirect \
        -m "$LETSENCRYPT_EMAIL" -d "$APP_DOMAIN" -d "$API_DOMAIN"
fi

echo "==> Nightly backups (02:30)"
cron_line="30 2 * * * $BACKEND/deploy/backup.sh >> /var/log/kcl/backup.log 2>&1"
( crontab -u "$APP_USER" -l 2>/dev/null | grep -vF "deploy/backup.sh"; echo "$cron_line" ) | crontab -u "$APP_USER" -

cat <<DONE

========================================================
 Kigali Coffee Lab is deployed.
   Site: https://$APP_DOMAIN
   API:  https://$API_DOMAIN
 Update later with:  sudo -iu $APP_USER $BACKEND/deploy/deploy.sh
 Logs:               sudo -iu $APP_USER pm2 logs kcl-api
 Backups:            $BACKUP_DIR (copy them off this server!)
 Secrets live only in $BACKEND/.env - back that file up somewhere safe.
========================================================
DONE
