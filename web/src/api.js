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
  already_requested: '이미 사용 신청한 사용권이에요 (부모님 승인 대기중)',
  not_found_or_decided: '이미 처리되었거나 찾을 수 없어요',
  voucher_not_active: '이미 사용된 사용권이에요',
  daily_limit_reached: '오늘은 이 항목을 더 청구할 수 없어요 (1일 횟수 제한)',
  bad_daily_limit: '1일 횟수는 1~9 사이로 입력해 주세요',
  bad_miss: '미달성 포인트(0 제외)와 적용 요일을 확인해 주세요',
  bad_miss_points: '미달성 포인트는 0이 아닌 정수로 입력해 주세요 (차감은 음수)',
  bad_miss_days: '미달성 적용 요일을 하나 이상 선택해 주세요',
  title_required: '제목을 입력해 주세요',
  comment_required: '댓글을 입력해 주세요',
  message_required: '메시지를 입력해 주세요',
  nothing_to_share: '공유할 질문과 답변 한 쌍을 찾지 못했어요',
  ai_disabled: '부모님이 AI 대화를 꺼두셨어요',
  ai_daily_limit: '오늘 AI와 나눌 수 있는 대화를 다 썼어요',
  ai_unavailable: 'AI 기능이 아직 준비되지 않았어요',
  bad_ai_limit: '하루 질문 횟수는 0~500 사이로 입력해 주세요',
  nothing_to_update: '변경할 내용이 없어요',
  bad_pc_max_session: '1회 최대 시간은 5~1440분 사이로 입력해 주세요',
  bad_pc_offline_grace: '인터넷 끊김 허용은 1~120분 사이로 입력해 주세요',
  bad_pc_allowed_range: '사용 가능 시간대의 끝이 시작보다 늦어야 해요',
  bad_free_window: '자유 시간의 요일·시각을 확인해 주세요',
  bad_free_overlap: '같은 요일에 겹치는 자유 시간이 있어요',
  forbidden: '권한이 없어요',
  not_found: '이미 삭제되었거나 찾을 수 없어요',
};
export const t = (e) => ERR_KO[e] || e;
