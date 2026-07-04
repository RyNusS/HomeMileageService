// Smoke: embedded pg -> scripts/migrate.js + scripts/seed.js (child procs) -> API up -> login
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';

const pgPort = 55433;
const env = {
  ...process.env,
  DB_HOST: '127.0.0.1', DB_PORT: String(pgPort), DB_NAME: 'hms',
  DB_USER: 'hms_user', DB_PASS: 'testpass',
  JWT_SECRET: 'smoke-secret', UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), 'up-')),
  PORT: '3999', SEED_PARENT_PW: 'parent-pw-1', SEED_TELEGRAM_CHAT_ID: '',
};
const pg = new EmbeddedPostgres({
  databaseDir: mkdtempSync(path.join(tmpdir(), 'pg-')),
  user: 'hms_user', password: 'testpass', port: pgPort, persistent: false,
});
await pg.initialise(); await pg.start(); await pg.createDatabase('hms');

execFileSync('node', ['scripts/migrate.js'], { env, stdio: 'inherit' });
execFileSync('node', ['scripts/seed.js'], { env, stdio: 'inherit' });
execFileSync('node', ['scripts/migrate.js'], { env, stdio: 'inherit' }); // idempotent
execFileSync('node', ['scripts/seed.js'], { env, stdio: 'inherit' });    // idempotent

const srv = spawn('node', ['src/index.js'], { env, stdio: 'pipe' });
await new Promise((r) => setTimeout(r, 1500));

const h = await (await fetch('http://127.0.0.1:3999/api/health')).json();
console.log('health:', h.status, h.version);
const login = await (await fetch('http://127.0.0.1:3999/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login_id: 'parent', secret: 'parent-pw-1' }),
})).json();
console.log('parent login:', login.user ? 'OK ' + login.user.name : 'FAIL');
const clogin = await (await fetch('http://127.0.0.1:3999/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ login_id: 'child1', secret: '1234' }),
})).json();
console.log('child login:', clogin.user ? 'OK ' + clogin.user.name : 'FAIL');
const cat = await (await fetch('http://127.0.0.1:3999/api/catalog/spend', {
  headers: { authorization: `Bearer ${clogin.token}` },
})).json();
console.log('spend catalog items:', cat.length);

srv.kill();
await pg.stop();
console.log(login.user && clogin.user && cat.length >= 4 ? 'SMOKE PASSED' : 'SMOKE FAILED');
process.exit(login.user && clogin.user && cat.length >= 4 ? 0 : 1);
