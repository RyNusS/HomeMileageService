#!/usr/bin/env bash
# HMS deploy v1.3.0 (run on server). Bundle at /tmp/hms_deploy.tgz
set -euo pipefail
cd ~/stacks
TS=$(date +%Y%m%d%H%M%S)
if [ -d hms ]; then cp -a hms "hms.bak.$TS"; fi
tar xzf /tmp/hms_deploy.tgz -C ~/stacks
touch hms.env && chmod 600 hms.env
grep -q '^JWT_SECRET=' hms.env || echo "JWT_SECRET=$(openssl rand -hex 32)" >> hms.env
grep -q '^DB_HOST=' hms.env || echo "DB_HOST=postgres" >> hms.env
grep -q '^DB_PORT=' hms.env || echo "DB_PORT=5432" >> hms.env
grep -q '^DB_NAME=' hms.env || echo "DB_NAME=hms" >> hms.env
grep -q '^DB_USER=' hms.env || echo "DB_USER=hms_user" >> hms.env
grep -q '^DB_PASS=' hms.env || echo "DB_PASS=$(grep '^POSTGRES_PASSWORD=' hms.env | cut -d= -f2-)" >> hms.env
grep -q '^UPLOAD_DIR=' hms.env || echo "UPLOAD_DIR=/data/uploads" >> hms.env
grep -q '^APP_VERSION=' hms.env && sed -i 's/^APP_VERSION=.*/APP_VERSION=1.3.0/' hms.env || echo "APP_VERSION=1.3.0" >> hms.env
grep -q '^SEED_FAMILY=' hms.env || echo "SEED_FAMILY=우리집" >> hms.env
grep -q '^SEED_PARENT_ID=' hms.env || echo "SEED_PARENT_ID=parent" >> hms.env
grep -q '^SEED_PARENT_NAME=' hms.env || echo "SEED_PARENT_NAME=부모" >> hms.env
grep -q '^SEED_PARENT_PW=' hms.env || echo "SEED_PARENT_PW=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)" >> hms.env
grep -q '^SEED_CHILD_ID=' hms.env || echo "SEED_CHILD_ID=child1" >> hms.env
grep -q '^SEED_CHILD_NAME=' hms.env || echo "SEED_CHILD_NAME=자녀1" >> hms.env
grep -q '^SEED_CHILD_PIN=' hms.env || echo "SEED_CHILD_PIN=1234" >> hms.env
grep -q '^SEED_ADMIN_ID=' hms.env || echo "SEED_ADMIN_ID=admin" >> hms.env
DOMAIN=$(grep '^HMS_DOMAIN=' hms.env | cut -d= -f2-)
grep -q '^PUBLIC_URL=' hms.env || echo "PUBLIC_URL=https://$DOMAIN" >> hms.env
grep -q '^TELEGRAM_WEBHOOK_SECRET=' hms.env || echo "TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)" >> hms.env
grep -q '^SEED_ADMIN_PW=' hms.env || echo "SEED_ADMIN_PW=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)" >> hms.env

docker compose --env-file hms.env build hms-api 2>&1 | tail -2
# force-recreate so env_file changes are always picked up (telegram token fix)
docker compose --env-file hms.env up -d --force-recreate hms-api caddy 2>&1 | tail -3
sleep 4
docker compose --env-file hms.env exec -T hms-api node scripts/migrate.js
docker compose --env-file hms.env exec -T hms-api node scripts/seed.js
docker compose --env-file hms.env exec -T hms-api node scripts/seed-admin.js
docker compose --env-file hms.env exec -T hms-api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>console.log('HEALTH', JSON.stringify(j)))"
echo "TELEGRAM_IN_CONTAINER=$(docker exec hms-api sh -c 'test -n "$TELEGRAM_BOT_TOKEN" && echo yes || echo no')"

# ── backup: daily 01:00, 30-day retention (idempotent install) ──
sudo cp ~/stacks/backup/hms-backup.sh /usr/local/bin/hms-backup.sh
sudo chmod 755 /usr/local/bin/hms-backup.sh
sudo cp ~/stacks/backup/hms-backup.service /etc/systemd/system/
sudo cp ~/stacks/backup/hms-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now hms-backup.timer
echo "TIMEZONE=$(timedatectl show -p Timezone --value)"
sudo systemctl list-timers hms-backup.timer --no-pager | head -3

# ── telegram webhook (inline approve buttons) ──
TG_TOKEN=$(grep '^TELEGRAM_BOT_TOKEN=' hms.env | cut -d= -f2-)
TG_SECRET=$(grep '^TELEGRAM_WEBHOOK_SECRET=' hms.env | cut -d= -f2-)
if [ -n "$TG_TOKEN" ] && [ -n "$DOMAIN" ]; then
  curl -s "https://api.telegram.org/bot$TG_TOKEN/setWebhook" \
    -d "url=https://$DOMAIN/api/telegram/webhook" \
    -d "secret_token=$TG_SECRET" \
    -d 'allowed_updates=["callback_query"]' \
    -d "drop_pending_updates=true" | grep -o '"ok":[a-z]*' | sed 's/^/WEBHOOK_SET /'
  curl -s "https://api.telegram.org/bot$TG_TOKEN/getWebhookInfo" | grep -o '"url":"[^"]*"' | sed 's/^/WEBHOOK_INFO /'
fi

echo DEPLOY_DONE
