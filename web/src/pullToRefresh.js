// 당겨서 새로고침 훅 — 스크롤이 '정말 맨 위'일 때만 동작한다.
// 리스트 중간에서 아래로 드래그(위로 스크롤)할 때는 절대 발동하지 않도록
// touchstart와 touchmove 양쪽에서 스크롤 위치를 확인한다.
import { useState, useRef } from 'react';

export default function usePullToRefresh(contentRef) {
  const [ptr, setPtr] = useState(0); // 당긴 거리(px)
  const pullStart = useRef(null);
  const refreshing = useRef(false);

  const atTop = () => {
    const el = contentRef.current;
    const doc = document.scrollingElement;
    return (!el || el.scrollTop <= 0) && (!doc || doc.scrollTop <= 0);
  };

  const onTouchStart = (e) => {
    pullStart.current = atTop() ? e.touches[0].clientY : null;
  };
  const onTouchMove = (e) => {
    if (pullStart.current == null || refreshing.current) return;
    if (!atTop()) { pullStart.current = null; setPtr(0); return; } // 시작 후 스크롤됐으면 취소
    const dy = e.touches[0].clientY - pullStart.current;
    if (dy > 0) setPtr(Math.min(dy * 0.5, 80));
    else setPtr(0);
  };
  const onTouchEnd = () => {
    if (pullStart.current == null) return;
    pullStart.current = null;
    if (ptr >= 60 && atTop()) {
      refreshing.current = true;
      setPtr(46);
      window.location.reload();
    } else {
      setPtr(0);
    }
  };

  return { ptr, refreshing, handlers: { onTouchStart, onTouchMove, onTouchEnd } };
}
