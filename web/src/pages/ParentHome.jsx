import React, { useEffect, useState, useCallback } from 'react';
import { api, t } from '../api.js';

const fmtDT = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function ParentHome({ me, logout }) {
  const [tab, setTab] = useState('approve');
  return (
    <>
      <div className="topbar">
        <div>
          <h1>{me.family_name} 관리</h1>
          <div className="who">{me.name} (부모)</div>
        </div>
        <button onClick={logout}>로그아웃</button>
      </div>
      <div className="content">
        {tab === 'approve' && <ApproveTab />}
        {tab === 'family' && <FamilyTab />}
        {tab === 'catalog' && <CatalogTab />}
        {tab === 'payout' && <PayoutTab />}
      </div>
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
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setPending(await api('GET', '/api/earn-requests?status=pending'));
    const all = await api('GET', '/api/earn-requests');
    setRecent(all.filter((r) => r.status !== 'pending').slice(0, 10));
  }, []);
  useEffect(() => { load(); }, [load]);

  const decide = async (id, action) => {
    setMsg('');
    try { await api('POST', `/api/earn-requests/${id}/${action}`); await load(); }
    catch (ex) { setMsg(t(ex.message)); }
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
                {r.proof_path && <> · <a href={`/api/uploads/${r.proof_path}`} target="_blank" rel="noreferrer">📷 사진</a></>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small" onClick={() => decide(r.id, 'approve')}>승인</button>
              <button className="small danger" onClick={() => decide(r.id, 'reject')}>거절</button>
            </div>
          </div>
        ))}
        {pending.length === 0 && <p className="notice">대기 중인 청구가 없어요</p>}
      </div>
      {msg && <p className="error">{msg}</p>}
      <div className="section-title">최근 처리</div>
      <div className="card">
        {recent.map((r) => (
          <div className="row" key={r.id}>
            <div className="main">
              <div className="name">{r.user_name} · {r.item_name}</div>
              <div className="meta">{fmtDT(r.created_at)} · +{r.points}P</div>
            </div>
            <span className={`pill ${r.status}`}>{r.status === 'approved' ? '승인' : '거절'}</span>
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
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => setUsers(await api('GET', '/api/users')), []);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setMsg('');
    try {
      if (mode.type === 'new') {
        await api('POST', '/api/users', { login_id: f.login_id, name: f.name, pin: f.pin });
      } else if (mode.type === 'pin') {
        await api('POST', `/api/users/${mode.user.id}/reset-pin`, { pin: f.pin });
      } else if (mode.type === 'adjust') {
        await api('POST', `/api/users/${mode.user.id}/adjust`, { amount: Number(f.amount), memo: f.memo || '' });
      }
      setMode(null); setF({}); await load();
    } catch (ex) { setMsg(t(ex.message)); }
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
              </div>
            )}
          </div>
        ))}
      </div>
      <button className="primary" onClick={() => { setMode({ type: 'new' }); setF({}); }}>+ 자녀 계정 만들기</button>
      {msg && <p className="error">{msg}</p>}
      {mode && (
        <div className="modal-bg" onClick={() => setMode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            {mode.type === 'new' && (<>
              <h3>자녀 계정 만들기</h3>
              <label className="fld">이름</label>
              <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
              <label className="fld">아이디 (영문/숫자)</label>
              <input value={f.login_id || ''} autoCapitalize="none" onChange={(e) => setF({ ...f, login_id: e.target.value })} />
              <label className="fld">PIN (숫자 4~6자리)</label>
              <input inputMode="numeric" value={f.pin || ''} onChange={(e) => setF({ ...f, pin: e.target.value })} />
            </>)}
            {mode.type === 'pin' && (<>
              <h3>{mode.user.name} PIN 재설정</h3>
              <label className="fld">새 PIN (숫자 4~6자리)</label>
              <input inputMode="numeric" value={f.pin || ''} onChange={(e) => setF({ ...f, pin: e.target.value })} />
            </>)}
            {mode.type === 'adjust' && (<>
              <h3>{mode.user.name} 마일리지 지급/차감</h3>
              <label className="fld">포인트 (양수=지급, 음수=차감)</label>
              <input inputMode="numeric" value={f.amount || ''} onChange={(e) => setF({ ...f, amount: e.target.value })} placeholder="예: 100 또는 -50" />
              <label className="fld">메모</label>
              <input value={f.memo || ''} onChange={(e) => setF({ ...f, memo: e.target.value })} placeholder="예: 생일 보너스" />
            </>)}
            <div style={{ height: 16 }} />
            <button className="primary" onClick={run}>확인</button>
          </div>
        </div>
      )}
    </>
  );
}

function CatalogTab() {
  const [earn, setEarn] = useState([]);
  const [spend, setSpend] = useState([]);
  const [mode, setMode] = useState(null); // {cat:'earn'|'spend', item?}
  const [f, setF] = useState({});
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setEarn(await api('GET', '/api/catalog/earn'));
    setSpend(await api('GET', '/api/catalog/spend'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setMsg('');
    try {
      if (mode.cat === 'earn') {
        const body = { name: f.name, points: Number(f.points), proof_required: Boolean(f.proof_required) };
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
      setMode(null); setF({}); await load();
    } catch (ex) { setMsg(t(ex.message)); }
  };

  const toggle = async (cat, item) => {
    await api('PATCH', `/api/catalog/${cat}/${item.id}`, { active: !item.active });
    await load();
  };

  return (
    <>
      <div className="section-title">적립 항목</div>
      <div className="card">
        {earn.map((it) => (
          <div className="row" key={it.id}>
            <div className="main">
              <div className="name" style={{ opacity: it.active ? 1 : 0.4 }}>{it.name}</div>
              <div className="meta">+{it.points}P{it.proof_required ? ' · 📷' : ''}{it.active ? '' : ' · 숨김'}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="small ghost" onClick={() => { setMode({ cat: 'earn', item: it }); setF({ ...it }); }}>수정</button>
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
        {spend.map((it) => (
          <div className="row" key={it.id}>
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
      {msg && <p className="error">{msg}</p>}
      {mode && (
        <div className="modal-bg" onClick={() => setMode(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{mode.item ? '항목 수정' : '항목 추가'}</h3>
            <label className="fld">이름</label>
            <input value={f.name || ''} onChange={(e) => setF({ ...f, name: e.target.value })} />
            {mode.cat === 'earn' ? (<>
              <label className="fld">적립 포인트</label>
              <input inputMode="numeric" value={f.points || ''} onChange={(e) => setF({ ...f, points: e.target.value })} />
              <label className="fld" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={Boolean(f.proof_required)}
                  onChange={(e) => setF({ ...f, proof_required: e.target.checked })} /> 사진 인증 필요
              </label>
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
            <div style={{ height: 16 }} />
            <button className="primary" onClick={save}>저장</button>
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

  const settle = async (id) => { await api('POST', `/api/orders/${id}/settle`); await load(); };

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
            <button className="small" onClick={() => settle(o.id)}>지급완료</button>
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
