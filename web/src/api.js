// Tiny API client with JWT in localStorage
const KEY = 'hms_token';

export function getToken() { return localStorage.getItem(KEY); }
export function setToken(t) { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); }

export async function api(method, url, body) {
  const headers = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers, body: payload });
  if (res.status === 401) { setToken(null); window.location.reload(); return null; }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export const ERR_KO = {
  invalid_credentials: '아이디 또는 비밀번호가 올바르지 않아요',
  insufficient_balance: '마일리지가 부족해요',
  insufficient_vouchers: '보유 사용권 시간이 부족해요',
  proof_required: '이 항목은 사진 인증이 필요해요',
  login_id_taken: '이미 사용 중인 아이디예요',
  pin_must_be_4_6_digits: 'PIN은 숫자 4~6자리로 입력해 주세요',
  already_decided: '이미 처리된 청구예요',
  daily_limit_reached: '오늘은 이 항목을 더 청구할 수 없어요 (1일 횟수 제한)',
  bad_daily_limit: '1일 횟수는 1~9 사이로 입력해 주세요',
};
export const t = (e) => ERR_KO[e] || e;
