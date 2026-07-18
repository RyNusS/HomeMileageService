import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';

createRoot(document.getElementById('root')).render(<App />);

// 네이티브 앱(WebView)에서는 SW를 쓰지 않는다: SW가 캐시한 HTML은 Capacitor
// 브릿지 주입을 우회해 네이티브 플러그인 목록이 옛 스냅샷으로 고정되는 문제가 있다.
const isNativeShell = !!(window.Capacitor && window.Capacitor.isNativePlatform
  && window.Capacitor.isNativePlatform());
if ('serviceWorker' in navigator) {
  if (isNativeShell) {
    navigator.serviceWorker.getRegistrations()
      .then((rs) => rs.forEach((r) => r.unregister())).catch(() => {});
  } else {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
  }
}
