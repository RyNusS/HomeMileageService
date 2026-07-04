// Seed a family with parent/child accounts and default catalogs.
// Usage (env): SEED_FAMILY=우리집 SEED_PARENT_ID=parent SEED_PARENT_PW=... \
//              SEED_CHILD_ID=child1 SEED_CHILD_NAME=아이 SEED_CHILD_PIN=1234 node scripts/seed.js
import { pool } from '../src/db.js';
import { hashSecret } from '../src/hash.js';

const FAMILY = process.env.SEED_FAMILY || '우리집';
const P_ID = (process.env.SEED_PARENT_ID || 'parent').toLowerCase();
const P_NAME = process.env.SEED_PARENT_NAME || '부모';
const P_PW = process.env.SEED_PARENT_PW;
const C_ID = (process.env.SEED_CHILD_ID || 'child1').toLowerCase();
const C_NAME = process.env.SEED_CHILD_NAME || '자녀1';
const C_PIN = process.env.SEED_CHILD_PIN || '1234';
const CHAT_ID = process.env.SEED_TELEGRAM_CHAT_ID;

async function main() {
  if (!P_PW) throw new Error('SEED_PARENT_PW env required');
  await pool.query('SET search_path TO hms');

  const exists = await pool.query('SELECT id FROM app_user WHERE login_id = $1', [P_ID]);
  if (exists.rows[0]) { console.log('seed: parent already exists, skipping'); return pool.end(); }

  const fam = await pool.query(
    'INSERT INTO family (name) VALUES ($1) RETURNING id', [FAMILY]);
  const familyId = fam.rows[0].id;

  const parent = await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash)
     VALUES ($1, $2, $3, 'parent', $4) RETURNING id`,
    [familyId, P_ID, P_NAME, await hashSecret(P_PW)]);

  await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash)
     VALUES ($1, $2, $3, 'child', $4)`,
    [familyId, C_ID, C_NAME, await hashSecret(C_PIN)]);

  if (CHAT_ID) {
    await pool.query(
      `INSERT INTO telegram_link (family_id, parent_user_id, chat_id) VALUES ($1, $2, $3)`,
      [familyId, parent.rows[0].id, CHAT_ID]);
  }

  const earns = [
    ['학교 숙제 완료', 20, false], ['한 줄 일기', 20, true],
    ['심부름', 30, false], ['방 정리', 20, false], ['책 30분 읽기', 30, false],
  ];
  for (const [name, points, proof] of earns) {
    await pool.query(
      `INSERT INTO earn_catalog (family_id, name, points, proof_required) VALUES ($1,$2,$3,$4)`,
      [familyId, name, points, proof]);
  }
  const spends = [
    ['휴대폰 30분권', 'time_voucher', 30, null, 60],
    ['PC 30분권', 'time_voucher', 30, null, 60],
    ['게임기 30분권', 'time_voucher', 30, null, 80],
    ['용돈 1,000원', 'cash', null, '1000won', 100],
  ];
  for (const [name, kind, mins, label, price] of spends) {
    await pool.query(
      `INSERT INTO spend_catalog (family_id, name, kind, unit_minutes, unit_label, price_points)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [familyId, name, kind, mins, label, price]);
  }
  console.log(`seed done: family=${FAMILY} parent=${P_ID} child=${C_ID}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
