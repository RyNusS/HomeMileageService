// 채팅 (v1.20.0): 방 두 개 - 가족 공용 방 + 사용자별 AI 1:1 방
//   v1.18.0 의 가족 채팅(텍스트/사진, 읽음 위치, 접속 인지 푸시)에 AI 방을 얹었다.
//   AI 방은 소유자 본인만 볼 수 있고, 부모도 조회할 수 없다.
import path from 'node:path';
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { q, tx } from '../db.js';
import { pushToUser, pushToParents } from '../push.js';
import {
  askGemini, aiReady, aiModel, AI_NAME, AI_FALLBACK, AI_QUOTA,
} from '../gemini.js';

const MAX_TEXT = 500;
const PAGE = 100;                 // 이전 대화 로딩 단위
const INITIAL_DAYS = 10;          // 최초 로드: 최근 N일 (없으면 마지막 PAGE개)
const ACTIVE_WINDOW_SEC = 10;     // 이 시간 안에 그 방을 보고 있던 사용자에겐 푸시 생략
const PUSH_BODY_MAX = 40;
const AI_CONTEXT = 20;            // AI 방에서 모델에 넘기는 직전 메시지 수
const FAMILY_CONTEXT = 10;        // 가족방 호출에서 넘기는 직전 메시지 수
const MAX_IMAGES = 2;             // 모델에 함께 보내는 사진 수 (최근 것부터). 토큰·비용 상한
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

// 가족방에서 제미나이를 부르는 말.
//   이름 뒤에 쉼표/구두점이나 공백이 와야 한다 - "제미나이가 좋대" 같은 문장은 부르는 게 아니다.
const TRIGGER = /^@?\s*(제미나이|지미니|gemini)\s*(?:[,.!?~]+|\s+)\s*(.+)$/is;

// 사용량 소진·예비 모델 전환은 부모에게 하루 한 번만 알린다 (프로세스 재시작 시 초기화)
let quotaNoticeDay = null;
let fallbackNoticeDay = null;
const today = () => new Date().toISOString().slice(0, 10);

const shape = (r) => ({
  id: Number(r.id),
  user_id: Number(r.user_id),
  user_name: r.is_ai ? AI_NAME : r.user_name,
  is_ai: !!r.is_ai,
  shared: !!r.shared,
  kind: r.kind,
  content: r.deleted_at ? '' : r.content,
  image: r.deleted_at ? null : r.image,
  ai_model: r.ai_model || null,
  created_at: r.created_at,
  deleted: !!r.deleted_at,
});

const SELECT = `SELECT m.id, m.user_id, u.name AS user_name, m.kind, m.content, m.image,
                       m.is_ai, m.shared, m.ai_model, m.created_at, m.deleted_at
                FROM chat_message m JOIN app_user u ON u.id = m.user_id`;

// ---------------------------------------------------------------- 방

async function findRoom(familyId, kind, userId) {
  const { rows } = kind === 'ai'
    ? await q(`SELECT id FROM chat_room WHERE type = 'ai' AND owner_user_id = $1`, [userId])
    : await q(`SELECT id FROM chat_room WHERE type = 'family' AND family_id = $1`, [familyId]);
  return rows[0] ? Number(rows[0].id) : null;
}

// 방은 처음 열 때 만든다 (마이그레이션에서 미리 만들지 않음)
async function ensureRoom(familyId, kind, userId) {
  const found = await findRoom(familyId, kind, userId);
  if (found) return found;
  const ins = kind === 'ai'
    ? await q(`INSERT INTO chat_room (family_id, type, owner_user_id) VALUES ($1, 'ai', $2)
               ON CONFLICT DO NOTHING RETURNING id`, [familyId, userId])
    : await q(`INSERT INTO chat_room (family_id, type) VALUES ($1, 'family')
               ON CONFLICT DO NOTHING RETURNING id`, [familyId]);
  if (ins.rows[0]) return Number(ins.rows[0].id);
  return findRoom(familyId, kind, userId);          // 동시 요청이 먼저 만든 경우
}

const roomKind = (req) => (req.query.room === 'ai' ? 'ai' : 'family');

