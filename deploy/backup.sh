#!/usr/bin/env bash
# Nightly backup of the MySQL database and the uploads folder, kept for
# KEEP_DAYS days. setup-vps.sh installs it as a cron job for the `kcl` user.
# Credentials come from ~kcl/.my.cnf (created by setup-vps.sh, chmod 600).
# Copy /var/backups/kcl somewhere OFF this server regularly - a backup on the
# same disk does not survive losing the server.
set -euo pipefail

DB_NAME="${DB_NAME:-kigali_coffee_lab}"
UPLOADS_DIR="${UPLOADS_DIR:-/var/lib/kcl/uploads}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kcl}"
KEEP_DAYS="${KEEP_DAYS:-14}"
stamp="$(date +%F-%H%M)"

mkdir -p "$BACKUP_DIR"
mysqldump --single-transaction --no-tablespaces --routines "$DB_NAME" \
    | gzip > "$BACKUP_DIR/db-$stamp.sql.gz"
tar -czf "$BACKUP_DIR/uploads-$stamp.tar.gz" -C "$(dirname "$UPLOADS_DIR")" "$(basename "$UPLOADS_DIR")"

find "$BACKUP_DIR" -maxdepth 1 -name 'db-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
find "$BACKUP_DIR" -maxdepth 1 -name 'uploads-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written: $BACKUP_DIR/*-$stamp.*"
