// earn/spend catalog CRUD (parent manages, child reads active items)
import { q } from '../db.js';

export async function catalogRoutes(app) {
  app.get('/catalog/earn', { onRequest: app.authRequired }, async (req) => {
    const activeOnly = req.user.role === 'child';
    const { rows } = await q(
      `SELECT id, name, points, proof_required, active, sort FROM earn_catalog
       WHERE family_id = $1 ${activeOnly ? 'AND active' : ''}
       ORDER BY sort, id`, [req.user.family_id]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  app.get('/catalog/spend', { onRequest: app.authRequired }, async (req) => {
    const activeOnly = req.user.role === 'child';
    const { rows } = await q(
      `SELECT id, name, kind, unit_minutes, unit_label, price_points, active, sort
       FROM spend_catalog
       WHERE family_id = $1 ${activeOnly ? 'AND active' : ''}
       ORDER BY sort, id`, [req.user.family_id]);
    return rows.map((r) => ({ ...r, id: Number(r.id) }));
  });

  app.post('/catalog/earn', { onRequest: app.parentOnly }, async (req, reply) => {
    const { name, points, proof_required = false, sort = 0 } = req.body || {};
    if (!name || !Number.isInteger(Number(points)) || Number(points) <= 0) {
      return reply.code(400).send({ error: 'bad_fields' });
    }
    const { rows } = await q(
      `INSERT INTO earn_catalog (family_id, name, points, proof_required, sort)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [req.user.family_id, name, Number(points), Boolean(proof_required), Number(sort) || 0]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/catalog/earn/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const b = req.body || {};
    const { rowCount } = await q(
      `UPDATE earn_catalog SET
         name = COALESCE($1, name),
         points = COALESCE($2, points),
         proof_required = COALESCE($3, proof_required),
         active = COALESCE($4, active),
         sort = COALESCE($5, sort)
       WHERE id = $6 AND family_id = $7`,
      [b.name ?? null, b.points ?? null, b.proof_required ?? null,
       b.active ?? null, b.sort ?? null, req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });

  app.post('/catalog/spend', { onRequest: app.parentOnly }, async (req, reply) => {
    const { name, kind, unit_minutes, unit_label, price_points, sort = 0 } = req.body || {};
    if (!name || !['time_voucher', 'cash'].includes(kind)) return reply.code(400).send({ error: 'bad_fields' });
    if (!Number.isInteger(Number(price_points)) || Number(price_points) <= 0) return reply.code(400).send({ error: 'bad_fields' });
    if (kind === 'time_voucher' && (!Number.isInteger(Number(unit_minutes)) || Number(unit_minutes) <= 0)) {
      return reply.code(400).send({ error: 'unit_minutes_required' });
    }
    const { rows } = await q(
      `INSERT INTO spend_catalog (family_id, name, kind, unit_minutes, unit_label, price_points, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [req.user.family_id, name, kind,
       kind === 'time_voucher' ? Number(unit_minutes) : null,
       unit_label || null, Number(price_points), Number(sort) || 0]);
    return { id: Number(rows[0].id) };
  });

  app.patch('/catalog/spend/:id', { onRequest: app.parentOnly }, async (req, reply) => {
    const b = req.body || {};
    const { rowCount } = await q(
      `UPDATE spend_catalog SET
         name = COALESCE($1, name),
         unit_minutes = COALESCE($2, unit_minutes),
         unit_label = COALESCE($3, unit_label),
         price_points = COALESCE($4, price_points),
         active = COALESCE($5, active),
         sort = COALESCE($6, sort)
       WHERE id = $7 AND family_id = $8`,
      [b.name ?? null, b.unit_minutes ?? null, b.unit_label ?? null,
       b.price_points ?? null, b.active ?? null, b.sort ?? null,
       req.params.id, req.user.family_id]);
    if (!rowCount) return reply.code(404).send({ error: 'not_found' });
    return { ok: true };
  });
}
