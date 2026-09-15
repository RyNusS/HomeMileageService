// 채팅 탭 (v1.20.0): 방 두 개 - 가족 공용 방 / 나만 보는 AI 방(제미나이)
//   v1.18.0 의 메신저형 UI·3초 폴링·사진 전송은 그대로, 상단에 방 전환 칩을 얹었다.
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, t } from '../api.js';
import { toast } from '../toast.jsx';

const POLL_MS = 3000;          // 채팅 화면이 보일 때 신규 메시지 확인 주기
const UNREAD_MS = 15000;       // 미읽음 수 확인 주기
const MAX_TEXT = 500;
const IMG_MAX = 1280;          // 업로드 전 긴 변 리사이즈(px)
const THINKING_MAX_MS = 60000; // 이 시간까지 답이 없으면 '생각 중' 표시를 거둔다
const AI_NAME = '제미나이';

const fmtTime = (s) => new Date(s).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const fmtDay = (s) => new Date(s).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
const dayKey = (s) => { const d = new Date(s); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; };

// 푸시(?tab=chat[&room=ai])로 열렸으면 그 탭·그 방으로 시작
let bootRoom = 'family';
export function initialTab(fallback) {
  try {
    const sp = new URLSearchParams(window.location.search);
    const tab = sp.get('tab');
    if (sp.get('room') === 'ai') bootRoom = 'ai';
    if (tab || sp.get('room')) window.history.replaceState(null, '', window.location.pathname);
    return tab === 'chat' ? 'chat' : fallback;
  } catch { return fallback; }
}
export function initialRoom() { const r = bootRoom; bootRoom = 'family'; return r; }

