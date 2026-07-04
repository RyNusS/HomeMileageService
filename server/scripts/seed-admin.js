// Create the super_admin account if missing.
// env: SEED_ADMIN_ID (default 'admin'), SEED_ADMIN_PW (required)
import { pool } from '../src/db.js';
import { hashSecret } from '../src/hash.js';

const ID = (process.env.SEED_ADMIN_ID || 'admin').toLowerCase();
const PW = process.env.SEED_ADMIN_PW;

async function main() {
  if (!PW) throw new Error('SEED_ADMIN_PW env required');
  const exists = await pool.query('SELECT id FROM app_user WHERE login_id = $1', [ID]);
  if (exists.rows[0]) { console.log('seed-admin: already exists'); return pool.end(); }
  await pool.query(
    `INSERT INTO app_user (family_id, login_id, name, role, secret_hash)
     VALUES (NULL, $1, $2, 'super_admin', $3)`,
    [ID, '관리자', await hashSecret(PW)]);
  console.log(`seed-admin done: ${ID}`);
  await pool.end();
}
main().catch((err) => { console.error(err); process.exit(1); });
