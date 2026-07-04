#!/usr/bin/env bash
# HMS daily backup: DB dump + uploads volume, 30-day rolling retention.
set -euo pipefail
BACKUP_DIR=/var/backups/hms
STAMP=$(date +%Y%m%d_%H%M%S)
mkdir -p "$BACKUP_DIR"

# 1) PostgreSQL dump
docker exec hms-postgres pg_dump -U hms_user hms | gzip > "$BACKUP_DIR/db_$STAMP.sql.gz"

# 2) uploads volume archive
VOL=$(docker volume ls -q | grep hms_uploads | head -1 || true)
if [ -n "$VOL" ]; then
  docker run --rm -v "$VOL":/u:ro -v "$BACKUP_DIR":/b alpine \
    tar czf "/b/uploads_$STAMP.tgz" -C /u . 2>/dev/null || true
fi

# 3) retention: delete older than 30 days
find "$BACKUP_DIR" -type f \( -name 'db_*.sql.gz' -o -name 'uploads_*.tgz' \) -mtime +30 -delete

echo "backup done: $STAMP"
