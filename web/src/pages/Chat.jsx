// 가족 채팅 탭 (v1.18.0): 메신저형 UI, 3초 폴링, 위로 스크롤 시 이전 100개, 사진(리사이즈) 전송
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, t } from '../api.js';
import { toast } from '../toast.jsx';

const POLL_MS = 3000;          // 채팅 화면이 보일 때 신규 메시지 확인 주기
const UNREAD_MS = 15000;       // 다른 탭에서 미읽음 수 확인 주기
const MAX_TEXT = 500;
const IMG_MAX = 1280;          // 업로드 전 긴 변 리사이즈(px)

const fmtTime = (s) => new Date(s).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (s) => new Date(s).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const dayKey = (s) => { const d = new Date(s); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// 푸시 탭(?tab=chat)으로 열렸으면 그 탭으로 시작
export function initialTab(fallback) {
  try {
    const p = new URLSearchParams(window.location.search).get('tab');
    if (p) window.history.replaceState(null, '', window.location.pathname);
    return p === 'chat' ? 'chat' : fallback;
  } catch { return fallback; }
}

// 하단 탭 배지용 미읽음 수. 채팅 탭이 아닐 때만 주기 조회, 늘어나면 토스트 한 줄
export function useChatUnread(isChatTab) {
  const [count, setCount] = useState(0);
  const prev = useRef(0);
  useEffect(() => {
    if (isChatTab) { setCount(0); prev.current = 0; return undefined; }
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api('GET', '/api/chat/unread');
        if (!alive || !r) return;
        if (r.count > prev.current && prev.current >= 0) toast(`새 채팅 ${r.count}개 💬`);
        prev.current = r.count;
        setCount(r.count);
      } catch { /* 조용히 */ }
    };
    prev.current = -1;             // 첫 조회는 토스트 없이
    check().then(() => { if (prev.current < 0) prev.current = 0; });
    const iv = setInterval(check, UNREAD_MS);
    const onVis = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('hms:push', check);      // 앱 포그라운드 중 도착한 네이티브 푸시
    return () => {
      alive = false; clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('hms:push', check);
    };
  }, [isChatTab]);
  return count;
}

