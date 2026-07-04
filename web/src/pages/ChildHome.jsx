import React, { useEffect, useState, useCallback } from 'react';
import { api, t } from '../api.js';

const fmtDT = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function ChildHome({ me, refreshMe, logout }) {
  const [tab, setTab] = useState('home');
  const [vouchers, setVouchers] = useState({ remaining_minutes: 0, vouchers: [] });

  const loadVouchers = useCallback(async () => {
    setVouchers(await api('GET', '/api/vouchers'));
  }, []);
  useEffect(() => { loadVouchers(); }, [loadVouchers, tab]);

  const refreshAll = async () => { await refreshMe(); await loadVouchers(); };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>안녕, {me.name}! 👋</h1>
          <div className="who">{me.family_name}</div>
        </div>
        <button onClick={logout}>로그아웃</button>
      </div>
      <div className="content">
        {tab === 'home' && <HomeTab me={me} vouchers={vouchers} />}
        {tab === 'earn' && <EarnTab refreshAll={refreshAll} />}
        {tab === 'shop' && <ShopTab me={me} refreshAll={refreshAll} />}
        {tab === 'voucher' && <VoucherTab vouchers={vouchers} refreshAll={refreshAll} />}
        {tab === 'history' && <HistoryTab />}
      </div>
      <nav className="tabbar">
        {[['home', '🏠', '홈'], ['earn', '⭐', '적립'], ['shop', '🛍️', '상점'],
          ['voucher', '🎟️', '사용권'], ['history', '📋', '내역']].map(([k, ico, label]) => (
          <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            <span className="ico">{ico}</span>{label}
          </button>
        ))}
      </nav>
    </>
  );
}

function HomeTab({ me, vouchers }) {
  const [reqs, setReqs] = useState([]);
  useEffect(() => { api('GET', '/api/earn-requests').then(setReqs); }, []);
  return (
    <>
      <div className="balance-card">
        <div className="label">내 마일리지</div>
        <div className="value">{me.balance.toLocaleString()} P</div>
        <div className="sub">🎟️ 보유 사용권 {vouchers.remaining_minutes}분</div>
      </div>
      <div className="card">
        <h3>최근 적립 청구</h3>
        {reqs.slice(0, 5).map((r) => (
          <div className="row" key={r.id}>
            <div className="main">
              <div className="name">{r.item_name}</div>
              <div className="meta">{fmtDT(r.created_at)} · +{r.points}P</div>
            </div>
            <span className={`pill ${r.status}`}>
              {{ pending: '대기중', approved: '승인됨', rejected: '거절됨' }[r.status]}
            </span>
          </div>
        ))}
        {reqs.length === 0 && <p className="notice">아직 청구 내역이 없어요</p>}
      </div>
    </>
  );
}

