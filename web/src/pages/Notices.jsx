// 공지사항: 한 줄 공지 + 바로가기 섹션, 목록/상세/작성 오버레이 페이지 (부모·자녀 공용)
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { api, getToken, t } from '../api.js';
import { toast } from '../toast.jsx';

const fmtDTY = (s) => new Date(s).toLocaleString('ko-KR', { year: '2-digit', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// auth-protected image (본문 첨부 이미지, 탭하면 크게 보기)
function NoticeImage({ path }) {
  const [url, setUrl] = useState(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let objUrl; let alive = true;
    (async () => {
      try {
        const res = await fetch(`/api/uploads/${path}`, {
          headers: { authorization: `Bearer ${getToken()}` },
        });
        if (res.ok && alive) {
          objUrl = URL.createObjectURL(await res.blob());
          setUrl(objUrl);
        }
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [path]);
  if (!url) return null;
  return (<>
    <img className="notice-img" src={url} alt="공지 이미지" onClick={() => setOpen(true)} />
    {open && (
      <div className="modal-bg photo" onClick={() => setOpen(false)}>
        <img className="proof-full" src={url} alt="공지 이미지 크게 보기" />
      </div>
    )}
  </>);
}

// 승인 탭/자녀 홈에 들어가는 섹션: 타이틀+바로가기, 최신 공지 한 줄
export function NoticeSection({ me, tick }) {
  const [latest, setLatest] = useState(null);
  const [page, setPage] = useState(null); // {view:'list'} | {view:'detail',id,from} | {view:'write'}

  const load = useCallback(async () => {
    try { setLatest((await api('GET', '/api/notices/latest')).notice); } catch { /* 조용히 */ }
  }, []);
  useEffect(() => { load(); }, [load, tick]);

  return (<>
    <div className="section-title notice-head">
      <span>공지사항</span>
      <button className="linklike" onClick={() => setPage({ view: 'list' })}>바로가기 ›</button>
    </div>
    <div className="card">
      {latest ? (
        <div className="row tappable" onClick={() => setPage({ view: 'detail', id: latest.id, from: 'strip' })}>
          <div className="main notice-line">
            <span className="nt-title">{latest.title}</span>
            <span className="nt-author">-{latest.user_name}-</span>
          </div>
          <span className="chev">›</span>
        </div>
      ) : <p className="notice">등록된 공지가 없어요</p>}
    </div>
    {page && (
      <NoticePages me={me} page={page} setPage={setPage}
        onClose={() => { setPage(null); load(); }} />
    )}
  </>);
}

function NoticePages({ me, page, setPage, onClose }) {
  return (
    <div className="page-overlay">
      {page.view === 'list' && (
        <NoticeList
          onBack={onClose}
          onOpen={(id) => setPage({ view: 'detail', id, from: 'list' })}
          onWrite={() => setPage({ view: 'write' })} />
      )}
      {page.view === 'detail' && (
        <NoticeDetail me={me} id={page.id}
          onBack={() => (page.from === 'list' ? setPage({ view: 'list' }) : onClose())}
          onDeleted={() => (page.from === 'list' ? setPage({ view: 'list' }) : onClose())} />
      )}
      {page.view === 'write' && (
        <NoticeWrite onBack={() => setPage({ view: 'list' })}
          onDone={(id) => setPage({ view: 'detail', id, from: 'list' })} />
      )}
    </div>
  );
}

function PageHead({ title, onBack, right }) {
  return (
    <div className="page-head">
      <button className="back" onClick={onBack}>‹</button>
      <h2>{title}</h2>
      <div className="right">{right || null}</div>
    </div>
  );
}

function NoticeList({ onBack, onOpen, onWrite }) {
  const [data, setData] = useState({ rows: [], has_more: false });
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 20;
  const bodyRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        setData(await api('GET', `/api/notices?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`));
        if (bodyRef.current) bodyRef.current.scrollTop = 0;
      } catch (ex) { toast(t(ex.message), 'error'); }
    })();
  }, [page]);

  return (<>
    <PageHead title="공지사항" onBack={onBack}
      right={<button className="small" onClick={onWrite}>+ 작성</button>} />
    <div className="page-body" ref={bodyRef}>
      <div className="card">
        {data.rows.map((n) => (
          <div className="row tappable" key={n.id} onClick={() => onOpen(n.id)}>
            <div className="main">
              <div className="name">{n.title}</div>
              <div className="meta">{n.user_name} · {fmtDTY(n.created_at)}</div>
            </div>
            <span className="chev">›</span>
          </div>
        ))}
        {data.rows.length === 0 && <p className="notice">등록된 공지가 없어요</p>}
      </div>
      {(page > 0 || data.has_more) && (
        <div className="pager">
          <button className="small ghost" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ 이전</button>
          <span>{page + 1}페이지</span>
          <button className="small ghost" disabled={!data.has_more} onClick={() => setPage(page + 1)}>다음 ›</button>
        </div>
      )}
    </div>
  </>);
}

