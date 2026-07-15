import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, t } from '../api.js';
import { toast } from '../toast.jsx';
import SettingsModal from '../settings.jsx';
import { getSubscriptionState, enablePush } from '../pushClient.js';
import usePullToRefresh from '../pullToRefresh.js';

const fmtDT = (s) => new Date(s).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export default function ChildHome({ me, refreshMe, logout }) {
  const [tab, setTab] = useState('home');
  const [showSettings, setShowSettings] = useState(false);
  const [vouchers, setVouchers] = useState({ remaining_minutes: 0, vouchers: [] });
  const [pushState, setPushState] = useState('unknown');
  const [tick, setTick] = useState(0);        // 자동 새로고침 트리거
  const contentRef = useRef(null);
  const { ptr, refreshing, handlers } = usePullToRefresh(contentRef); // 당겨서 새로고침

  useEffect(() => { getSubscriptionState().then(setPushState).catch(() => {}); }, []);

  // 자동 새로고침: 20초마다 + 앱이 다시 보이거나 포커스될 때
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const iv = setInterval(bump, 20000);
    const onVis = () => { if (document.visibilityState === 'visible') bump(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', bump);
    return () => {
      clearInterval(iv);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', bump);
    };
  }, []);

  const turnOnPush = async () => {
    try {
      await enablePush();
      setPushState('subscribed');
      toast('알림이 켜졌어요! 승인 결과를 푸시로 알려드릴게요');
    } catch (ex) {
      if (ex.message === 'push_permission_denied') toast('알림 권한이 거부되었어요. 브라우저 설정에서 허용해 주세요', 'error');
      else if (ex.message === 'push_unsupported') toast('이 브라우저는 푸시를 지원하지 않아요. 홈 화면에 앱을 추가한 뒤 시도해 보세요', 'error');
      else toast(`알림 설정에 실패했어요 (${ex.message})`, 'error');
    }
  };

  const loadVouchers = useCallback(async () => {
    setVouchers(await api('GET', '/api/vouchers'));
  }, []);
  useEffect(() => { loadVouchers(); }, [loadVouchers, tab]);

  const refreshAll = async () => { await refreshMe(); await loadVouchers(); };

  // tick이 바뀌면 잔액·사용권을 조용히 다시 불러온다 (탭 데이터는 각 탭이 tick으로 갱신)
  useEffect(() => { if (tick > 0) refreshAll(); }, [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className="topbar">
        <div>
          <h1>안녕, {me.name}! 👋</h1>
          <div className="who">{me.family_name}</div>
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
        {tab === 'home' && pushState === 'ready' && (
          <div className="push-banner">
            <div className="txt">🔔 적립 승인 소식을 푸시 알림으로 받아보세요</div>
            <button className="small" onClick={turnOnPush}>알림 켜기</button>
          </div>
        )}
        {tab === 'home' && <HomeTab me={me} vouchers={vouchers} refreshAll={refreshAll} tick={tick} />}
        {tab === 'earn' && <EarnTab refreshAll={refreshAll} tick={tick} />}
        {tab === 'shop' && <ShopTab me={me} refreshAll={refreshAll} tick={tick} />}
        {tab === 'voucher' && <VoucherTab vouchers={vouchers} refreshAll={refreshAll} />}
        {tab === 'history' && <HistoryTab tick={tick} />}
      </div>
      {showSettings && <SettingsModal me={me} refreshMe={refreshMe} onClose={() => setShowSettings(false)} />}
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

function HomeTab({ me, vouchers, refreshAll, tick }) {
  const [reqs, setReqs] = useState([]);
  const load = useCallback(async () => setReqs(await api('GET', '/api/earn-requests')), []);
  useEffect(() => { load(); }, [load, tick]);

  const cancel = async (r) => {
    if (!window.confirm(`'${r.item_name}' 청구를 취소할까요?`)) return;
    try {
      await api('DELETE', `/api/earn-requests/${r.id}`);
      toast('청구가 취소되었어요');
      await load(); await refreshAll();
    } catch (ex) { toast(t(ex.message), 'error'); }
  };

  return (
    <>
      <div className="balance-card">
        <div className="label">내 마일리지</div>
        <div className="value">{me.balance.toLocaleString()} P</div>
        <div className="sub">🎟️ 보유 사용권 {vouchers.remaining_minutes}분</div>
      </div>
      <div className="card">
        <h3>최근 적립 청구</h3>
        {reqs.slice(0, 7).map((r) => (
          <div className="row" key={r.id}>
            <div className="main">
              <div className="name">{r.item_name}</div>
              <div className="meta">{fmtDT(r.created_at)} · +{r.points}P</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className={`pill ${r.status}`}>
                {{ pending: '대기중', approved: '승인됨', rejected: '거절됨' }[r.status]}
              </span>
              {r.status === 'pending' && (
                <button className="small danger" onClick={() => cancel(r)}>취소</button>
              )}
            </div>
          </div>
        ))}
        {reqs.length === 0 && <p className="notice">아직 청구 내역이 없어요</p>}
      </div>
    </>
  );
}

function EarnTab({ refreshAll, tick }) {
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(null);
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState(null);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef(null);
  const albumRef = useRef(null);

  const loadItems = useCallback(async () => setItems(await api('GET', '/api/catalog/earn')), []);
  useEffect(() => { loadItems(); }, [loadItems, tick]);

  const close = () => { setSel(null); setComment(''); setPhoto(null); };
  const pickPhoto = (e) => {
    setPhoto(e.target.files[0] || null);
    e.target.value = ''; // allow re-selecting the same file
  };

  const submit = async () => {
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('catalog_id', String(sel.id));
      fd.append('comment', comment);
      if (photo) fd.append('photo', photo);
      await api('POST', '/api/earn-requests', fd);
      toast(`'${sel.name}' 청구 완료! 승인을 기다려 주세요`);
      close();
      await refreshAll(); await loadItems();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  return (
    <>
      <div className="section-title">할 일을 하고 마일리지를 받아요</div>
      <div className="card">
        {items.map((it) => {
          const capped = it.daily_limit && it.used_today >= it.daily_limit;
          return (
            <div className="row" key={it.id}>
              <div className="main">
                <div className="name" style={{ opacity: capped ? 0.45 : 1 }}>{it.name}</div>
                <div className="meta">
                  +{it.points}P{it.proof_required ? ' · 📷 사진 필요' : ''}
                  {it.daily_limit ? ` · 오늘 ${Math.min(it.used_today, it.daily_limit)}/${it.daily_limit}회` : ''}
                </div>
              </div>
              <button className="small" disabled={Boolean(capped)} onClick={() => setSel(it)}>
                {capped ? '오늘 완료' : '청구'}
              </button>
            </div>
          );
        })}
        {items.length === 0 && <p className="notice">적립 항목이 아직 없어요</p>}
      </div>
      {sel && (
        <div className="modal-bg" onClick={close}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{sel.name} (+{sel.points}P)</h3>
              <button className="modal-close" onClick={close}>✕</button>
            </div>
            <label className="fld">한마디 (선택)</label>
            <input value={comment} onChange={(e) => setComment(e.target.value)} placeholder="예: 수학 숙제 다 했어요" />
            <label className="fld">사진 {sel.proof_required ? '(필수)' : '(선택)'}</label>
            <input ref={cameraRef} type="file" accept="image/*" capture="environment"
              style={{ display: 'none' }} onChange={pickPhoto} />
            <input ref={albumRef} type="file" accept="image/*"
              style={{ display: 'none' }} onChange={pickPhoto} />
            {!photo ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="small" style={{ flex: 1 }} onClick={() => cameraRef.current.click()}>
                  📷 촬영하기
                </button>
                <button className="small ghost" style={{ flex: 1 }} onClick={() => albumRef.current.click()}>
                  🖼️ 앨범에서 선택
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <img src={URL.createObjectURL(photo)} alt="첨부 사진"
                  style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 10 }} />
                <div style={{ flex: 1, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  사진 1장 첨부됨
                </div>
                <button className="small danger" onClick={() => setPhoto(null)}>지우기</button>
              </div>
            )}
            <div className="btn-row">
              <button className="primary" disabled={busy || (sel.proof_required && !photo)} onClick={submit}>
                적립 청구하기
              </button>
              <button className="cancel" onClick={close}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ShopTab({ me, refreshAll, tick }) {
  const [items, setItems] = useState([]);
  const [sel, setSel] = useState(null);
  const [qty, setQty] = useState(1);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api('GET', '/api/catalog/spend').then(setItems); }, [tick]);

  const open = (it) => {
    if (me.balance < it.price_points) {
      toast(`마일리지가 부족해요 (필요 ${it.price_points}P · 보유 ${me.balance}P)`, 'error');
      return;
    }
    setSel(it); setQty(1);
  };

  const buy = async () => {
    if (me.balance < sel.price_points * qty) {
      toast(`마일리지가 부족해요 (필요 ${sel.price_points * qty}P · 보유 ${me.balance}P)`, 'error');
      return;
    }
    setBusy(true);
    try {
      const r = await api('POST', '/api/orders', { catalog_id: sel.id, qty });
      toast(r.status === 'payout_pending'
        ? '용돈 교환 신청 완료! 부모님이 현금으로 주실 거예요'
        : `구매 완료! ${sel.name} ${qty}개가 사용권에 추가됐어요`);
      setSel(null); setQty(1);
      await refreshAll();
    } catch (ex) { toast(t(ex.message), 'error'); }
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
            <button className="small" onClick={() => open(it)}>구매</button>
          </div>
        ))}
        {items.length === 0 && <p className="notice">상점 항목이 아직 없어요</p>}
      </div>
      {sel && (
        <div className="modal-bg" onClick={() => setSel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>{sel.name}</h3>
              <button className="modal-close" onClick={() => setSel(null)}>✕</button>
            </div>
            {sel.kind === 'time_voucher' && (
              <div className="stepper" style={{ margin: '10px 0' }}>
                <button onClick={() => setQty(Math.max(1, qty - 1))}>−</button>
                <span>{qty}개</span>
                <button onClick={() => setQty(Math.min(20, qty + 1))}>+</button>
              </div>
            )}
            <p className="notice">총 {sel.price_points * qty}P 차감 · 내 잔액 {me.balance}P</p>
            <div className="btn-row">
              <button className="primary" disabled={busy || me.balance < sel.price_points * qty} onClick={buy}>
                {sel.price_points * qty}P로 구매하기
              </button>
              <button className="cancel" onClick={() => setSel(null)}>취소</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function VoucherTab({ vouchers, refreshAll }) {
  const [busy, setBusy] = useState(false);
  const active = vouchers.vouchers.filter((v) => v.status === 'active');
  const past = vouchers.vouchers.filter((v) => v.status !== 'active');

  const useOne = async (v) => {
    if (!window.confirm(`'${v.label}' (${v.remaining_minutes}분)을 지금 사용할까요?`)) return;
    setBusy(true);
    try {
      const r = await api('POST', `/api/vouchers/${v.id}/use`);
      toast(`${v.label} ${r.used}분 사용 완료!`);
      await refreshAll();
    } catch (ex) { toast(t(ex.message), 'error'); }
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
        <h3>내 사용권</h3>
        {active.map((v) => (
          <div className="row" key={v.id}>
            <div className="main">
              <div className="name">{v.label}</div>
              <div className="meta">{v.remaining_minutes}분 · {fmtDT(v.created_at)} 구매</div>
            </div>
            <button className="small voucher-use-btn" disabled={busy} onClick={() => useOne(v)}>
              사용하기
            </button>
          </div>
        ))}
        {active.length === 0 && <p className="notice">보유 중인 사용권이 없어요. 상점에서 구매해요!</p>}
      </div>
      {past.length > 0 && (
        <div className="card">
          <h3>사용 완료</h3>
          {past.slice(0, 10).map((v) => (
            <div className="row" key={v.id}>
              <div className="main">
                <div className="name">{v.label}</div>
                <div className="meta">{fmtDT(v.created_at)}</div>
              </div>
              <span className="pill consumed">사용완료</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function HistoryTab({ tick }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    (async () => {
      // 마일리지 원장(적립/구매/보정) + 사용권 사용 기록을 시간순으로 합친다
      const [ledger, usage] = await Promise.all([
        api('GET', '/api/ledger'),
        api('GET', '/api/vouchers/usage').catch(() => []),
      ]);
      const label = { earn: '적립', spend: '구매', adjust: '보정' };
      const merged = [
        ...ledger.map((r) => ({
          key: `l${r.id}`, when: r.created_at, kind: label[r.source_type],
          name: r.memo || label[r.source_type],
          right: `${r.amount > 0 ? '+' : ''}${r.amount}P`,
          rightClass: r.amount > 0 ? 'amt-plus' : 'amt-minus',
        })),
        ...usage.map((u) => ({
          key: `u${u.voucher_id}-${u.first_used_at}`, when: u.first_used_at, kind: '사용',
          name: `🎟️ ${u.label} 사용`,
          right: `${u.used_minutes}분/${u.total_minutes}분`,
          rightClass: 'amt-minus',
        })),
      ].sort((a, b) => new Date(b.when) - new Date(a.when));
      setRows(merged);
    })();
  }, [tick]);

  return (
    <div className="card">
      <h3>마일리지 내역</h3>
      <p className="notice">최근 30일의 내역이 표시돼요</p>
      {rows.map((r) => (
        <div className="row" key={r.key}>
          <div className="main">
            <div className="name">{r.name}</div>
            <div className="meta">
              {fmtDT(r.when)} · <span className={`hist-kind ${r.kind === '사용' ? 'use' : r.kind === '구매' ? 'buy' : ''}`}>{r.kind}</span>
            </div>
          </div>
          <span className={r.rightClass}>{r.right}</span>
        </div>
      ))}
      {rows.length === 0 && <p className="notice">아직 내역이 없어요</p>}
    </div>
  );
}
