// Gemini 연동 (v1.20.0): 채팅 안의 AI 응답
//
// 설계 메모
//  - thinkingBudget=0 이 핵심. 기본값(추론 켜짐)은 응답이 5~7초 걸리고 추론 토큰이 출력 요금에
//    포함된다. 가족 채팅 질문엔 추론이 필요 없어 끄면 1.6~2.8초로 줄고 품질 차이도 없다.
//  - 마크다운/LaTeX 를 막지 않으면 `**굵게**` 나 `$27 \times 10$` 이 그대로 나와 말풍선이 깨진다.
//  - 숙제 가드는 사용자(자녀)별로 켜고 끈다. 끄면 해당 문단 자체를 프롬프트에서 뺀다.
//
// 폴백
//  Google 무료 한도(RPM/RPD)는 모델마다 따로 잡히고, 키(프로젝트)마다도 따로 잡힌다.
//  429/503 을 만나면 같은 모델로 다음 키를 먼저 쓰고, 키가 다 막히면 다음 모델로 내려간다.
//  전부 막혔을 때만 소진 안내를 내보낸다.
//  (하루 한도는 태평양 시간 자정 = 한국 기준 오후 4~5시에 풀린다)
//
//  예비 모델을 3.1-flash-lite 로 잡은 이유 (2026-09-15 실측, thinkingBudget=0 기준)
//    3.7/3.8-flash      : 503 으로 거절되거나 27초. 사실상 사용 불가
//    3.5-flash-lite     : 400 (이 설정을 지원하지 않음)
//    3.6-flash          : 응답은 좋으나 25~27초. 채팅에선 실패나 마찬가지
//    3.1-flash-lite     : 1.0~1.7초로 가장 빠르고 안정적. 말투 규칙을 기계적으로 박아주면 존댓말도 지킨다
const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODELS = 'gemini-3.5-flash,gemini-3.1-flash-lite';

const MAX_REPLY = 900;            // 말풍선에 넣을 최대 글자수
const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS || 30000);

export const AI_NAME = '제미나이';

// 답을 못 만들었을 때 자녀에게 보여줄 문구 (빈 말풍선 대신)
export const AI_FALLBACK = '지금은 대답하기 어려워요. 조금 뒤에 다시 물어봐 주세요.';
export const AI_BLOCKED = '그 이야기는 제가 도와주기 어려워요. 다른 걸 물어봐 주세요.';
// 준비된 모델·키를 모두 시도했는데 전부 한도에 걸렸을 때. 앱의 일일 한도와는 별개다.
export const AI_QUOTA = '오늘 제미나이가 대답할 수 있는 양을 다 썼어요. 저녁 늦게 다시 물어봐 주세요.';

export function aiModels() {
  return (process.env.GEMINI_MODELS || DEFAULT_MODELS)
    .split(',').map((s) => s.trim()).filter(Boolean);
}
export function aiModel() { return aiModels()[0]; }
export function aiReady() { return !!process.env.GEMINI_API_KEY; }

// 시도 순서: 같은 모델로 키를 먼저 돌리고, 두 키가 다 막혀야 다음 모델로 내려간다.
//   키만 바뀌면 같은 모델이라 말투·품질이 그대로여서 쓰는 사람은 눈치채지 못한다.
//   모델이 바뀌어야 비로소 체감이 달라지므로, 알림도 그때만 보낸다.
//   예) 3.5-flash/키1 → 3.5-flash/키2 → 3.1-flash-lite/키1 → 3.1-flash-lite/키2
function attempts() {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_2].filter(Boolean);
  const out = [];
  for (const model of aiModels()) for (const key of keys) out.push({ key, model });
  return out;
}

function systemPrompt({ userName, homeworkGuard, groupChat }) {
  const lines = [
    `너는 가정용 마일리지 앱 안에서 가족이 함께 쓰는 AI 친구야. 이름은 "${AI_NAME}"야.`,
    userName ? `지금 말을 걸고 있는 사람의 이름은 "${userName}" 이야.` : '',
    '',
    '지켜야 할 것:',
    '- 초등학생도 이해할 수 있는 쉬운 말로 답해.',
    '- 말투 규칙(가장 중요): 반말을 절대 쓰지 마. 모든 문장을 "-요" 또는 "-습니다"로 끝내라.',
    '  "-야", "-지", "-니", "-단다", "-구나", "-거든" 으로 끝나는 문장은 금지다.',
    '  "안녕!" 이 아니라 "안녕하세요!" 라고 해라.',
    '- 3~5문장 이내로 짧게 답해. 길게 설명해야 하는 내용이면 핵심만 먼저 말하고 더 알고 싶은지 물어봐.',
    '- 마크다운(**굵게**, #제목, - 목록)과 LaTeX 수식 기호($, \\times 같은 것)를 절대 쓰지 마. 일반 문장으로만 써.',
    '- 숫자는 아라비아 숫자로 쓰고, 곱하기는 "곱하기", 나누기는 "나누기"로 써.',
    '- 폭력적이거나 성적인 내용, 무섭거나 잔인한 이야기는 다루지 말고 자연스럽게 다른 화제로 돌려.',
    '- 확실하지 않으면 모른다고 솔직하게 말해. 지어내지 마.',
    '- 너는 이 앱의 마일리지 점수나 적립 내역을 볼 수 없어. 그런 걸 물으면 앱의 다른 탭에서 확인하라고 알려줘.',
  ];
  if (groupChat) {
    lines.push(
      '- 지금은 가족 단체 채팅방이야. 앞의 대화는 "이름: 내용" 형태로 주어지고 여러 사람이 섞여 있어.',
      '  너를 부른 사람에게 답하되, 가족 모두가 함께 읽는다는 점을 생각해서 짧고 담백하게 말해.',
    );
  }
  if (homeworkGuard) {
    lines.push(
      '- 숙제, 시험 문제, 독후감, 일기, 글짓기처럼 아이가 직접 해야 하는 과제는 결과물을 대신 만들어 주지 마.',
      '  대신 어떻게 하면 되는지 힌트와 방향만 알려주고, 아이가 직접 해온 것을 봐주겠다고 말해.',
    );
  }
  return lines.filter((l) => l !== '').join('\n');
}

