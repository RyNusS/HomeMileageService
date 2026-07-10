// super_admin: family group management + accounts in any family
import { q, tx } from '../db.js';
import { hashSecret } from '../hash.js';

export async function adminRoutes(app) {
  const guard = { onRequest: app.adminOnly };

  app.get('/admin/families', guard, async () => {
    const { rows } = await q(
      `SELECT f.id, f.name, f.created_at,
              count(u.id) FILTER (WHERE u.active) AS member_count
       FROM family f LEFT JOIN app_user u ON u.family_id = f.id
       GROUP BY f.id ORDER BY f.id`);
    return rows.map((r) => ({
      id: Number(r.id), name: r.name, created_at: r.created_at,
      member_count: Number(r.member_count),
    }));
  });

  app.post('/admin/families', guard, async (req, reply) => {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'bad_fields' });
    const { rows } = await q('INSERT INTO family (name) VALUES ($1) RETURNING id', [name]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/admin/families/:id', guard, async (req, reply) => {
    const name = (req.body && req.body.name || '').trim();
    if (!name) return reply.code(400).send({ error: 'bad_fields' });
    const { rowCount } = await q('UPDATE family SET name = $1 WHERE id = $2', [name, req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // delete family and ALL its data (irreversible)
  app.delete('/admin/families/:id', guard, async (req, reply) => {
    const fid = req.params.id;
    const done = await tx(async (c) => {
      const f = await c.query('SELECT id FROM family WHERE id = $1', [fid]);
      if (!f.rows[0]) return false;
      await c.query('DELETE FROM voucher_usage WHERE voucher_id IN (SELECT id FROM voucher WHERE family_id = $1)', [fid]);
      await c.query('DELETE FROM voucher WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM spend_order WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM earn_request WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM ledger_entry WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM spend_catalog WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM earn_catalog WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM telegram_link WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM app_user WHERE family_id = $1', [fid]);
      await c.query('DELETE FROM family WHERE id = $1', [fid]);
      return true;
    });
    if (!done) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.get('/admin/families/:id/users', guard, async (req) => {
    const { rows } = await q(
      `SELECT id, login_id, name, role, balance_cache, active
       FROM app_user WHERE family_id = $1 ORDER BY role DESC, id`, [req.params.id]);
    return rows.map((r) => ({
      id: Number(r.id), login_id: r.login_id, name: r.name, role: r.role,
      balance: r.balance_cache, active: r.active,
    }));
  });

  // create account (parent or child) in a family
  app.post('/admin/families/:id/users', guard, async (req, reply) => {
    const { login_id, name, role, secret } = req.body || {};
    if (!login_id || !name || !secret || !['parent', 'child'].includes(role)) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    const lid = String(login_id).trim().toLowerCase();
    if (!/^[a-z0-9_-]{2,20}$/.test(lid)) return reply.code(400).send({ error: 'bad_login_id' });
    if (role === 'child' && !/^[0-9]{4,6}$/.test(String(secret))) {
      return reply.code(400).send({ error: 'pin_must_be_4_6_digits' });
    }
    if (role === 'parent' && String(secret).length < 6) {
      return reply.code(400).send({ error: 'password_too_short' });
    }
    const fam = await q('SELECT id FROM family WHERE id = $1', [req.params.id]);
    if (!fam.rows[0]) return reply.code(404).send({ error: 'family_not_found' });
    try {
      const { rows } = await q(
        `INSERT INTO app_user (family_id, login_id, name, role, secret_hash)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [req.params.id, lid, name, role, await hashSecret(secret)]);
      return { id: Number(rows[0].id) };
    } catch (err) {
      if (err.code === '23505') return reply.code(409).send({ error: 'login_id_taken' });
      throw err;
    }
  });

  app.post('/admin/users/:id/reset-secret', guard, async (req, reply) => {
    const { secret } = req.body || {};
    if (!secret || String(secret).length < 4) return reply.code(400).send({ error: 'bad_fields' });
    const { rowCount } = await q(
      `UPDATE app_user SET secret_hash = $1 WHERE id = $2 AND role <> 'super_admin'`,
      [await hashSecret(secret), req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // 비활성화 / 재활성화 (soft)
  app.post('/admin/users/:id/deactivate', guard, async (req, reply) => {
    const { rowCount } = await q(
      `UPDATE app_user SET active = FALSE WHERE id = $1 AND role <> 'super_admin'`,
      [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/admin/users/:id/activate', guard, async (req, reply) => {
    const { rowCount } = await q(
      `UPDATE app_user SET active = TRUE WHERE id = $1 AND role <> 'super_admin'`,
      [req.params.id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  // 계정 완전 삭제 — 해당 계정의 모든 기록 포함 (되돌릴 수 없음)
  app.delete('/admin/users/:id', guard, async (req, reply) => {
    const uid = req.params.id;
    const done = await tx(async (c) => {
      const u = await c.query(
        `SELECT id FROM app_user WHERE id = $1 AND role <> 'super_admin'`, [uid]);
      if (!u.rows[0]) return false;
      // 다른 행이 이 계정을 참조하는 컬럼은 NULL 처리 (처리자 기록)
      await c.query('UPDATE earn_request SET decided_by = NULL WHERE decided_by = $1', [uid]);
      await c.query('UPDATE spend_order SET settled_by = NULL WHERE settled_by = $1', [uid]);
      // 본인 소유 데이터 삭제
      await c.query('DELETE FROM voucher_usage WHERE voucher_id IN (SELECT id FROM voucher WHERE user_id = $1)', [uid]);
      await c.query('DELETE FROM voucher WHERE user_id = $1', [uid]);
      await c.query('DELETE FROM spend_order WHERE user_id = $1', [uid]);
      await c.query('DELETE FROM earn_request WHERE user_id = $1', [uid]);
      await c.query('DELETE FROM ledger_entry WHERE user_id = $1', [uid]);
      await c.query('DELETE FROM push_subscription WHERE user_id = $1', [uid]);
      await c.query('DELETE FROM telegram_link WHERE parent_user_id = $1', [uid]);
      await c.query('DELETE FROM app_user WHERE id = $1', [uid]);
      return true;
    });
    if (!done) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