function NoticeDetail({ me, id, onBack, onDeleted }) {
  const [n, setN] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      try { setN(await api('GET', `/api/notices/${id}`)); }
      catch (ex) { toast(t(ex.message), 'error'); onBack(); }
    })();
  }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const canDelete = n && (n.user_id === me.id || me.role === 'parent' || me.role === 'super_admin');

  const remove = async () => {
    if (!window.confirm('이 공지사항을 삭제할까요?')) return;
    setBusy(true);
    try {
      await api('DELETE', `/api/notices/${id}`);
      toast('공지사항을 삭제했어요');
      onDeleted();
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  return (<>
    <PageHead title="공지사항" onBack={onBack} />
    <div className="page-body">
      {n && (<>
        <div className="card">
          <div className="nt-detail-title">{n.title}</div>
          <div className="meta" style={{ marginTop: 4 }}>{n.user_name} · {fmtDTY(n.created_at)}</div>
          <hr className="nt-hr" />
          {n.content ? <div className="nt-content">{n.content}</div> : null}
          {(n.images || []).map((p) => <NoticeImage key={p} path={p} />)}
          {!n.content && (!n.images || n.images.length === 0) && (
            <p className="notice">내용이 없어요</p>
          )}
        </div>
        {canDelete && (
          <button className="small danger" style={{ width: '100%', padding: 12 }}
            disabled={busy} onClick={remove}>공지 삭제</button>
        )}
      </>)}
    </div>
  </>);
}

function NoticeWrite({ onBack, onDone }) {
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [photos, setPhotos] = useState([]);
  const [busy, setBusy] = useState(false);
  const cameraRef = useRef(null);
  const albumRef = useRef(null);
  const MAX = 5;

  const pick = (e) => {
    const files = Array.from(e.target.files || []);
    setPhotos((p) => [...p, ...files].slice(0, MAX));
    e.target.value = '';
  };

  const submit = async () => {
    if (!title.trim()) { toast('제목을 입력해 주세요', 'error'); return; }
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('content', content);
      photos.forEach((p) => fd.append('photos', p));
      const r = await api('POST', '/api/notices', fd);
      toast('공지사항을 등록했어요');
      onDone(r.id);
    } catch (ex) { toast(t(ex.message), 'error'); }
    setBusy(false);
  };

  return (<>
    <PageHead title="공지 작성" onBack={onBack} />
    <div className="page-body">
      <div className="card">
        <label className="fld">제목</label>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="예: 이번 주말 계획" />
        <label className="fld">내용</label>
        <textarea rows={7} value={content} onChange={(e) => setContent(e.target.value)}
          placeholder="가족에게 알릴 내용을 적어 주세요" />
        <label className="fld">사진 (선택 · 최대 {MAX}장)</label>
        <input ref={cameraRef} type="file" accept="image/*" capture="environment"
          style={{ display: 'none' }} onChange={pick} />
        <input ref={albumRef} type="file" accept="image/*" multiple
          style={{ display: 'none' }} onChange={pick} />
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="small" style={{ flex: 1 }} disabled={photos.length >= MAX}
            onClick={() => cameraRef.current.click()}>📷 촬영하기</button>
          <button className="small ghost" style={{ flex: 1 }} disabled={photos.length >= MAX}
            onClick={() => albumRef.current.click()}>🖼️ 앨범에서 선택</button>
        </div>
        {photos.length > 0 && (
          <div className="nt-thumbs">
            {photos.map((p, i) => (
              <div className="nt-thumb" key={i}>
                <img src={URL.createObjectURL(p)} alt={`첨부 ${i + 1}`} />
                <button onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
          </div>
        )}
        <div className="btn-row">
          <button className="primary" disabled={busy} onClick={submit}>등록하기</button>
          <button className="cancel" onClick={onBack}>취소</button>
        </div>
      </div>
    </div>
  </>);
}
