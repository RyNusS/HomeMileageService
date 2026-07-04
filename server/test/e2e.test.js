// E2E: embedded Postgres -> migrate -> seed -> full mileage flow via HTTP
import assert from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';

const dataDir = mkdtempSync(path.join(tmpdir(), 'hmspg-'));
const pgPort = 55432;

process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = String(pgPort);
process.env.DB_NAME = 'hms';
process.env.DB_USER = 'hms_user';
process.env.DB_PASS = 'testpass';
process.env.JWT_SECRET = 'test-secret';
process.env.UPLOAD_DIR = mkdtempSync(path.join(tmpdir(), 'hmsup-'));
process.env.TELEGRAM_BOT_TOKEN = '';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'hms_user', password: 'testpass', port: pgPort, persistent: false,
});

let app;
let base;
const tokens = {};

async function api(method, url, body, token, expectStatus) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (expectStatus) assert.equal(res.status, expectStatus, `${method} ${url} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function main() {
  console.log('starting embedded postgres...');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('hms');

  // migrate + seed (same process, dynamic import after env set)
  const { pool } = await import('../src/db.js');
  const fs = await import('node:fs');
  const sql = fs.readFileSync(new URL('../migrations/001_phase1.sql', import.meta.url), 'utf8');
  await pool.query(sql);

  const { hashSecret } = await import('../src/hash.js');
  await pool.query('SET search_path TO hms');
  const fam = await pool.query(`INSERT INTO family (name) VALUES ('테스트가족') RETURNING id`);
  const famId = fam.rows[0].id;
  await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash) VALUES ($1,'p1','아빠','parent',$2)`,
    [famId, await hashSecret('parentpw')]);
  await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash) VALUES ($1,'c1','아이','child',$2)`,
    [famId, await hashSecret('1234')]);

  const { buildApp } = await import('../src/index.js');
  app = buildApp();
  await app.listen({ host: '127.0.0.1', port: 0 });
  base = `http://127.0.0.1:${app.server.address().port}`;

  // --- health
  const h = await api('GET', '/api/health', null, null, 200);
  assert.equal(h.status, 'ok');

  // --- login
  const pl = await api('POST', '/api/auth/login', { login_id: 'p1', secret: 'parentpw' }, null, 200);
  tokens.parent = pl.token;
  const cl = await api('POST', '/api/auth/login', { login_id: 'c1', secret: '1234' }, null, 200);
  tokens.child = cl.token;
  await api('POST', '/api/auth/login', { login_id: 'c1', secret: '9999' }, null, 401);

  // --- catalogs (parent creates)
  const e1 = await api('POST', '/api/catalog/earn', { name: '숙제', points: 20 }, tokens.parent, 200);
  await api('POST', '/api/catalog/earn', { name: '일기', points: 10 }, tokens.parent, 200);
  const s1 = await api('POST', '/api/catalog/spend',
    { name: '게임 30분권', kind: 'time_voucher', unit_minutes: 30, price_points: 80 }, tokens.parent, 200);
  const s2 = await api('POST', '/api/catalog/spend',
    { name: '용돈 1000원', kind: 'cash', price_points: 100 }, tokens.parent, 200);
  // child cannot create
  await api('POST', '/api/catalog/earn', { name: 'x', points: 5 }, tokens.child, 403);

  // --- earn claim -> approve
  const r1 = await api('POST', '/api/earn-requests', { catalog_id: e1.id, comment: '수학 끝' }, tokens.child, 200);
  let pending = await api('GET', '/api/earn-requests?status=pending', null, tokens.parent, 200);
  assert.equal(pending.length, 1);
  await api('POST', `/api/earn-requests/${r1.id}/approve`, null, tokens.parent, 200);
  await api('POST', `/api/earn-requests/${r1.id}/approve`, null, tokens.parent, 409);
  let me = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(me.balance, 20);

  // more points via approvals + adjust
  const users = await api('GET', '/api/users', null, tokens.parent, 200);
  const childId = users.find((u) => u.role === 'child').id;
  await api('POST', `/api/users/${childId}/adjust`, { amount: 300, memo: '보너스' }, tokens.parent, 200);
  me = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(me.balance, 320);

  // --- buy 3 vouchers (240P) -> stock 90 min
  const o1 = await api('POST', '/api/orders', { catalog_id: s1.id, qty: 3 }, tokens.child, 200);
  assert.equal(o1.status, 'fulfilled');
  me = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(me.balance, 80);
  let v = await api('GET', '/api/vouchers', null, tokens.child, 200);
  assert.equal(v.remaining_minutes, 90);
  assert.equal(v.vouchers.filter((x) => x.status === 'active').length, 3);

  // --- consume 70 min across vouchers (FIFO, partial)
  const cns = await api('POST', '/api/vouchers/consume', { minutes: 70 }, tokens.child, 200);
  assert.equal(cns.remaining, 20);
  v = await api('GET', '/api/vouchers', null, tokens.child, 200);
  assert.equal(v.remaining_minutes, 20);
  assert.equal(v.vouchers.filter((x) => x.status === 'consumed').length, 2);
  // over-consume rejected
  await api('POST', '/api/vouchers/consume', { minutes: 21 }, tokens.child, 400);

  // --- insufficient balance rejected
  await api('POST', '/api/orders', { catalog_id: s1.id, qty: 3 }, tokens.child, 400);

  // --- cash payout flow: 80P remains, price 100 -> reject; adjust +20 then buy
  await api('POST', `/api/users/${childId}/adjust`, { amount: 20, memo: '채움' }, tokens.parent, 200);
  const o2 = await api('POST', '/api/orders', { catalog_id: s2.id, qty: 1 }, tokens.child, 200);
  assert.equal(o2.status, 'payout_pending');
  me = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(me.balance, 0);
  await api('POST', `/api/orders/${o2.orderId}/settle`, null, tokens.parent, 200);
  const orders = await api('GET', '/api/orders', null, tokens.child, 200);
  assert.equal(orders[0].status, 'settled');

  // --- ledger consistency: sum(ledger) == balance_cache
  const led = await api('GET', '/api/ledger', null, tokens.child, 200);
  const sum = led.reduce((s, r) => s + r.amount, 0);
  assert.equal(sum, 0);

  // --- child account mgmt
  const nc = await api('POST', '/api/users', { login_id: 'c2', name: '둘째', pin: '5678' }, tokens.parent, 200);
  await api('POST', `/api/users/${nc.id}/reset-pin`, { pin: '4321' }, tokens.parent, 200);
  await api('POST', '/api/auth/login', { login_id: 'c2', secret: '4321' }, null, 200);

  console.log('ALL E2E TESTS PASSED');
}

main()
  .then(async () => {
    await app.close();
    const { pool } = await import('../src/db.js');
    await pool.end();
    await pg.stop();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('E2E FAILED:', err);
    try {
      if (app) await app.close();
      const { pool } = await import('../src/db.js');
      await pool.end();
      await pg.stop();
    } catch {}
    process.exit(1);
  });