// 인증이 필요한 업로드 이미지 (objectURL 캐시)
const imgCache = new Map();
function AuthImg({ path, className, onClick, alt }) {
  const [url, setUrl] = useState(imgCache.get(path) || null);
  useEffect(() => {
    if (imgCache.has(path)) { setUrl(imgCache.get(path)); return undefined; }
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/uploads/${path}`, { headers: { authorization: `Bearer ${getToken()}` } });
        if (res.ok) {
          const u = URL.createObjectURL(await res.blob());
          imgCache.set(path, u);
          if (alive) setUrl(u);
        }
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [path]);
  if (!url) return <div className={`${className} chat-img-loading`}>사진 불러오는 중…</div>;
  return <img className={className} src={url} alt={alt} onClick={onClick} />;
}

// 브라우저에서 긴 변 IMG_MAX 로 줄여 JPEG 로 (실패하면 원본)
async function shrinkImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, IMG_MAX / Math.max(bmp.width, bmp.height));
    if (scale >= 1 && file.size < 600 * 1024) return file;
    const w = Math.round(bmp.width * scale); const h = Math.round(bmp.height * scale);
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.85));
    return blob ? new File([blob], 'photo.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}

export default function ChatTab({ me }) {
  const [msgs, setMsgs] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [viewer, setViewer] = useState(null);      // 크게 보기 이미지 path
  const listRef = useRef(null);
  const lastIdRef = useRef(0);
  const loadingOlder = useRef(false);
  const stickBottom = useRef(true);                 // 맨 아래 근처면 새 메시지 때 자동 스크롤
  const prependFix = useRef(null);                  // 이전 로딩 후 스크롤 위치 보정
  const cameraRef = useRef(null);
  const albumRef = useRef(null);
  const taRef = useRef(null);
  const isParent = me.role === 'parent' || me.role === 'super_admin';

  const scrollBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const merge = useCallback((rows, deleted) => {
    if (!rows.length && !(deleted && deleted.length)) return;
    setMsgs((cur) => {
      const ids = new Set(cur.map((m) => m.id));
      let next = cur.concat(rows.filter((r) => !ids.has(r.id)));
      if (deleted && deleted.length) {
        const del = new Set(deleted);
        next = next.map((m) => (del.has(m.id) ? { ...m, deleted: true, content: '', image: null } : m));
      }
      return next;
    });
    if (rows.length) lastIdRef.current = Math.max(lastIdRef.current, rows[rows.length - 1].id);
  }, []);

  // 최초 로드
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await api('GET', '/api/chat/messages?active=1');
        if (!alive || !r) return;
        setMsgs(r.rows); setHasMore(r.has_more);
        if (r.rows.length) lastIdRef.current = r.rows[r.rows.length - 1].id;
      } catch (ex) { toast(t(ex.message), 'error'); }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, []);
  useLayoutEffect(() => { if (loaded) scrollBottom(); }, [loaded, scrollBottom]);

  // 폴링: 화면이 보일 때만, 3초마다 (active=1 → 서버가 접속 중으로 보고 푸시 생략 + 읽음 처리)
  useEffect(() => {
    if (!loaded) return undefined;
    let alive = true; let running = false;
    const poll = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const r = await api('GET', `/api/chat/messages?since=${lastIdRef.current}&active=1`);
        if (alive && r) merge(r.rows, r.deleted);
      } catch { /* 다음 주기에 재시도 */ }
      running = false;
    };
    const iv = setInterval(poll, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [loaded, merge]);

  // 새 메시지가 붙었을 때: 아래쪽을 보고 있었으면 따라 내려간다 / 이전 로딩이면 위치 보정
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (prependFix.current != null) {
      el.scrollTop += el.scrollHeight - prependFix.current;
      prependFix.current = null;
    } else if (stickBottom.current) {
      scrollBottom();
    }
  }, [msgs, scrollBottom]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || !msgs.length) return;
    loadingOlder.current = true;
    try {
      const r = await api('GET', `/api/chat/messages?before=${msgs[0].id}`);
      if (r) {
        prependFix.current = listRef.current ? listRef.current.scrollHeight : 0;
        setHasMore(r.has_more);
        setMsgs((cur) => {
          const ids = new Set(cur.map((m) => m.id));
          return r.rows.filter((m) => !ids.has(m.id)).concat(cur);
        });
      }
    } catch { /* 스크롤 시 재시도 */ }
    loadingOlder.current = false;
  }, [hasMore, msgs]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (el.scrollTop < 60) loadOlder();
  };

  const sendText = async () => {
    const content = text.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const m = await api('POST', '/api/chat/messages', { content });
      setText('');
      if (taRef.current) taRef.current.style.height = 'auto';
      stickBottom.current = true;
      merge([m]);
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const sendPhoto = async (e) => {
    const file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file || busy) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('content', text.trim());
      fd.append('photo', await shrinkImage(file));
      const m = await api('POST', '/api/chat/messages', fd);
      setText('');
      stickBottom.current = true;
      merge([m]);
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const remove = async (m) => {
    if (m.deleted) return;
    if (m.user_id !== me.id && !isParent) return;
    if (!window.confirm('이 메시지를 삭제할까요?')) return;
    try {
      await api('DELETE', `/api/chat/messages/${m.id}`);
      merge([], [m.id]);
    } catch (ex) { toast(t(ex.message), 'error'); }
  };
  // 삭제는 말풍선을 길게 누르면(contextmenu) - 본인 메시지, 부모는 전체

  const onInput = (e) => {
    setText(e.target.value.slice(0, MAX_TEXT));
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`;
  };

  // 렌더링: 날짜 구분선 + 같은 사람 연속 메시지는 이름 생략
  const items = [];
  let prevDay = null; let prevUser = null;
  for (const m of msgs) {
    const dk = dayKey(m.created_at);
    if (dk !== prevDay) {
      items.push(<div className="chat-day" key={`d${dk}`}><span>{fmtDay(m.created_at)}</span></div>);
      prevDay = dk; prevUser = null;
    }
    const mine = m.user_id === me.id;
    const showName = !mine && m.user_id !== prevUser;
    prevUser = m.user_id;
    items.push(
      <div className={`chat-row ${mine ? 'mine' : ''}`} key={m.id}>
        <div className="chat-col">
          {showName && <div className="chat-name">{m.user_name}</div>}
          <div className="chat-line">
            {mine && <span className="chat-time">{fmtTime(m.created_at)}</span>}
            <div className={`chat-bubble ${m.deleted ? 'deleted' : ''} ${m.kind === 'photo' && !m.deleted ? 'photo' : ''}`}
              onContextMenu={(e) => { e.preventDefault(); remove(m); }}>
              {m.deleted ? '삭제된 메시지예요' : (<>
                {m.image && <AuthImg path={m.image} className="chat-img" alt="사진" onClick={() => setViewer(m.image)} />}
                {m.content && <div className="chat-text">{m.content}</div>}
              </>)}
            </div>
            {!mine && <span className="chat-time">{fmtTime(m.created_at)}</span>}
          </div>
        </div>
      </div>,
    );
  }

  return (
    <div className="chat-wrap">
      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {hasMore && <div className="chat-more">↑ 위로 올리면 이전 대화를 불러와요</div>}
        {loaded && !msgs.length && <div className="notice">아직 대화가 없어요. 첫 메시지를 보내 보세요!</div>}
        {items}
      </div>
      <div className="chat-input">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={sendPhoto} />
        <input ref={albumRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={sendPhoto} />
        <button className="chat-icon" disabled={busy} onClick={() => cameraRef.current.click()} title="촬영">📷</button>
        <button className="chat-icon" disabled={busy} onClick={() => albumRef.current.click()} title="앨범">🖼️</button>
        <textarea ref={taRef} rows={1} value={text} onChange={onInput} placeholder="메시지 입력" maxLength={MAX_TEXT} />
        <button className="chat-send" disabled={busy || !text.trim()} onClick={sendText}>전송</button>
      </div>
      {viewer && (
        <div className="modal-bg photo" onClick={() => setViewer(null)}>
          <AuthImg path={viewer} className="proof-full" alt="사진 크게 보기" />
        </div>
      )}
    </div>
  );
}
