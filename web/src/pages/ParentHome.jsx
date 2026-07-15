import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, t } from '../api.js';
import { toast } from '../toast.jsx';
import SettingsModal from '../settings.jsx';
import { getSubscriptionState, enablePush } from '../pushClient.js';
import usePullToRefresh from '../pullToRefresh.js';

const fmtDT = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// auth-protected proof photo: thumbnail + tap to enlarge
function ProofThumb({ path }) {
  const [url, setUrl] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let objUrl;
    let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/uploads/${path}`, {
          headers: { authorization: `Bearer ${getToken()}` },
        });
        if (res.ok && alive) {
          objUrl = URL.createObjectURL(await res.blob());
          setUrl(objUrl);
        }
      } catch { /* thumbnail is best-effort */ }
    })();
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [path]);
  if (!url) return null;
  return (<>
    <img className="proof-thumb" src={url} alt="증빙 사진" onClick={() => setOpen(true)} />
    {open && (
      <div className="modal-bg photo" onClick={() => setOpen(false)}>
        <img className="proof-full" src={url} alt="증빙 사진 크게 보기" />
      </div>
    )}
  </>);
}

export default function ParentHome({ me, refreshMe, logout }) {
  const [tab, setTab] = useState('approve');
  const [showSettings, setShowSettings] = useState(false);
  const [pushState, setPushState] = useState('unknown');
  const contentRef = useRef(null);
  const { ptr, refreshing, handlers } = usePullToRefresh(contentRef); // 당겨서 새로고침

  useEffect(() => { getSubscriptionState().then(setPushState).catch(() => {}); }, []);

  const turnOnPush = async () => {
    try {
      await enablePush();
      setPushState('subscribed');
      toast('알림이 켜졌어요! 적립 청구·사용권 사용 소식을 푸시로 알려드릴게요');
    } catch (ex) {
      if (ex.message === 'push_permission_denied') toast('알림 권한이 거부되었어요. 브라우저 설정에서 허용해 주세요', 'error');
      else if (ex.message === 'push_unsupported') toast('이 브라우저는 푸시를 지원하지 않아요. 홈 화면에 앱을 추가한 뒤 시도해 보세요', 'error');
      else toast(`알림 설정에 실패했어요 (${ex.message})`, 'error');
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{me.family_name} 관리</h1>
          <div className="who">{me.name} (부모)</div>
        </div>
        <div className="actions">
          <button onClick={() => setShowSettings(true)}>⚙️ 설정</button>
          <button onClick={logout}>로그아웃</button>
        </div>
      </div>
      <div className="content" ref={contentRef} {...handlers}>
        <div className="ptr" style={{ height: ptr }}>
          <span className={`ptr-ico ${refreshing.current ? 'spin' : (ptr >= 60 ? 'ready' : '')}`}>↻</span>
        </div>
        {tab === 'approve' && pushState === 'ready' && (
          <div className="push-banner">
            <div className="txt">🔔 적립 청구·사용권 사용 알림을 푸시로 받아보세요</div>
            <button className="small" onClick={turnOnPush}>알림 켜기</button>
          </div>
        )}
        {tab === 'approve' && <ApproveTab />}
        {tab === 'family' && <FamilyTab />}
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'payout' && <PayoutTab />}
      </div>
      {showSettings && <SettingsModal me={me} refreshMe={refreshMe} onClose={() => setShowSettings(false)} />}
      <nav className="tabbar">
        {[['approve', '✅', '승인'], ['family', '👨‍👩‍👧', '가족'],
          ['catalog', '🏷️', '항목관리'], ['payout', '💰', '정산']].map(([k, ico, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span className="ico">{ico}</span>{label}
          </button>
        ))}
      </nav>
    </>
  );
}

function ApproveTab() {
  const [pending, setPending] = useState([]);
  const [recent, setRecent] = useState([]);

  const load = useCallback(async () => {
    setPending(await api('GET', '/api/earn-requests?status=pending'));
    const decided = (await api('GET', '/api/earn-requests'))
      .filter((r) => r.status !== 'pending')
      .map((r) => ({
        key: `e${r.id}`, when: r.decided_at || r.created_at,
        title: `${r.user_name} · ${r.item_name}`, amount: r.points,
        pillClass: r.status, pillText: r.status === 'approved' ? '승인' : '거절',
      }));
    const adjusts = (await api('GET', '/api/ledger/family?source_type=adjust'))
      .map((l) => ({
        key: `a${l.id}`, when: l.created_at,
        title: `${l.user_name} · ${l.memo || (l.amount > 0 ? '지급' : '차감')}`,
        amount: l.amount,
        pillClass: l.amount > 0 ? 'approved' : 'rejected',
        pillText: l.amount > 0 ? `지급 +${l.amount}P` : `차감 ${l.amount}P`,
      }));
    setRecent([...decided, ...adjusts]
      .sort((a, b) => new Date(b.when) - new Date(a.when))
      .slice(0, 15));
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (r, action) => {
    try {
      await api('POST', `/api/earn-requests/${r.id}/${action}`);
      toast(action === 'approve'
        ? `${r.user_name} · ${r.item_name} +${r.points}P 승인 완료`
        : `${r.user_name} · ${r.item_name} 거절 처리했어요`);
      await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  return (
    <>
      <div className="section-title">승인 대기 {pending.length}건</div>
      <div className="card">
        {pending.map((r) => (
          <div className="row" key={r.id}>
            <div className="main">
              <div className="name">{r.user_name} · {r.item_name} +{r.points}P</div>
              <div className="meta">
                {fmtDT(r.created_at)}{r.comment ? ` · "${r.comment}"` : ''}
              </div>
            </div>
            {r.proof_path && <ProofThumb path={r.proof_path} />}
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small" onClick={() => decide(r, 'approve')}>승인</button>
              <button className="small danger" onClick={() => decide(r, 'reject')}>거절</button>
            </div>
          </div>
        ))}
        {pending.length === 0 && <p className="notice">대기 중인 청구가 없어요</p>}
      </div>
      <div className="section-title">최근 처리 (승인/거절·지급/차감)</div>
      <div className="card">
        {recent.map((r) => (
          <div className="row" key={r.key}>
            <div className="main">
              <div className="name">{r.title}</div>
              <div className="meta">{fmtDT(r.when)}</div>
            </div>
            <span className={`pill ${r.pillClass}`}>{r.pillText}</span>
          </div>
        ))}
        {recent.length === 0 && <p className="notice">처리 내역이 없어요</p>}
      </div>
    </>
  );
}

function FamilyTab() {
  const [users, setUsers] = useState([]);
  const [mode, setMode] = useState(null); // {type:'new'} | {type:'pin'|'adjust', user}
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => setUsers(await api('GET', '/api/users')), []);
  useEffect(() => { load(); }, [load]);

  const close = () => { setMode(null); setF({}); };

  const removeChild = async (u) => {
    if (!window.confirm(`'${u.name}' 계정을 삭제할까요?\n삭제하면 로그인할 수 없어요. (기록은 보존됩니다)`)) return;
    try {
      await api('DELETE', `/api/users/${u.id}`);
      toast(`${u.name} 계정을 삭제했어요`);
      await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  const run = async () => {
    setBusy(true);
    try {
      if (mode.type === 'new') {
        await api('POST', '/api/users', { login_id: f.login_id, name: f.name, pin: f.pin });
        toast(`${f.name} 계정을 만들었어요`);
      } else if (mode.type === 'pin') {
        await api('POST', `/api/users/${mode.user.id}/reset-pin`, { pin: f.pin });
        toast(`${mode.user.name}의 PIN을 재설정했어요`);
      } else if (mode.type === 'adjust') {
        const amt = Number(f.amount);
        await api('POST', `/api/users/${mode.user.id}/adjust`, { amount: amt, memo: f.memo || '' });
        toast(amt > 0
          ? `${mode.user.name}에게 ${amt}P 지급 완료`
          : `${mode.user.name}에게 ${Math.abs(amt)}P 차감 완료`);
      }
      close(); await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  return (
    <>
      <div className="card">
        <h3>가족 구성원</h3>
        {users.map((u) => (
          <div className="row" key={u.id}>
            <div className="main">
              <div className="name">{u.role === 'parent' ? '👤' : '🧒'} {u.name}</div>
              <div className="meta">@{u.login_id} · {u.balance.toLocaleString()}P</div>
            </div>
            {u.role === 'child' && (
              <div style={{ display: 'flex', gap: 6 }}>
                <button className="small ghost" onClick={() => { setMode({ type: 'pin', user: u }); setF({}); }}>PIN</button>
                <button className="small ghost" onClick={() => { setMode({ type: 'adjust', user: u }); setF({}); }}>지급/차감</button>
                <button className="small danger" onClick={() => removeChild(u)}>삭제</button>
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="primary" onClick={() => { setMode({ type: 'new' }); setF({}); }}>+ 자녀 계정 만들기</button>
      {mode && (
        <div className="modal-bg" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{mode.type === 'new' ? '자녀 계정 만들기'
                : mode.type === 'pin' ? `${mode.user.name} PIN 재설정`
                : `${mode.user.name} 마일리지 지급/차감`}</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>
            {mode.type === 'new' && (<>
              <label className="fld">이름</label>
              <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <label className="fld">아이디 (영문/숫자)</label>
              <input value={f.login_id || ''} autoCapitalize="none" onChange={(e) => setF({ ...f, login_id: e.target.value })} />
              <label className="fld">PIN (숫자 4~6자리)</label>
              <input inputMode="numeric" value={f.pin || ''} onChange={(e) => setF({ ...f, pin: e.target.value })} />
            </>)}
            {mode.type === 'pin' && (<>
              <label className="fld">새 PIN (숫자 4~6자리)</label>
              <input inputMode="numeric" value={f.pin || ''} onChange={(e) => setF({ ...f, pin: e.target.value })} />
            </>)}
            {mode.type === 'adjust' && (<>
              <label className="fld">포인트 (양수=지급, 음수=차감)</label>
              <input inputMode="numeric" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="예: 100 또는 -50" />
              <label className="fld">메모</label>
              <input value={f.memo || ''} onChange={(e) => setF({ ...f, memo: e.target.value })} placeholder="예: 생일 보너스" />
            </>)}
            <div className="btn-row">
              <button className="primary" disabled={busy} onClick={run}>확인</button>
              <button className="cancel" onClick={close}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function CatalogTab() {
  const [earn, setEarn] = useState([]);
  const [spend, setSpend] = useState([]);
  const [mode, setMode] = useState(null);
  const [f, setF] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setEarn(await api('GET', '/api/catalog/earn'));
    setSpend(await api('GET', '/api/catalog/spend'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const close = () => { setMode(null); setF({}); };

  const save = async () => {
    setBusy(true);
    try {
      if (mode.cat === 'earn') {
        const body = {
          name: f.name, points: Number(f.points), proof_required: Boolean(f.proof_required),
          daily_limit: f.daily_limit ? Number(f.daily_limit) : null,
        };
        if (mode.item) await api('PATCH', `/api/catalog/earn/${mode.item.id}`, body);
        else await api('POST', '/api/catalog/earn', body);
      } else {
        const body = {
          name: f.name, kind: f.kind, price_points: Number(f.price_points),
          unit_minutes: f.kind === 'time_voucher' ? Number(f.unit_minutes) : undefined,
        };
        if (mode.item) await api('PATCH', `/api/catalog/spend/${mode.item.id}`, body);
        else await api('POST', '/api/catalog/spend', body);
      }
      toast(mode.item ? '항목을 수정했어요' : '항목을 추가했어요');
      close(); await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  const toggle = async (cat, item) => {
    try {
      await api('PATCH', `/api/catalog/${cat}/${item.id}`, { active: !item.active });
      toast(item.active ? `'${item.name}' 항목을 숨겼어요` : `'${item.name}' 항목을 표시했어요`);
      await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  // 순서 변경: 로컬 배열을 옮긴 뒤 전체 id 순서를 서버에 저장
  const [drag, setDrag] = useState(null); // { cat, index }
  const saveOrder = async (cat, list) => {
    try {
      await api('POST', `/api/catalog/${cat}/reorder`, { ids: list.map((x) => x.id) });
    } catch (ex) { toast(t(ex.message), 'error'); await load(); }
  };
  const move = (cat, index, dir) => {
    const list = cat === 'earn' ? [...earn] : [...spend];
    const j = index + dir;
    if (j < 0 || j >= list.length) return;
    [list[index], list[j]] = [list[j], list[index]];
    (cat === 'earn' ? setEarn : setSpend)(list);
    saveOrder(cat, list);
  };
  const onDrop = (cat, index) => {
    if (!drag || drag.cat !== cat || drag.index === index) { setDrag(null); return; }
    const list = cat === 'earn' ? [...earn] : [...spend];
    const [moved] = list.splice(drag.index, 1);
    list.splice(index, 0, moved);
    (cat === 'earn' ? setEarn : setSpend)(list);
    setDrag(null);
    saveOrder(cat, list);
  };
  const dragProps = (cat, index) => ({
    draggable: true,
    onDragStart: () => setDrag({ cat, index }),
    onDragOver: (e) => e.preventDefault(),
    onDrop: () => onDrop(cat, index),
    onDragEnd: () => setDrag(null),
    style: drag && drag.cat === cat && drag.index === index ? { opacity: 0.4 } : undefined,
  });
  const OrderBtns = ({ cat, index, len }) => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <button className="small ghost" style={{ padding: '0 6px', lineHeight: '16px' }}
        disabled={index === 0} onClick={() => move(cat, index, -1)}>▲</button>
      <button className="small ghost" style={{ padding: '0 6px', lineHeight: '16px' }}
        disabled={index === len - 1} onClick={() => move(cat, index, 1)}>▼</button>
    </div>
  );

  return (
    <>
      <div className="section-title">적립 항목</div>
      <div className="card">
        {earn.map((it, i) => (
          <div className="row" key={it.id} {...dragProps('earn', i)}>
            <OrderBtns cat="earn" index={i} len={earn.length} />
            <div className="main">
              <div className="name" style={{ opacity: it.active ? 1 : 0.4 }}>{it.name}</div>
              <div className="meta">
                +{it.points}P{it.proof_required ? ' · 📷' : ''}
                {it.daily_limit ? ` · 1일 ${it.daily_limit}회` : ''}{it.active ? '' : ' · 숨김'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small ghost" onClick={() => { setMode({ cat: 'earn', item: it }); setF({ ...it, daily_limit: it.daily_limit || '' }); }}>수정</button>
              <button className="small ghost" onClick={() => toggle('earn', it)}>{it.active ? '숨김' : '표시'}</button>
            </div>
          </div>
        ))}
        <div style={{ paddingTop: 10 }}>
          <button className="small" onClick={() => { setMode({ cat: 'earn' }); setF({}); }}>+ 적립 항목 추가</button>
        </div>
      </div>
      <div className="section-title">상점 항목 (가격표)</div>
      <div className="card">
        {spend.map((it, i) => (
          <div className="row" key={it.id} {...dragProps('spend', i)}>
            <OrderBtns cat="spend" index={i} len={spend.length} />
            <div className="main">
              <div className="name" style={{ opacity: it.active ? 1 : 0.4 }}>
                {it.kind === 'cash' ? '💰' : '🎟️'} {it.name}
              </div>
              <div className="meta">{it.price_points}P{it.unit_minutes ? ` · ${it.unit_minutes}분` : ''}{it.active ? '' : ' · 숨김'}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small ghost" onClick={() => { setMode({ cat: 'spend', item: it }); setF({ ...it }); }}>수정</button>
              <button className="small ghost" onClick={() => toggle('spend', it)}>{it.active ? '숨김' : '표시'}</button>
            </div>
          </div>
        ))}
        <div style={{ paddingTop: 10 }}>
          <button className="small" onClick={() => { setMode({ cat: 'spend' }); setF({ kind: 'time_voucher' }); }}>+ 상점 항목 추가</button>
        </div>
      </div>
      {mode && (
        <div className="modal-bg" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{mode.item ? '항목 수정' : '항목 추가'}</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>
            <label className="fld">이름</label>
            <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
            {mode.cat === 'earn' ? (<>
              <label className="fld">적립 포인트</label>
              <input inputMode="numeric" value={f.points || ''} onChange={(e) => setF({ ...f, points: e.target.value })} />
              <label className="fld" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(f.proof_required)}
                  onChange={(e) => setF({ ...f, proof_required: e.target.checked })} /> 사진 인증 필요
              </label>
              <label className="fld">1일 청구 횟수 제한</label>
              <select value={f.daily_limit || ''} onChange={(e) => setF({ ...f, daily_limit: e.target.value })}>
                <option value="">제한 없음</option>
                <option value="1">1일 1회</option>
                <option value="2">1일 2회</option>
                <option value="3">1일 3회</option>
              </select>
            </>) : (<>
              <label className="fld">종류</label>
              <select value={f.kind || 'time_voucher'} onChange={(e) => setF({ ...f, kind: e.target.value })} disabled={Boolean(mode.item)}>
                <option value="time_voucher">시간권 (휴대폰/PC/게임)</option>
                <option value="cash">용돈 교환</option>
              </select>
              {f.kind !== 'cash' && (<>
                <label className="fld">1개당 시간(분)</label>
                <input inputMode="numeric" value={f.unit_minutes || ''} onChange={(e) => setF({ ...f, unit_minutes: e.target.value })} />
              </>)}
              <label className="fld">가격 (포인트)</label>
              <input inputMode="numeric" value={f.price_points || ''} onChange={(e) => setF({ ...f, price_points: e.target.value })} />
            </>)}
            <div className="btn-row">
              <button className="primary" disabled={busy} onClick={save}>저장</button>
              <button className="cancel" onClick={close}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function PayoutTab() {
  const [pending, setPending] = useState([]);
  const [done, setDone] = useState([]);
  const load = useCallback(async () => {
    setPending(await api('GET', '/api/orders?status=payout_pending'));
    setDone((await api('GET', '/api/orders?status=settled')).slice(0, 10));
  }, []);
  useEffect(() => { load(); }, [load]);

  const settle = async (o) => {
    try {
      await api('POST', `/api/orders/${o.id}/settle`);
      toast(`${o.user_name} · ${o.item_name} 정산 완료`);
      await load();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  return (
    <>
      <div className="section-title">현금 지급 대기 {pending.length}건</div>
      <div className="card">
        {pending.map((o) => (
          <div className="row" key={o.id}>
            <div className="main">
              <div className="name">{o.user_name} · {o.item_name}</div>
              <div className="meta">{fmtDT(o.created_at)} · -{o.total_points}P</div>
            </div>
            <button className="small" onClick={() => settle(o)}>지급완료</button>
          </div>
        ))}
        {pending.length === 0 && <p className="notice">지급 대기 건이 없어요</p>}
      </div>
      <div className="section-title">정산 완료</div>
      <div className="card">
        {done.map((o) => (
          <div className="row" key={o.id}>
            <div className="main">
              <div className="name">{o.user_name} · {o.item_name}</div>
              <div className="meta">{fmtDT(o.settled_at)}</div>
            </div>
            <span className="pill settled">정산완료</span>
          </div>
        ))}
        {done.length === 0 && <p className="notice">정산 내역이 없어요</p>}
      </div>
    </>
  );
}