// 하단 탭 배지용 미읽음 수(가족방 + 내 AI 방). 채팅 탭이 아닐 때만 주기 조회
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
  const [room, setRoom] = useState(() => initialRoom());
  const [msgs, setMsgs] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [ai, setAi] = useState(null);              // /chat/ai/status 결과
  const [badge, setBadge] = useState({ family: 0, ai: 0 });
  const [viewer, setViewer] = useState(null);      // 크게 보기 이미지 path
  const [sheet, setSheet] = useState(null);        // AI 방 말풍선 길게 누르기 메뉴
  const listRef = useRef(null);
  const lastIdRef = useRef(0);
  const loadingOlder = useRef(false);
  const stickBottom = useRef(true);                 // 맨 아래 근처면 새 메시지 때 자동 스크롤
  const prependFix = useRef(null);                  // 이전 로딩 후 스크롤 위치 보정
  const thinkingTimer = useRef(null);
  const cameraRef = useRef(null);
  const albumRef = useRef(null);
  const taRef = useRef(null);
  const isParent = me.role === 'parent' || me.role === 'super_admin';
  const isAi = room === 'ai';
  const qs = isAi ? '&room=ai' : '';

  const scrollBottom = useCallback(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  const stopThinking = useCallback(() => {
    setThinking(false);
    if (thinkingTimer.current) { clearTimeout(thinkingTimer.current); thinkingTimer.current = null; }
  }, []);

  const merge = useCallback((rows, deleted) => {
    if (!rows.length && !(deleted && deleted.length)) return;
    if (rows.some((r) => r.is_ai)) stopThinking();
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
  }, [stopThinking]);

  // AI 사용 가능 여부·남은 횟수
  const refreshAi = useCallback(async () => {
    try { setAi(await api('GET', '/api/chat/ai/status')); } catch { setAi(null); }
  }, []);
  useEffect(() => { refreshAi(); }, [refreshAi]);

  // 방 전환 칩의 점 표시용 (지금 보고 있는 방은 읽음 처리되어 0이 된다)
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api('GET', '/api/chat/unread');
        if (alive && r) setBadge({ family: r.family || 0, ai: r.ai || 0 });
      } catch { /* 조용히 */ }
    };
    check();
    const iv = setInterval(check, UNREAD_MS);
    return () => { alive = false; clearInterval(iv); };
  }, [room]);

  // 방이 바뀌면 처음부터 다시 로드
  useEffect(() => {
    let alive = true;
    setLoaded(false); setMsgs([]); setHasMore(false); lastIdRef.current = 0;
    stickBottom.current = true;
    stopThinking();
    (async () => {
      try {
        const r = await api('GET', `/api/chat/messages?active=1${qs}`);
        if (!alive || !r) return;
        setMsgs(r.rows); setHasMore(r.has_more);
        if (r.rows.length) lastIdRef.current = r.rows[r.rows.length - 1].id;
      } catch (ex) {
        if (alive) toast(t(ex.message), 'error');
      }
      if (alive) setLoaded(true);
    })();
    return () => { alive = false; };
  }, [room, qs, stopThinking]);
  useLayoutEffect(() => { if (loaded) scrollBottom(); }, [loaded, scrollBottom]);

  // 폴링: 화면이 보일 때만, 3초마다 (active=1 → 서버가 접속 중으로 보고 푸시 생략 + 읽음 처리)
  useEffect(() => {
    if (!loaded) return undefined;
    let alive = true; let running = false;
    const poll = async () => {
      if (running || document.visibilityState !== 'visible') return;
      running = true;
      try {
        const r = await api('GET', `/api/chat/messages?since=${lastIdRef.current}&active=1${qs}`);
        if (alive && r) merge(r.rows, r.deleted);
      } catch { /* 다음 주기에 재시도 */ }
      running = false;
    };
    const iv = setInterval(poll, POLL_MS);
    const onVis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { alive = false; clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [loaded, merge, qs]);

  useEffect(() => () => { if (thinkingTimer.current) clearTimeout(thinkingTimer.current); }, []);

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
  }, [msgs, thinking, scrollBottom]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder.current || !hasMore || !msgs.length) return;
    loadingOlder.current = true;
    try {
      const r = await api('GET', `/api/chat/messages?before=${msgs[0].id}${qs}`);
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
  }, [hasMore, msgs, qs]);

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
      const m = await api('POST', `/api/chat/messages?room=${room}`, { content });
      setText('');
      if (taRef.current) taRef.current.style.height = 'auto';
      stickBottom.current = true;
      merge([m]);
      if (m.ai_skipped) {
        toast(m.ai_skipped === 'ai_daily_limit'
          ? `오늘 ${AI_NAME}와 나눌 수 있는 대화를 다 썼어요`
          : `${AI_NAME}를 부를 수 없어요`, 'error');
      }
      if (isAi || m.ai_called) {
        setThinking(true);
        if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
        thinkingTimer.current = setTimeout(() => setThinking(false), THINKING_MAX_MS);
        if (m.ai_usage) {
          setAi((cur) => (cur ? {
            ...cur,
            used: m.ai_usage.used,
            remaining: Math.max(0, m.ai_usage.limit - m.ai_usage.used),
          } : cur));
        }
      }
    } catch (ex) {
      toast(t(ex.message), 'error');
      if (isAi) refreshAi();
    }
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
      const m = await api('POST', `/api/chat/messages?room=${room}`, fd);
      setText('');
      if (taRef.current) taRef.current.style.height = 'auto';
      stickBottom.current = true;
      merge([m]);
      if (m.ai_skipped) {
        toast(m.ai_skipped === 'ai_daily_limit'
          ? `오늘 ${AI_NAME}와 나눌 수 있는 대화를 다 썼어요`
          : `${AI_NAME}를 부를 수 없어요`, 'error');
      }
      if (isAi || m.ai_called) {
        setThinking(true);
        if (thinkingTimer.current) clearTimeout(thinkingTimer.current);
        thinkingTimer.current = setTimeout(() => setThinking(false), THINKING_MAX_MS);
        if (m.ai_usage) {
          setAi((cur) => (cur ? {
            ...cur,
            used: m.ai_usage.used,
            remaining: Math.max(0, m.ai_usage.limit - m.ai_usage.used),
          } : cur));
        }
      }
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const share = async (m) => {
    try {
      await api('POST', `/api/chat/messages/${m.id}/share`);
      toast('가족방에 공유했어요 💬');
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  const remove = async (m) => {
    if (m.deleted) return;
    const canDelete = isAi ? true : (m.user_id === me.id || isParent);
    if (!canDelete) return;
    if (!window.confirm('이 메시지를 삭제할까요?')) return;
    try {
      await api('DELETE', `/api/chat/messages/${m.id}`);
      merge([], [m.id]);
    } catch (ex) { toast(t(ex.message), 'error'); }
  };
  // 삭제는 말풍선을 길게 누르면(contextmenu) - 본인 메시지, 부모는 가족방 전체

  const onInput = (e) => {
    setText(e.target.value.slice(0, MAX_TEXT));
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 110)}px`;
  };

  // 기본 모델 한도가 차서 예비 모델이 답한 말풍선인지 (말투·품질이 달라져 표시해 준다)
  const isBackup = (model) => !!(model && ai && ai.model && model !== ai.model);

  // 렌더링: 날짜 구분선 + 같은 사람 연속 메시지는 이름 생략
  const items = [];
  let prevDay = null; let prevWho = null;
  for (const m of msgs) {
    const dk = dayKey(m.created_at);
    if (dk !== prevDay) {
      items.push(<div className="chat-day" key={`d${dk}`}><span>{fmtDay(m.created_at)}</span></div>);
      prevDay = dk; prevWho = null;
    }
    // AI 답변은 질문한 사람의 id 로 저장되므로 is_ai 를 먼저 본다
    const mine = !m.is_ai && m.user_id === me.id;
    const who = m.is_ai ? 'ai' : m.user_id;
    const showName = !mine && who !== prevWho;
    prevWho = who;
    items.push(
      <div className={`chat-row ${mine ? 'mine' : ''}`} key={m.id}>
        <div className="chat-col">
          {m.shared && !m.is_ai && (
            <div className="chat-shared">🔗 {AI_NAME}와의 대화에서 공유</div>
          )}
          {showName && (
            <div className={`chat-name ${m.is_ai ? 'ai' : ''}`}>
              {m.is_ai ? `🤖 ${AI_NAME}` : m.user_name}
              {m.is_ai && isBackup(m.ai_model) && (
                <span className="chat-backup" title={m.ai_model}>예비 모델</span>
              )}
            </div>
          )}
          <div className="chat-line">
            {mine && <span className="chat-time">{fmtTime(m.created_at)}</span>}
            <div className={`chat-bubble ${m.deleted ? 'deleted' : ''} ${m.is_ai ? 'ai' : ''} ${m.kind === 'photo' && !m.deleted ? 'photo' : ''}`}
              onContextMenu={(e) => {
                e.preventDefault();
                if (m.deleted) return;
                if (isAi) setSheet(m); else remove(m);
              }}>
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

  const aiOff = isAi && ai && !ai.available;
  const aiEmpty = isAi && ai && ai.available && ai.remaining <= 0;
  const canSend = !busy && !!text.trim() && !aiOff && !aiEmpty;

  return (
    <div className="chat-wrap">
      <div className="chat-rooms">
        <button className={`chat-room-chip ${!isAi ? 'on' : ''}`} onClick={() => setRoom('family')}>
          👨‍👩‍👧 가족
          {!!badge.family && isAi && <span className="chat-room-dot" />}
        </button>
        <button className={`chat-room-chip ${isAi ? 'on' : ''}`} onClick={() => setRoom('ai')}>
          🤖 {AI_NAME}
          {!!badge.ai && !isAi && <span className="chat-room-dot" />}
        </button>
      </div>

      <div className="chat-list" ref={listRef} onScroll={onScroll}>
        {hasMore && <div className="chat-more">↑ 위로 올리면 이전 대화를 불러와요</div>}
        {loaded && !msgs.length && !isAi && (
          <div className="notice">아직 대화가 없어요. 첫 메시지를 보내 보세요!</div>
        )}
        {loaded && !msgs.length && isAi && !aiOff && (
          <div className="notice">
            {AI_NAME}에게 무엇이든 물어보세요. 모르는 문제는 사진을 찍어 보여줘도 돼요.
            <br />이 방의 대화는 나만 볼 수 있어요.
          </div>
        )}
        {items}
        {thinking && (
          <div className="chat-row">
            <div className="chat-col">
              <div className="chat-line">
                <div className="chat-bubble ai thinking"><span /><span /><span /></div>
              </div>
            </div>
          </div>
        )}
      </div>

      {isAi && ai && ai.available && (
        <div className="chat-quota">
          오늘 남은 질문 {ai.remaining}회 <span className="dim">(하루 {ai.limit}회)</span>
        </div>
      )}
      {aiOff && (
        <div className="chat-quota warn">
          {ai.configured ? '부모님이 AI 대화를 꺼두셨어요.' : 'AI 기능이 아직 준비되지 않았어요.'}
        </div>
      )}

      <div className="chat-input">
        <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{ display: 'none' }} onChange={sendPhoto} />
        <input ref={albumRef} type="file" accept="image/*" style={{ display: 'none' }} onChange={sendPhoto} />
        <button className="chat-icon" disabled={busy || aiOff || aiEmpty}
          onClick={() => cameraRef.current.click()} title="촬영">📷</button>
        <button className="chat-icon" disabled={busy || aiOff || aiEmpty}
          onClick={() => albumRef.current.click()} title="앨범">🖼️</button>
        <textarea ref={taRef} rows={1} value={text} onChange={onInput}
          placeholder={aiEmpty ? '오늘 대화를 다 썼어요' : (isAi ? `${AI_NAME}에게 물어보기 (사진도 가능)` : '메시지 입력')}
          disabled={aiOff || aiEmpty} maxLength={MAX_TEXT} />
        <button className="chat-send" disabled={!canSend} onClick={sendText}>전송</button>
      </div>
      {sheet && (
        <div className="modal-bg" onClick={() => setSheet(null)}>
          <div className="chat-sheet" onClick={(e) => e.stopPropagation()}>
            <button onClick={() => { share(sheet); setSheet(null); }}>
              👨‍👩‍👧 가족방에 공유하기
            </button>
            <button className="danger" onClick={() => { const m = sheet; setSheet(null); remove(m); }}>
              🗑 삭제
            </button>
            <button className="cancel" onClick={() => setSheet(null)}>취소</button>
          </div>
        </div>
      )}
      {viewer && (
        <div className="modal-bg photo" onClick={() => setViewer(null)}>
          <AuthImg path={viewer} className="proof-full" alt="사진 크게 보기" />
        </div>
      )}
    </div>
  );
}