// 업로드된 사진을 모델에 실어 보낼 형태로 읽는다. 없거나 너무 크면 null.
async function readImage(uploadDir, name) {
  try {
    const full = path.join(uploadDir, path.basename(name));
    const stat = await fs.promises.stat(full);
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) return null;
    const ext = path.extname(full).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
      : ext === '.webp' ? 'image/webp'
        : ext === '.heic' || ext === '.heif' ? 'image/heic'
          : 'image/jpeg';
    return { mime, data: (await fs.promises.readFile(full)).toString('base64') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- AI 설정·한도

async function aiSettings(userId) {
  const { rows } = await q(
    `SELECT u.ai_enabled, u.ai_daily_limit, u.ai_homework_guard, u.name,
            COALESCE(a.count, 0) AS used
       FROM app_user u
       LEFT JOIN ai_usage a
         ON a.user_id = u.id AND a.use_date = (now() AT TIME ZONE 'Asia/Seoul')::date
      WHERE u.id = $1`, [userId]);
  const r = rows[0];
  if (!r) return null;
  return {
    enabled: r.ai_enabled,
    limit: r.ai_daily_limit,
    used: Number(r.used),
    homeworkGuard: r.ai_homework_guard,
    name: r.name,
  };
}

// 질문 1회를 차감한다. 한도를 넘으면 트랜잭션을 되돌려 증가분을 남기지 않는다.
async function consumeQuota(userId) {
  try {
    return await tx(async (c) => {
      const s = (await c.query(
        `SELECT ai_enabled, ai_daily_limit, ai_homework_guard, name
           FROM app_user WHERE id = $1 FOR UPDATE`, [userId])).rows[0];
      if (!s) throw Object.assign(new Error('no_user'), { hms: 'not_found' });
      if (!s.ai_enabled) throw Object.assign(new Error('off'), { hms: 'ai_disabled' });
      const r = await c.query(
        `INSERT INTO ai_usage (user_id, use_date, count)
         VALUES ($1, (now() AT TIME ZONE 'Asia/Seoul')::date, 1)
         ON CONFLICT (user_id, use_date) DO UPDATE SET count = ai_usage.count + 1
         RETURNING count`, [userId]);
      const used = Number(r.rows[0].count);
      if (used > s.ai_daily_limit) {
        throw Object.assign(new Error('limit'), { hms: 'ai_daily_limit', limit: s.ai_daily_limit });
      }
      return {
        ok: true, used, limit: s.ai_daily_limit, homeworkGuard: s.ai_homework_guard, name: s.name,
      };
    });
  } catch (err) {
    if (err.hms) return { ok: false, error: err.hms, limit: err.limit };
    throw err;
  }
}

export async function chatRoutes(app, opts) {
  const uploadDir = opts.uploadDir;

  async function touch(userId, roomId, markRead) {
    if (markRead) {
      await q(
        `INSERT INTO chat_read (user_id, room_id, last_read_id, seen_at)
         VALUES ($1, $2, COALESCE((SELECT max(id) FROM chat_message WHERE room_id = $2), 0), now())
         ON CONFLICT (user_id, room_id) DO UPDATE
           SET last_read_id = GREATEST(chat_read.last_read_id, EXCLUDED.last_read_id), seen_at = now()`,
        [userId, roomId]);
    } else {
      await q(
        `INSERT INTO chat_read (user_id, room_id, seen_at) VALUES ($1, $2, now())
         ON CONFLICT (user_id, room_id) DO UPDATE SET seen_at = now()`, [userId, roomId]);
    }
  }

  // AI 답변을 뒤에서 만들어 새 메시지로 넣는다.
  // 기존 행을 고치지 않고 새로 INSERT 하는 이유: 클라이언트 폴링이 since=ID 로 신규만 가져오므로
  // UPDATE 한 내용은 전달되지 않는다.
  function scheduleReply({
    roomId, familyId, askerId, askerName, homeworkGuard, groupChat = false, log,
  }) {
    setImmediate(async () => {
      let text = AI_FALLBACK;
      let model = aiModel();
      let failed = false;
      try {
        const { rows } = await q(
          `SELECT m.content, m.is_ai, m.image, u.name FROM chat_message m JOIN app_user u ON u.id = m.user_id
            WHERE m.room_id = $1 AND m.deleted_at IS NULL AND (m.content <> '' OR m.image IS NOT NULL)
            ORDER BY m.id DESC LIMIT $2`,
          [roomId, groupChat ? FAMILY_CONTEXT : AI_CONTEXT]);
        // 사진은 최근 것 몇 장만 실어 보낸다 (나머지는 "[사진]" 으로만 남긴다)
        let budget = MAX_IMAGES;
        for (const r of rows) {                      // rows 는 최신순
          if (!r.image) continue;
          if (budget > 0 && (r.attached = await readImage(uploadDir, r.image))) budget -= 1;
        }
        // 가족방은 여러 사람이 섞이므로 누가 한 말인지 붙여 준다
        const history = rows.reverse().map((r) => {
          let text = r.content || '';
          if (r.image && !r.attached) text = text ? `[사진] ${text}` : '[사진]';
          if (!text && r.image) text = '이 사진에 대해 알려 주세요.';
          return {
            text: groupChat && !r.is_ai && text ? `${r.name}: ${text}` : text,
            is_ai: r.is_ai,
            image: r.attached || null,
          };
        });
        const out = await askGemini({
          history, userName: askerName, homeworkGuard, groupChat, log,
        });
        text = out.text;
        model = out.model;
        // 예비 '모델'이 답한 경우에만 알린다. 같은 모델로 키만 바뀐 건 체감이 같아 알릴 필요가 없다.
        if (model !== aiModel() && fallbackNoticeDay !== today()) {
          fallbackNoticeDay = today();
          pushToParents(familyId, {
            title: `${AI_NAME} 예비 모델로 전환`,
            body: `기본 모델 사용량이 차서 ${model} 가 대신 답하고 있어요.`,
            url: '/?tab=chat&room=ai',
            tag: 'ai-fallback',
          }, log);
        }
      } catch (err) {
        failed = true;
        // Google 쪽 사용량이 바닥난 경우와 그 밖의 장애를 구분해서 알려준다
        if (err.quota) {
          text = AI_QUOTA;
          log.warn({ err: err.message }, 'gemini quota exhausted (429)');
          if (quotaNoticeDay !== today()) {
            quotaNoticeDay = today();
            pushToParents(familyId, {
              title: `${AI_NAME} 사용량 소진`,
              body: '예비 모델까지 모두 한도에 걸렸어요. 저녁 늦게 다시 풀려요.',
              url: '/?tab=chat&room=ai',
              tag: 'ai-quota',
            }, log);
          }
        } else {
          log.error({ err: err.message }, 'gemini reply failed');
        }
      }

      // 답을 못 받았으면 오늘 사용 횟수는 돌려준다 (실패로 한도를 깎지 않는다)
      if (failed) {
        await q(
          `UPDATE ai_usage SET count = GREATEST(0, count - 1)
            WHERE user_id = $1 AND use_date = (now() AT TIME ZONE 'Asia/Seoul')::date`,
          [askerId]).catch(() => {});
      }

      try {
        await q(
          `INSERT INTO chat_message (family_id, user_id, room_id, kind, content, is_ai, ai_model)
           VALUES ($1, $2, $3, 'text', $4, TRUE, $5)`,
          [familyId, askerId, roomId, text, model]);
      } catch (err) {
        log.error({ err: err.message }, 'gemini reply insert failed');
        return;
      }

      // 그 방을 보고 있지 않은 사람에게 알린다
      //   AI 방은 물어본 본인만, 가족방은 가족 전원(물어본 사람 포함 - 답이 왔는지 궁금할 테니)
      let body = text.replace(/\s+/g, ' ');
      if (body.length > PUSH_BODY_MAX) body = `${body.slice(0, PUSH_BODY_MAX)}…`;
      const payload = {
        title: AI_NAME, body, url: groupChat ? '/?tab=chat' : '/?tab=chat&room=ai', tag: 'chat',
      };
      const targets = groupChat
        ? await q(
          `SELECT u.id FROM app_user u
           LEFT JOIN chat_read r ON r.user_id = u.id AND r.room_id = $2
           WHERE u.family_id = $1 AND u.active
             AND (r.seen_at IS NULL OR r.seen_at < now() - interval '${ACTIVE_WINDOW_SEC} seconds')`,
          [familyId, roomId])
        : await q(
          `SELECT $1::bigint AS id WHERE NOT EXISTS (
             SELECT 1 FROM chat_read WHERE user_id = $1 AND room_id = $2
               AND seen_at > now() - interval '${ACTIVE_WINDOW_SEC} seconds')`,
          [askerId, roomId]);
      for (const t of targets.rows) pushToUser(t.id, payload, log);
    });
  }

  // AI 방 사용 가능 여부 + 오늘 남은 횟수 (화면 상단 안내용)
  app.get('/chat/ai/status', { onRequest: app.authRequired }, async (req) => {
    const s = await aiSettings(req.user.sub);
    if (!s) return { available: false, enabled: false };
    return {
      available: aiReady() && s.enabled,
      enabled: s.enabled,
      configured: aiReady(),
      used: s.used,
      limit: s.limit,
      remaining: Math.max(0, s.limit - s.used),
      name: AI_NAME,
      model: aiModel(),
    };
  });

  // messages
  //   ?room=family(기본)|ai
  //   (없음)     : 최초 로드 - 최근 10일, 없으면 마지막 100개
  //   ?before=ID : ID 이전 100개 (위로 스크롤)
  //   ?since=ID  : ID 이후 신규 (폴링) + 최근 삭제 id 목록
  //   &active=1  : 그 방을 보고 있음 → 접속 시각 갱신 + 전부 읽음 처리
  app.get('/chat/messages', { onRequest: app.authRequired }, async (req, reply) => {
    const kind = roomKind(req);
    if (kind === 'ai') {
      const s = await aiSettings(req.user.sub);
      if (!s || !s.enabled) return reply.code(403).send({ error: 'ai_disabled' });
    }
    const room = await ensureRoom(req.user.family_id, kind, req.user.sub);
    const active = req.query.active === '1';
    let rows; let hasMore = false; let deleted = [];

    if (req.query.since !== undefined) {
      const since = Number(req.query.since) || 0;
      ({ rows } = await q(
        `${SELECT} WHERE m.room_id = $1 AND m.id > $2 ORDER BY m.id ASC LIMIT ${PAGE}`, [room, since]));
      const d = await q(
        `SELECT id FROM chat_message WHERE room_id = $1 AND id <= $2
           AND deleted_at IS NOT NULL AND deleted_at > now() - interval '60 seconds'`, [room, since]);
      deleted = d.rows.map((r) => Number(r.id));
    } else if (req.query.before !== undefined) {
      const before = Number(req.query.before) || 0;
      ({ rows } = await q(
        `${SELECT} WHERE m.room_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT ${PAGE + 1}`, [room, before]));
      hasMore = rows.length > PAGE;
      rows = rows.slice(0, PAGE).reverse();
    } else {
      ({ rows } = await q(
        `${SELECT} WHERE m.room_id = $1 AND m.created_at > now() - interval '${INITIAL_DAYS} days'
         ORDER BY m.id ASC`, [room]));
      if (!rows.length) {
        ({ rows } = await q(
          `${SELECT} WHERE m.room_id = $1 ORDER BY m.id DESC LIMIT ${PAGE}`, [room]));
        rows.reverse();
      }
      if (rows.length) {
        const older = await q(
          `SELECT 1 FROM chat_message WHERE room_id = $1 AND id < $2 LIMIT 1`, [room, rows[0].id]);
        hasMore = older.rows.length > 0;
      }
    }

    if (active) await touch(req.user.sub, room, true);

    const out = { rows: rows.map(shape), has_more: hasMore };
    if (deleted.length) out.deleted = deleted;
    return out;
  });

  // 탭 배지용 미읽음 수. 가족방(남이 보낸 것) + 내 AI 방(AI 답변)
  app.get('/chat/unread', { onRequest: app.authRequired }, async (req) => {
    const uid = req.user.sub;
    const famRoom = await findRoom(req.user.family_id, 'family');
    const aiRoomId = await findRoom(req.user.family_id, 'ai', uid);

    let family = 0; let ai = 0;
    if (famRoom) {
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM chat_message m
          WHERE m.room_id = $1 AND m.user_id <> $2 AND m.deleted_at IS NULL
            AND m.id > COALESCE((SELECT last_read_id FROM chat_read
                                  WHERE user_id = $2 AND room_id = $1), 0)`, [famRoom, uid]);
      family = rows[0].n;
    }
    if (aiRoomId) {
      const { rows } = await q(
        `SELECT count(*)::int AS n FROM chat_message m
          WHERE m.room_id = $1 AND m.is_ai AND m.deleted_at IS NULL
            AND m.id > COALESCE((SELECT last_read_id FROM chat_read
                                  WHERE user_id = $2 AND room_id = $1), 0)`, [aiRoomId, uid]);
      ai = rows[0].n;
    }
    return { count: family + ai, family, ai };
  });

  // send: JSON {content} 또는 multipart(photo + content)
  //   ?room=ai 이면 사진은 받지 않고(1차 범위: 텍스트만), 답변을 뒤에서 만들어 붙인다
  app.post('/chat/messages', { onRequest: app.authRequired }, async (req, reply) => {
    const kind = roomKind(req);
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

    // AI 방은 보내기 전에 사용 가능 여부와 오늘 남은 횟수를 확인한다
    let quota = null;
    if (kind === 'ai') {
      if (!aiReady()) return reply.code(503).send({ error: 'ai_unavailable' });
      quota = await consumeQuota(req.user.sub);
      if (!quota.ok) {
        return reply.code(quota.error === 'ai_daily_limit' ? 429 : 403)
          .send({ error: quota.error, limit: quota.limit });
      }
    }

    const fam = req.user.family_id;
    const room = await ensureRoom(fam, kind, req.user.sub);
    const msgKind = image ? 'photo' : 'text';
    const { rows } = await q(
      `INSERT INTO chat_message (family_id, user_id, room_id, kind, content, image)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
      [fam, req.user.sub, room, msgKind, content, image]);
    const id = Number(rows[0].id);

    // 보낸 사람은 자기 메시지까지 읽음 처리
    await q(
      `INSERT INTO chat_read (user_id, room_id, last_read_id, seen_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, room_id) DO UPDATE
         SET last_read_id = GREATEST(chat_read.last_read_id, EXCLUDED.last_read_id), seen_at = now()`,
      [req.user.sub, room, id]);

    const who = await q('SELECT name FROM app_user WHERE id = $1', [req.user.sub]);
    let aiSkipped = null;

    if (kind === 'ai') {
      scheduleReply({
        roomId: room,
        familyId: fam,
        askerId: req.user.sub,
        askerName: who.rows[0].name,
        homeworkGuard: quota.homeworkGuard,
        log: req.log,
      });
    } else {
      // 가족방에서 "제미나이, ~" 로 부르면 AI 가 끼어들어 답한다.
      //   한도·사용 여부는 AI 방과 같은 규칙. 막혀 있으면 메시지는 그대로 올라가되 답만 생략한다.
      const hit = content ? content.match(TRIGGER) : null;
      if (hit && aiReady()) {
        const fq = await consumeQuota(req.user.sub);
        if (fq.ok) {
          scheduleReply({
            roomId: room,
            familyId: fam,
            askerId: req.user.sub,
            askerName: who.rows[0].name,
            homeworkGuard: fq.homeworkGuard,
            groupChat: true,
            log: req.log,
          });
          aiSkipped = null;
          quota = fq;
        } else {
          aiSkipped = fq.error;
        }
      }

      // 푸시: 가족 중 본인 제외, 최근 10초 내 가족방을 보고 있던 사람 제외
      const targets = await q(
        `SELECT u.id FROM app_user u
         LEFT JOIN chat_read r ON r.user_id = u.id AND r.room_id = $3
         WHERE u.family_id = $1 AND u.active AND u.id <> $2
           AND (r.seen_at IS NULL OR r.seen_at < now() - interval '${ACTIVE_WINDOW_SEC} seconds')`,
        [fam, req.user.sub, room]);
      let body = content ? content.replace(/\s+/g, ' ') : '📷 사진을 보냈어요';
      if (body.length > PUSH_BODY_MAX) body = `${body.slice(0, PUSH_BODY_MAX)}…`;
      const payload = { title: who.rows[0].name, body, url: '/?tab=chat', tag: 'chat' };
      for (const r of targets.rows) pushToUser(r.id, payload, req.log);
    }

    const out = {
      id,
      user_id: Number(req.user.sub),
      user_name: who.rows[0].name,
      is_ai: false,
      shared: false,
      ai_model: null,
      kind: msgKind,
      content,
      image,
      created_at: rows[0].created_at,
      deleted: false,
    };
    if (quota) out.ai_usage = { used: quota.used, limit: quota.limit };
    if (aiSkipped) out.ai_skipped = aiSkipped;       // 불렀지만 한도·설정 때문에 답을 못 하는 경우
    if (kind === 'family' && !aiSkipped && quota) out.ai_called = true;
    return out;
  });

  // AI 방의 질문·답변 한 쌍을 가족방으로 공유 (내 AI 방의 메시지만)
  //   말풍선을 길게 눌러 고른 것이 질문이든 답변이든 짝을 찾아 함께 올린다.
  app.post('/chat/messages/:id/share', { onRequest: app.authRequired }, async (req, reply) => {
    const me = Number(req.user.sub);
    const { rows } = await q(
      `SELECT m.id, m.content, m.is_ai, m.ai_model, m.deleted_at, m.room_id
         FROM chat_message m JOIN chat_room r ON r.id = m.room_id
        WHERE m.id = $1 AND r.type = 'ai' AND r.owner_user_id = $2`,
      [req.params.id, me]);
    const picked = rows[0];
    if (!picked || picked.deleted_at) return reply.code(404).send({ error: 'not_found' });

    // 짝 찾기: 답변을 골랐으면 바로 앞 질문을, 질문을 골랐으면 바로 뒤 답변을
    const mate = await q(
      picked.is_ai
        ? `SELECT id, content, is_ai, ai_model FROM chat_message
            WHERE room_id = $1 AND id < $2 AND deleted_at IS NULL AND NOT is_ai AND content <> ''
            ORDER BY id DESC LIMIT 1`
        : `SELECT id, content, is_ai, ai_model FROM chat_message
            WHERE room_id = $1 AND id > $2 AND deleted_at IS NULL AND is_ai AND content <> ''
            ORDER BY id ASC LIMIT 1`,
      [picked.room_id, picked.id]);
    if (!mate.rows[0]) return reply.code(400).send({ error: 'nothing_to_share' });

    const question = picked.is_ai ? mate.rows[0] : picked;
    const answer = picked.is_ai ? picked : mate.rows[0];

    const fam = req.user.family_id;
    const famRoom = await ensureRoom(fam, 'family', me);
    const ins = await q(
      `INSERT INTO chat_message (family_id, user_id, room_id, kind, content, is_ai, ai_model, shared)
       VALUES ($1, $2, $3, 'text', $4, FALSE, NULL,      TRUE),
              ($1, $2, $3, 'text', $5, TRUE,  $6,        TRUE)
       RETURNING id`,
      [fam, me, famRoom, question.content, answer.content, answer.ai_model]);
    const lastId = Number(ins.rows[ins.rows.length - 1].id);

    // 공유한 사람은 읽음 처리, 나머지 가족에겐 알림
    await q(
      `INSERT INTO chat_read (user_id, room_id, last_read_id, seen_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id, room_id) DO UPDATE
         SET last_read_id = GREATEST(chat_read.last_read_id, EXCLUDED.last_read_id), seen_at = now()`,
      [me, famRoom, lastId]);
    const who = await q('SELECT name FROM app_user WHERE id = $1', [me]);
    const targets = await q(
      `SELECT u.id FROM app_user u
       LEFT JOIN chat_read r ON r.user_id = u.id AND r.room_id = $3
       WHERE u.family_id = $1 AND u.active AND u.id <> $2
         AND (r.seen_at IS NULL OR r.seen_at < now() - interval '${ACTIVE_WINDOW_SEC} seconds')`,
      [fam, me, famRoom]);
    let body = question.content.replace(/\s+/g, ' ');
    if (body.length > PUSH_BODY_MAX) body = `${body.slice(0, PUSH_BODY_MAX)}…`;
    for (const t of targets.rows) {
      pushToUser(t.id, {
        title: `${who.rows[0].name}님이 ${AI_NAME}와의 대화를 공유했어요`,
        body,
        url: '/?tab=chat',
        tag: 'chat',
      }, req.log);
    }
    return { ok: true, count: 2 };
  });

  // delete (본인 또는 부모) - 소프트 삭제, 사진 파일은 제거
  //   AI 방은 소유자만 지울 수 있다 (부모도 남의 AI 방엔 손대지 못한다)
  app.delete('/chat/messages/:id', { onRequest: app.authRequired }, async (req, reply) => {
    const { rows } = await q(
      `SELECT m.id, m.user_id, m.image, m.deleted_at, r.type AS room_type, r.owner_user_id
         FROM chat_message m JOIN chat_room r ON r.id = m.room_id
        WHERE m.id = $1 AND m.family_id = $2`,
      [req.params.id, req.user.family_id]);
    if (!rows[0] || rows[0].deleted_at) return reply.code(404).send({ error: 'not_found' });

    const row = rows[0];
    const me = Number(req.user.sub);
    const isParent = req.user.role === 'parent' || req.user.role === 'super_admin';
    const allowed = row.room_type === 'ai'
      ? Number(row.owner_user_id) === me
      : (Number(row.user_id) === me || isParent);
    if (!allowed) return reply.code(403).send({ error: 'forbidden' });

    await q(`UPDATE chat_message SET deleted_at = now(), content = '', image = NULL WHERE id = $1`, [row.id]);
    if (row.image) fs.promises.unlink(path.join(uploadDir, row.image)).catch(() => {});
    return { ok: true };
  });
}
