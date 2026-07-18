// Push helper: web push (browser/PWA) + FCM (Capacitor native app)
import { api } from './api.js';

const cap = () => window.Capacitor;
export function isNativeApp() {
  const c = cap();
  return !!(c && c.isNativePlatform && c.isNativePlatform());
}
const pluginCache = {};
// 저수준 브릿지 프록시: SW 캐시 등으로 PluginHeaders 가 옛 스냅샷이어도
// nativePromise 는 실제 네이티브 등록 기준으로 동작한다.
function bridgeProxy(c, name) {
  if (typeof c.nativePromise !== 'function') return null;
  const call = (method) => (opts) => c.nativePromise(name, method, opts);
  return {
    addListener: (ev, cb) => {
      if (typeof c.addListener === 'function') return c.addListener(name, ev, cb);
      return undefined;
    },
    checkPermissions: call('checkPermissions'),
    requestPermissions: call('requestPermissions'),
    register: call('register'),
    createChannel: call('createChannel'),
    openChannelSettings: call('openChannelSettings'),
  };
}
function plugin(name) {
  const c = cap();
  if (!c) return null;
  if (pluginCache[name]) return pluginCache[name];
  if (c.Plugins && c.Plugins[name]) { pluginCache[name] = c.Plugins[name]; return pluginCache[name]; }
  const headers = c.PluginHeaders || [];
  if (headers.some((h) => h && h.name === name) && typeof c.registerPlugin === 'function') {
    try { pluginCache[name] = c.registerPlugin(name); return pluginCache[name]; } catch { /* fallthrough */ }
  }
  const proxy = bridgeProxy(c, name);
  if (proxy) { pluginCache[name] = proxy; return proxy; }
  return null;
}

// Android notification channel: sound/vibration are per-channel and the user
// picks them in the system channel settings (settings.jsx button).
const CHANNEL = {
  id: 'hms_default',
  name: '홈 마일리지 알림',
  description: '적립·승인·사용권 알림',
  importance: 4,
  visibility: 1,
  vibration: true,
};
const FCM_ON = 'hms_fcm_on';

function b64ToUint8(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

// ---- native (FCM) ----
let listenersOn = false;
function attachNativeListeners(pn) {
  if (listenersOn) return;
  listenersOn = true;
  pn.addListener('registration', (t) => {
    if (t && t.value) api('POST', '/api/push/fcm-token', { token: t.value }).catch(() => {});
  });
  pn.addListener('pushNotificationActionPerformed', (ev) => {
    const url = ev && ev.notification && ev.notification.data && ev.notification.data.url;
    if (url && url.startsWith('/')) window.location.href = url;
  });
}

async function ensureChannel(pn) {
  try { await pn.createChannel(CHANNEL); } catch { /* older android: no-op */ }
}

async function nativeEnable() {
  const pn = plugin('PushNotifications');
  if (!pn) throw new Error('push_unsupported');
  let perm = await pn.checkPermissions();
  if (perm.receive !== 'granted') perm = await pn.requestPermissions();
  if (perm.receive !== 'granted') throw new Error('push_permission_denied');
  await ensureChannel(pn);
  attachNativeListeners(pn);
  await pn.register();   // token arrives via 'registration' listener
  localStorage.setItem(FCM_ON, '1');
  return true;
}

// app start (logged in): silently re-register so token rotation is picked up
export async function initNativePush() {
  if (!isNativeApp()) return;
  const pn = plugin('PushNotifications');
  if (!pn) return;
  try {
    const perm = await pn.checkPermissions();
    if (perm.receive !== 'granted' || localStorage.getItem(FCM_ON) !== '1') return;
    await ensureChannel(pn);
    attachNativeListeners(pn);
    await pn.register();
  } catch { /* ignore */ }
}

// open the Android system channel settings (pick sound / vibration)
export async function openNotificationSoundSettings() {
  const np = plugin('NotifSettings');
  if (!np) throw new Error('app_update_required');
  await np.openChannelSettings({ channelId: CHANNEL.id });
}

// ---- shared API ----
export function pushSupported() {
  if (isNativeApp()) return !!plugin('PushNotifications');
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

export async function getSubscriptionState() {
  if (isNativeApp()) {
    const pn = plugin('PushNotifications');
    if (!pn) return 'unsupported';
    try {
      const perm = await pn.checkPermissions();
      if (perm.receive === 'denied') return 'denied';
      if (perm.receive === 'granted' && localStorage.getItem(FCM_ON) === '1') return 'subscribed';
      return 'ready';
    } catch { return 'unsupported'; }
  }
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'ready';
}

export async function enablePush() {
  if (isNativeApp()) return nativeEnable();
  if (!pushSupported()) throw new Error('push_unsupported');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('push_permission_denied');
  const { key } = await api('GET', '/api/push/vapid-public-key');
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64ToUint8(key),
    });
  }
  await api('POST', '/api/push/subscribe', sub.toJSON());
  return true;
}
