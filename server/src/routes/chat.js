// family chat (v1.18.0): one room per family, text + photo, read position, presence-aware push
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { q } from '../db.js';
import { pushToUser } from '../push.js';

const MAX_TEXT = 500;
const PAGE = 100;                 // 이전 대화 로딩 단위
const INITIAL_DAYS = 10;          // 최초 로드: 최근 N일 (없으면 마지막 PAGE개)
const ACTIVE_WINDOW_SEC = 10;     // 이 시간 안에 채팅 화면을 본 사용자에겐 푸시 생략
const PUSH_BODY_MAX = 40;

const shape = (r) => ({
  id: Number(r.id),
  user_id: Number(r.user_id),
  user_name: r.user_name,
  kind: r.kind,
  content: r.deleted_at ? '' : r.content,
  image: r.deleted_at ? null : r.image,
  created_at: r.created_at,
  deleted: !!r.deleted_at,
});

const SELECT = `SELECT m.id, m.user_id, u.name AS user_name, m.kind, m.content, m.image, m.created_at, m.deleted_at
                FROM chat_message m JOIN app_user u ON u.id = m.user_id`;

export async function chatRoutes(app, opts) {
  const uploadDir = opts.uploadDir;

  async function touch(userId, familyId, markRead) {
    if (markRead) {
      await q(
        `INSERT INTO chat_read (user_id, last_read_id, seen_at)
         VALUES ($1, COALESCE((SELECT max(id) FROM chat_message WHERE family_id = $2), 0), now())
         ON CONFLICT (user_id) DO UPDATE
           SET last_read_id = GREATEST(chat_read.last_read_id, EXCLUDED.last_read_id), seen_at = now()`,
        [userId, familyId]);
    } else {
      await q(
        `INSERT INTO chat_read (user_id, seen_at) VALUES ($1, now())
         ON CONFLICT (user_id) DO UPDATE SET seen_at = now()`, [userId]);
    }
  }

  // messages
  //   (없음)            : 최초 로드 - 최근 10일, 없으면 마지막 100개
  //   ?before=ID        : ID 이전 100개 (위로 스크롤)
  //   ?since=ID         : ID 이후 신규 (폴링) + 최근 삭제 id 목록
  //   &active=1         : 채팅 화면을 보고 있음 → 접속 시각 갱신 + 전부 읽음 처리
  app.get('/chat/messages', { onRequest: app.authRequired }, async (req) => {
    const fam = req.user.family_id;
    const active = req.query.active === '1';
    let rows; let hasMore = false; let deleted = [];

    if (req.query.since !== undefined) {
      const since = Number(req.query.since) || 0;
      ({ rows } = await q(
        `${SELECT} WHERE m.family_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT ${PAGE}`, [fam, since]));
      const d = await q(
        `SELECT id FROM chat_message WHERE family_id = $1 AND id <= $2
           AND deleted_at IS NOT NULL AND deleted_at > now() - interval '60 seconds'`, [fam, since]);
      deleted = d.rows.map((r) => Number(r.id));
    } else if (req.query.before !== undefined) {
      const before = Number(req.query.before) || 0;
      ({ rows } = await q(
        `${SELECT} WHERE m.family_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT ${PAGE + 1}`, [fam, before]));
      hasMore = rows.length > PAGE;
      rows = rows.slice(0, PAGE).reverse();
    } else {
      ({ rows } = await q(
        `${SELECT} WHERE m.family_id = $1 AND m.created_at > now() - interval '${INITIAL_DAYS} days'
         ORDER BY m.id ASC`, [fam]));
      if (!rows.length) {
        ({ rows } = await q(
          `${SELECT} WHERE m.family_id = $1 ORDER BY m.id DESC LIMIT ${PAGE}`, [fam]));
        rows.reverse();
      }
      if (rows.length) {
        const older = await q(
          `SELECT 1 FROM chat_message WHERE family_id = $1 AND id < $2 LIMIT 1`, [fam, rows[0].id]);
        hasMore = older.rows.length > 0;
      }
    }

    if (active) await touch(req.user.sub, fam, true);

    const out = { rows: rows.map(shape), has_more: hasMore };
    if (deleted.length) out.deleted = deleted;
    return out;
  });

  // unread count for the tab badge (내가 보낸 것·삭제된 것 제외)
  app.get('/chat/unread', { onRequest: app.authRequired }, async (req) => {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM chat_message m
       WHERE m.family_id = $1 AND m.user_id <> $2 AND m.deleted_at IS NULL
         AND m.id > COALESCE((SELECT last_read_id FROM chat_read WHERE user_id = $2), 0)`,
      [req.user.family_id, req.user.sub]);
    return { count: rows[0].n };
  });

  // send: JSON {content} 또는 multipart(photo + content)
  app.post('/chat/messages', { onRequest: app.authRequired }, async (req, reply) => {
    let content = ''; let image = null;

    if (req.isMultipart()) {
      for await (const part of req.parts()) {
        if (part.type === 'file' && part.fieldname === 'photo') {
          if (image) { await part.toBuffer(); continue; }
          const ext = (path.extname(part.filename || '') || '.jpg').toLowerCase().slice(0, 8);
          const fname = `chat_${Date.now()}_${randomBytes(6).toString('hex')}${ext}`;
          await fs.promises.writeFile(path.join(uploadDir, fname), await part.toBuffer());
          image = fname;
        } else if (part.type === 'field' && part.fieldname === 'content') {
          content = String(part.value).trim().slice(0, MAX_TEXT);
        }
      }
    } else {
      content = String((req.body && req.body.content) || '').trim().slice(0, MAX_TEXT);
    }
    if (!content && !image) return reply.code(400).send({ error: 'message_required' });
    const kind = image ? 'photo' : 'text';

    const fam = req.user.family_id;
    const { rows } = await q(
      `INSERT INTO chat_message (family_id, user_id, kind, content, image)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
      [fam, req.user.sub, kind, content, image]);
    const id = Number(rows[0].id);

    // 보낸 사람은 자기 메시지까지 읽음 처리
    await q(
      `INSERT INTO chat_read (user_id, last_read_id, seen_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO UPDATE
         SET last_read_id = GREATEST(chat_read.last_read_id, EXCLUDED.last_read_id), seen_at = now()`,
      [req.user.sub, id]);

    // 푸시: 가족 중 본인 제외, 최근 10초 내 채팅 화면을 보고 있던 사람 제외
    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    const targets = await q(
      `SELECT u.id FROM app_user u
       LEFT JOIN chat_read r ON r.user_id = u.id
       WHERE u.family_id = $1 AND u.active AND u.id <> $2
         AND (r.seen_at IS NULL OR r.seen_at < now() - interval '${ACTIVE_WINDOW_SEC} seconds')`,
      [fam, req.user.sub]);
    let body = content ? content.replace(/\s+/g, ' ') : '📷 사진을 보냈어요';
    if (body.length > PUSH_BODY_MAX) body = `${body.slice(0, PUSH_BODY_MAX)}…`;
    const payload = { title: who.rows[0].name, body, url: '/?tab=chat', tag: 'chat' };
    for (const r of targets.rows) pushToUser(r.id, payload, req.log);

    return {
      id, user_id: Number(req.user.sub), user_name: who.rows[0].name,
      kind, content, image, created_at: rows[0].created_at, deleted: false,
    };
  });

  // delete (본인 또는 부모) - 소프트 삭제, 사진 파일은 제거
  app.delete('/chat/messages/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rows } = await q(
      `SELECT id, user_id, image, deleted_at FROM chat_message WHERE id = $1 AND family_id = $2`,
      [req.params.id, req.user.family_id]);
    if (!rows[0] || rows[0].deleted_at) return reply.code(404).send({ error: 'not_found' });
    const isAuthor = Number(rows[0].user_id) === Number(req.user.sub);
    const isParent = req.user.role === 'parent' || req.user.role === 'super_admin';
    if (!isAuthor && !isParent) return reply.code(403).send({ error: 'forbidden' });

    await q(`UPDATE chat_message SET deleted_at = now(), content = '', image = NULL WHERE id = $1`, [rows[0].id]);
    if (rows[0].image) fs.promises.unlink(path.join(uploadDir, rows[0].image)).catch(() => {});
    return { ok: true };
  });
}
