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
process.env.TELEGRAM_WEBHOOK_SECRET = 'hook-secret-test';

const pg = new EmbeddedPostgres({
  databaseDir: dataDir, user: 'hms_user', password: 'testpass', port: pgPort, persistent: false,
  initdbFlags: ['--locale=C', '--encoding=UTF8'], // Windows 한국어 로케일(UHC) 회피
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
  const sql2 = fs.readFileSync(new URL('../migrations/002_admin.sql', import.meta.url), 'utf8');
  await pool.query(sql2);
  const sql3 = fs.readFileSync(new URL('../migrations/003_push.sql', import.meta.url), 'utf8');
  await pool.query(sql3);
  const sql4 = fs.readFileSync(new URL('../migrations/004_study_earn.sql', import.meta.url), 'utf8');
  await pool.query(sql4);
  const { initPush } = await import('../src/push.js');
  await initPush();

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

  // --- v1.2.0: cancel own pending claim
  const r2 = await api('POST', '/api/earn-requests', { catalog_id: e1.id }, tokens.child, 200);
  await api('DELETE', `/api/earn-requests/${r2.id}`, null, tokens.child, 200);
  await api('DELETE', `/api/earn-requests/${r2.id}`, null, tokens.child, 404);

  // --- external app claim (ext_ref): duplicate blocked, cancel frees the slot
  const x1 = await api('POST', '/api/earn-requests',
    { catalog_id: e1.id, comment: '학습앱 세트#7', source_kind: 'study', ext_ref: 'set-7',
      meta: { total: 10, correct: 10, accuracy: 100 } }, tokens.child, 200);
  const xd = await api('POST', '/api/earn-requests',
    { catalog_id: e1.id, source_kind: 'study', ext_ref: 'set-7' }, tokens.child, 409);
  assert.equal(xd.error, 'duplicate_claim');
  const x8 = await api('POST', '/api/earn-requests',
    { catalog_id: e1.id, source_kind: 'study', ext_ref: 'set-8' }, tokens.child, 200); // 다른 세트는 OK
  await api('DELETE', `/api/earn-requests/${x8.id}`, null, tokens.child, 200);
  await api('DELETE', `/api/earn-requests/${x1.id}`, null, tokens.child, 200);
  const x2 = await api('POST', '/api/earn-requests',
    { catalog_id: e1.id, source_kind: 'study', ext_ref: 'set-7' }, tokens.child, 200); // 취소 후 재청구 OK
  await api('DELETE', `/api/earn-requests/${x2.id}`, null, tokens.child, 200);

  // --- v1.2.0: name + secret change
  await api('PATCH', '/api/me', { name: '아이2' }, tokens.child, 200);
  me = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(me.name, '아이2');
  await api('POST', '/api/auth/change-secret', { old_secret: '1234', new_secret: '9876' }, tokens.child, 200);
  await api('POST', '/api/auth/login', { login_id: 'c1', secret: '9876' }, null, 200);

  // --- v1.2.0: single-voucher use (buy one, use it whole)
  await api('POST', `/api/users/${childId}/adjust`, { amount: 80, memo: '충전' }, tokens.parent, 200);
  await api('POST', '/api/orders', { catalog_id: s1.id, qty: 1 }, tokens.child, 200);
  v = await api('GET', '/api/vouchers', null, tokens.child, 200);
  const target = v.vouchers.find((x) => x.status === 'active' && x.remaining_minutes === 30);
  const one = await api('POST', `/api/vouchers/${target.id}/use`, null, tokens.child, 200);
  assert.equal(one.used, 30);
  await api('POST', `/api/vouchers/${target.id}/use`, null, tokens.child, 404);

  // --- v1.2.0: family ledger for parent (adjust entries visible)
  const fled = await api('GET', '/api/ledger/family?source_type=adjust', null, tokens.parent, 200);
  assert.ok(fled.length >= 2);
  assert.ok(fled[0].user_name);
  await api('GET', '/api/ledger/family', null, tokens.child, 403);

  // --- v1.2.0: soft delete child
  await api('DELETE', `/api/users/${nc.id}`, null, tokens.parent, 200);
  const after = await api('GET', '/api/users', null, tokens.parent, 200);
  assert.ok(!after.find((u) => u.id === nc.id));
  await api('POST', '/api/auth/login', { login_id: 'c2', secret: '4321' }, null, 401);

  // --- v1.2.0: super_admin + family isolation
  await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash) VALUES (NULL,'adm','관리자','super_admin',$1)`,
    [await hashSecret('admin-pw-1')]);
  const al = await api('POST', '/api/auth/login', { login_id: 'adm', secret: 'admin-pw-1' }, null, 200);
  tokens.admin = al.token;
  const fams = await api('GET', '/api/admin/families', null, tokens.admin, 200);
  assert.equal(fams.length, 1);
  await api('GET', '/api/admin/families', null, tokens.parent, 403);
  // admin cannot use parent routes
  await api('GET', '/api/earn-requests', null, tokens.admin, 200); // list ok (empty family scope)
  await api('POST', '/api/catalog/earn', { name: 'x', points: 5 }, tokens.admin, 403);
  // create family B with parent
  const fb = await api('POST', '/api/admin/families', { name: 'B가족' }, tokens.admin, 200);
  await api('POST', `/api/admin/families/${fb.id}/users`,
    { login_id: 'pb', name: 'B부모', role: 'parent', secret: 'bparent1' }, tokens.admin, 200);
  const bl = await api('POST', '/api/auth/login', { login_id: 'pb', secret: 'bparent1' }, null, 200);
  // isolation: B parent sees nothing from A
  const bu = await api('GET', '/api/users', null, bl.token, 200);
  assert.equal(bu.length, 1);
  const be = await api('GET', '/api/catalog/earn', null, bl.token, 200);
  assert.equal(be.length, 0);
  const br = await api('GET', '/api/earn-requests', null, bl.token, 200);
  assert.equal(br.length, 0);
  // rename + delete family B
  await api('PATCH', `/api/admin/families/${fb.id}`, { name: 'B가족2' }, tokens.admin, 200);
  await api('DELETE', `/api/admin/families/${fb.id}`, null, tokens.admin, 200);
  await api('POST', '/api/auth/login', { login_id: 'pb', secret: 'bparent1' }, null, 401);

  // --- v1.3.0: web push subscription CRUD
  const vk = await api('GET', '/api/push/vapid-public-key', null, tokens.child, 200);
  assert.ok(vk.key && vk.key.length > 20);
  await api('POST', '/api/push/subscribe', {
    endpoint: 'https://push.example/ep1', keys: { p256dh: 'pk', auth: 'au' },
  }, tokens.child, 200);
  await api('POST', '/api/push/subscribe', { endpoint: 'x' }, tokens.child, 400);
  await api('POST', '/api/push/unsubscribe', { endpoint: 'https://push.example/ep1' }, tokens.child, 200);

  // --- v1.3.0: telegram webhook inline approval
  await pool.query(
    `INSERT INTO telegram_link (family_id, parent_user_id, chat_id)
     SELECT family_id, id, '9999' FROM app_user WHERE login_id = 'p1'`);
  const r3 = await api('POST', '/api/earn-requests', { catalog_id: e1.id }, tokens.child, 200);
  const meBefore = await api('GET', '/api/me', null, tokens.child, 200);
  // wrong secret rejected
  let res = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'wrong' },
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 403);
  // approve via callback
  res = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret-test' },
    body: JSON.stringify({
      callback_query: {
        id: 'cbq1', data: `er_ok:${r3.id}`,
        message: { message_id: 1, chat: { id: 9999 }, text: 'msg' },
      },
    }),
  });
  assert.equal(res.status, 200);
  const meAfter = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(meAfter.balance, meBefore.balance + 20);
  const decided = await api('GET', '/api/earn-requests?status=approved', null, tokens.parent, 200);
  assert.ok(decided.find((x) => x.id === r3.id));
  // duplicate callback -> no double credit
  await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret-test' },
    body: JSON.stringify({
      callback_query: { id: 'cbq2', data: `er_ok:${r3.id}`, message: { message_id: 1, chat: { id: 9999 }, text: 'msg' } },
    }),
  });
  const meAfter2 = await api('GET', '/api/me', null, tokens.child, 200);
  assert.equal(meAfter2.balance, meAfter.balance);

  // --- ask callback: 부모 채팅 버튼 선택이 app_config에 저장된다 (v1.4.2)
  res = await fetch(base + '/api/telegram/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'hook-secret-test' },
    body: JSON.stringify({
      callback_query: {
        id: 'cbq3', data: 'ask:q_test1:yes',
        message: { message_id: 2, chat: { id: 9999 }, text: 'question' },
      },
    }),
  });
  assert.equal(res.status, 200);
  {
    const { rows } = await pool.query(
      "SELECT value FROM app_config WHERE key = 'ask_answer_q_test1'");
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].value).choice, 'yes');
  }

  // --- consume silent/note 옵션 (v1.4.2): 파라미터 수용 + 정상 차감
  {
    await api('POST', `/api/users/${childId}/adjust`, { amount: 300, memo: '테스트 충전' }, tokens.parent, 200);
    const o2 = await api('POST', '/api/orders', { catalog_id: s1.id, qty: 1 }, tokens.child, 200);
    assert.equal(o2.status, 'fulfilled');
    const c1 = await api('POST', '/api/vouchers/consume',
      { minutes: 1, silent: true }, tokens.child, 200);
    assert.equal(c1.used, 1);
    const c2 = await api('POST', '/api/vouchers/consume',
      { minutes: 1, note: 'PC 사용 시작 — 10분 예약' }, tokens.child, 200);
    assert.equal(c2.used, 1);
  }

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
