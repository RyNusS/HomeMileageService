#!/usr/bin/env bash
# HMS Phase 1 deploy (run on server). Bundle at /tmp/hms_deploy.tgz
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
grep -q '^APP_VERSION=' hms.env || echo "APP_VERSION=1.1.0" >> hms.env
sed -i 's/^APP_VERSION=.*/APP_VERSION=1.1.0/' hms.env
grep -q '^SEED_FAMILY=' hms.env || echo "SEED_FAMILY=우리집" >> hms.env
grep -q '^SEED_PARENT_ID=' hms.env || echo "SEED_PARENT_ID=parent" >> hms.env
grep -q '^SEED_PARENT_NAME=' hms.env || echo "SEED_PARENT_NAME=부모" >> hms.env
grep -q '^SEED_PARENT_PW=' hms.env || echo "SEED_PARENT_PW=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)" >> hms.env
grep -q '^SEED_CHILD_ID=' hms.env || echo "SEED_CHILD_ID=child1" >> hms.env
grep -q '^SEED_CHILD_NAME=' hms.env || echo "SEED_CHILD_NAME=자녀1" >> hms.env
grep -q '^SEED_CHILD_PIN=' hms.env || echo "SEED_CHILD_PIN=1234" >> hms.env
docker compose --env-file hms.env build hms-api 2>&1 | tail -3
docker compose --env-file hms.env up -d 2>&1 | tail -5
sleep 4
docker compose --env-file hms.env exec -T hms-api node scripts/migrate.js
docker compose --env-file hms.env exec -T hms-api node scripts/seed.js
docker compose --env-file hms.env exec -T hms-api node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(j=>console.log('HEALTH', JSON.stringify(j)))"
echo "SEEDED_PARENT_PW=$(grep '^SEED_PARENT_PW=' hms.env | cut -d= -f2-)"
echo "TELEGRAM_SET=$(grep -c '^TELEGRAM_BOT_TOKEN=..' hms.env || true)"
echo DEPLOY_DONE