function EarnTab({ refreshAll }) {
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(null);
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('GET', '/api/catalog/earn').then(setItems); }, []);

  const submit = async () => {
    setBusy(true); setMsg('');
    try {
      const fd = new FormData();
      fd.append('catalog_id', String(sel.id));
      fd.append('comment', comment);
      if (photo) fd.append('photo', photo);
      await api('POST', '/api/earn-requests', fd);
      setSel(null); setComment(''); setPhoto(null);
      setMsg('청구 완료! 부모님 승인을 기다려 주세요 😊');
      await refreshAll();
    } catch (ex) { setMsg(t(ex.message)); }
    setBusy(false);
  };

  return (
    <>
      <div className="section-title">할 일을 하고 마일리지를 받아요</div>
      <div className="card">
        {items.map((it) => (
          <div className="row" key={it.id}>
            <div className="main">
              <div className="name">{it.name}</div>
              <div className="meta">+{it.points}P{it.proof_required ? ' · 📷 사진 필요' : ''}</div>
            </div>
            <button className="small" onClick={() => { setSel(it); setMsg(''); }}>청구</button>
          </div>
        ))}
        {items.length === 0 && <p className="notice">적립 항목이 아직 없어요</p>}
      </div>
      {msg && <p className="notice">{msg}</p>}
      {sel && (
        <div className="modal-bg" onClick={() => setSel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{sel.name} (+{sel.points}P)</h3>
            <label className="fld">한마디 (선택)</label>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="예: 수학 숙제 다 했어요" />
            <label className="fld">사진 {sel.proof_required ? '(필수)' : '(선택)'}</label>
            <input type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files[0] || null)} />
            <div style={{ height: 16 }} />
            <button className="primary" disabled={busy || (sel.proof_required && !photo)} onClick={submit}>
              적립 청구하기
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function ShopTab({ me, refreshAll }) {
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(null);
  const [qty, setQty] = useState(1);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('GET', '/api/catalog/spend').then(setItems); }, []);

  const buy = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api('POST', '/api/orders', { catalog_id: sel.id, qty });
      setSel(null); setQty(1);
      setMsg(r.status === 'payout_pending'
        ? '용돈 교환 신청 완료! 부모님이 현금으로 주실 거예요 💰'
        : '구매 완료! 사용권 탭에서 확인해요 🎟️');
      await refreshAll();
    } catch (ex) { setMsg(t(ex.message)); }
    setBusy(false);
  };

  return (
    <>
      <div className="balance-card">
        <div className="label">사용 가능한 마일리지</div>
        <div className="value">{me.balance.toLocaleString()} P</div>
      </div>
      <div className="card">
        {items.map((it) => (
          <div className="row" key={it.id}>
            <div className="main">
              <div className="name">{it.kind === 'cash' ? '💰 ' : '🎟️ '}{it.name}</div>
              <div className="meta">{it.price_points}P{it.unit_minutes ? ` · ${it.unit_minutes}분` : ''}</div>
            </div>
            <button className="small" disabled={me.balance < it.price_points}
              onClick={() => { setSel(it); setQty(1); setMsg(''); }}>구매</button>
          </div>
        ))}
        {items.length === 0 && <p className="notice">상점 항목이 아직 없어요</p>}
      </div>
      {msg && <p className="notice">{msg}</p>}
      {sel && (
        <div className="modal-bg" onClick={() => setSel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{sel.name}</h3>
            {sel.kind === 'time_voucher' && (
              <div className="stepper" style={{ margin: '10px 0' }}>
                <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
                <span>{qty}개</span>
                <button onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
              </div>
            )}
            <p className="notice">총 {sel.price_points * qty}P 차감 · 내 잔액 {me.balance}P</p>
            <button className="primary" disabled={busy || me.balance < sel.price_points * qty} onClick={buy}>
              {sel.price_points * qty}P로 구매하기
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function VoucherTab({ vouchers, refreshAll }) {
  const [minutes, setMinutes] = useState(30);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const active = vouchers.vouchers.filter((v) => v.status === 'active');
  const past = vouchers.vouchers.filter((v) => v.status !== 'active');

  const consume = async () => {
    setBusy(true); setMsg('');
    try {
      const r = await api('POST', '/api/vouchers/consume', { minutes: Number(minutes) });
      setMsg(`${r.used}분 사용 완료! 남은 사용권 ${r.remaining}분`);
      await refreshAll();
    } catch (ex) { setMsg(t(ex.message)); }
    setBusy(false);
  };

  return (
    <>
      <div className="balance-card">
        <div className="label">보유 사용권</div>
        <div className="value">{vouchers.remaining_minutes}분</div>
        <div className="sub">사용권 {active.length}장 보유 중</div>
      </div>
      <div className="card">
        <h3>사용하기</h3>
        <div className="stepper">
          <button onClick={() => setMinutes(Math.max(10, minutes - 10))}>−</button>
          <span>{minutes}분</span>
          <button onClick={() => setMinutes(minutes + 10)}>+</button>
          <button className="small" style={{ marginLeft: 'auto' }}
            disabled={busy || vouchers.remaining_minutes < minutes} onClick={consume}>
            사용
          </button>
        </div>
        {msg && <p className="notice">{msg}</p>}
      </div>
      <div className="card">
        <h3>내 사용권</h3>
        {active.map((v) => (
          <div className="row" key={v.id}>
            <div className="main">
              <div className="name">{v.label}</div>
              <div className="meta">잔여 {v.remaining_minutes}/{v.total_minutes}분</div>
            </div>
            <span className="pill active">보유</span>
          </div>
        ))}
        {past.slice(0, 10).map((v) => (
          <div className="row" key={v.id}>
            <div className="main">
              <div className="name">{v.label}</div>
              <div className="meta">{fmtDT(v.created_at)}</div>
            </div>
            <span className="pill consumed">사용완료</span>
          </div>
        ))}
        {vouchers.vouchers.length === 0 && <p className="notice">사용권이 없어요. 상점에서 구매해요!</p>}
      </div>
    </>
  );
}

function HistoryTab() {
  const [rows, setRows] = useState([]);
  useEffect(() => { api('GET', '/api/ledger').then(setRows); }, []);
  const label = { earn: '적립', spend: '사용', adjust: '보정' };
  return (
    <div className="card">
      <h3>마일리지 내역</h3>
      {rows.map((r) => (
        <div className="row" key={r.id}>
          <div className="main">
            <div className="name">{r.memo || label[r.source_type]}</div>
            <div className="meta">{fmtDT(r.created_at)} · {label[r.source_type]}</div>
          </div>
          <span className={r.amount > 0 ? 'amt-plus' : 'amt-minus'}>
            {r.amount > 0 ? '+' : ''}{r.amount}P
          </span>
        </div>
      ))}
      {rows.length === 0 && <p className="notice">아직 내역이 없어요</p>}
    </div>
  );
}