// Gemini contents 는 user 로 시작해야 하고, 같은 role 이 연달아 오면 합치는 편이 안전하다.
function toContents(history) {
  const out = [];
  for (const m of history) {
    const text = String(m.text || '').trim();
    if (!text) continue;
    const role = m.is_ai ? 'model' : 'user';
    if (!out.length && role === 'model') continue;          // 앞쪽 model 턴은 버린다
    const last = out[out.length - 1];
    if (last && last.role === role) last.parts[0].text += `\n${text}`;
    else out.push({ role, parts: [{ text }] });
  }
  return out;
}

const SAFETY = [
  'HARM_CATEGORY_HARASSMENT',
  'HARM_CATEGORY_HATE_SPEECH',
  'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  'HARM_CATEGORY_DANGEROUS_CONTENT',
].map((category) => ({ category, threshold: 'BLOCK_MEDIUM_AND_ABOVE' }));

// 모델이 규칙을 어기고 남긴 서식 흔적을 마지막에 한 번 더 걷어낸다
function clean(text) {
  let s = String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\n)#{1,6}\s*/g, '$1')
    .replace(/(^|\n)\s*[*-]\s+/g, '$1')
    .replace(/\$\$?([^$\n]+)\$\$?/g, '$1')
    .replace(/\\times/g, ' 곱하기 ')
    .replace(/\\[a-zA-Z]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (s.length > MAX_REPLY) s = `${s.slice(0, MAX_REPLY)}…`;
  return s;
}

// 한 번의 호출. 성공하면 {text, model} 또는 {text, model, blocked}
async function callOnce({ key, model, body }) {
  const base = process.env.GEMINI_API_BASE || DEFAULT_BASE;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${base}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    // 네트워크 오류·타임아웃은 다음 후보로 넘어갈 수 있다
    throw Object.assign(new Error(`gemini_network: ${err.message}`), { retryable: true });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    const err = new Error(`gemini_http_${res.status}${detail ? `: ${detail.slice(0, 160)}` : ''}`);
    // 429 RESOURCE_EXHAUSTED = 그 모델·그 키의 분당/하루 한도 소진 → 다음 후보로
    if (res.status === 429) { err.quota = true; err.retryable = true; }
    if (res.status >= 500) err.retryable = true;
    throw err;
  }
  const json = await res.json();

  // 안전 차단은 모델을 바꿔도 같은 결과일 테니 폴백하지 않는다
  if (json.promptFeedback && json.promptFeedback.blockReason) {
    return { text: AI_BLOCKED, model, blocked: true };
  }
  const cand = (json.candidates || [])[0];
  if (!cand || cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') {
    return { text: AI_BLOCKED, model, blocked: true };
  }
  const text = clean(((cand.content && cand.content.parts) || []).map((p) => p.text || '').join(''));
  if (!text) throw Object.assign(new Error('gemini_empty_reply'), { retryable: true });
  return { text, model };
}

/**
 * history: [{ text, is_ai }] - 오래된 것부터. 마지막 항목이 이번 질문이다.
 * 성공하면 { text, model, fallback? }, 안전 차단이면 { text: AI_BLOCKED, blocked: true }
 * 모든 후보가 실패하면 throw (마지막 오류. 전부 한도였으면 err.quota = true)
 */
export async function askGemini({
  history, userName, homeworkGuard = true, groupChat = false, log,
}) {
  const list = attempts();
  if (!list.length) throw new Error('gemini_not_configured');

  const contents = toContents(history);
  if (!contents.length) throw new Error('empty_prompt');

  const body = {
    system_instruction: {
      parts: [{ text: systemPrompt({ userName, homeworkGuard, groupChat }) }],
    },
    contents,
    safetySettings: SAFETY,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  let lastErr = null;
  let allQuota = true;
  for (let i = 0; i < list.length; i += 1) {
    const { key, model } = list[i];
    try {
      const out = await callOnce({ key, model, body });
      if (i > 0 && log) log.warn({ model, step: i }, 'gemini fell back to a backup model/key');
      return i > 0 ? { ...out, fallback: true } : out;
    } catch (err) {
      lastErr = err;
      if (!err.quota) allQuota = false;
      if (!err.retryable) break;           // 400 등 요청 자체의 문제면 더 시도하지 않는다
      if (log) log.warn({ model, err: err.message }, 'gemini attempt failed, trying next');
    }
  }
  if (lastErr && allQuota) lastErr.quota = true;
  throw lastErr || new Error('gemini_failed');
}
