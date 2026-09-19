"""
HMS(홈 마일리지 시스템) API 클라이언트
=====================================
세션 가드가 HMS 서버와 통신할 때 사용합니다.

- 로그인(자녀/부모), 내 정보, 사용권 조회, 분 단위 차감(consume)
- 자녀 토큰은 DPAPI(Windows 계정 단위 암호화)로 로컬에 보관합니다.
- 부모 토큰은 저장하지 않습니다(설정 변경 시에만 메모리 사용).

의존성: 표준 라이브러리(urllib) + pywin32(win32crypt, 토큰 암호화용 — 없으면 평문 저장 경고)
"""

import json
import urllib.request
import urllib.error
from pathlib import Path

from src.common.state import _get_data_dir  # 기존 데이터 폴더 규칙 재사용

TIMEOUT_SEC = 10

try:
    import win32crypt  # type: ignore

    _HAS_DPAPI = True
except ImportError:  # 개발 환경 등 pywin32 미설치 시
    _HAS_DPAPI = False


class HmsError(Exception):
    """HMS API 오류. code에 서버 error 문자열(insufficient_vouchers 등)이 담긴다."""

    def __init__(self, code: str, status: int = 0):
        super().__init__(code)
        self.code = code
        self.status = status


class HmsOffline(Exception):
    """네트워크 단절/서버 무응답."""


def _request(server_url: str, method: str, path: str, body=None, token=None):
    url = server_url.rstrip("/") + "/api" + path
    data = None
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SEC) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
            code = payload.get("error", f"http_{e.code}")
        except Exception:
            code = f"http_{e.code}"
        raise HmsError(code, e.code) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise HmsOffline(str(e)) from None


def normalize_server_url(url: str) -> str:
    url = (url or "").strip()
    if url and not url.lower().startswith(("http://", "https://")):
        url = "https://" + url
    return url.rstrip("/")


# ─── API ─────────────────────────────────────────────────────────────────────

def login(server_url: str, login_id: str, secret: str):
    """로그인. 반환: (token, user dict — id/name/role/balance)"""
    data = _request(server_url, "POST", "/auth/login",
                    {"login_id": login_id.strip(), "secret": secret})
    return data["token"], data["user"]


def me(server_url: str, token: str):
    return _request(server_url, "GET", "/me", token=token)


def report_event(server_url: str, token: str, event_type: str, **extra):
    """가드 이벤트 신고 → 서버가 부모에게 알림.
    abnormal_exit(비정상 종료 흔적), free_start(자유 시간 사용 시작, until='HH:MM')"""
    return _request(server_url, "POST", "/guard/event",
                    {"type": event_type, **extra}, token=token)


def get_pc_settings(server_url: str, token: str):
    """가족 PC 설정 (HMS v1.28.0+). 반환: {configured, max_session_min, allowed_start,
    allowed_end, offline_grace_min, free_windows:[{day,start,end}]}"""
    return _request(server_url, "GET", "/pc-settings", token=token)


def put_pc_settings(server_url: str, token: str, settings: dict):
    """가족 PC 설정 저장 (부모 토큰). 이전 버전 PC에 저장돼 있던 설정을 서버로 옮길 때 사용."""
    return _request(server_url, "PUT", "/pc-settings", settings, token=token)


def get_vouchers(server_url: str, token: str):
    """반환: {remaining_minutes, vouchers:[{id,label,total_minutes,remaining_minutes,status,...}]}"""
    return _request(server_url, "GET", "/vouchers", token=token)


def consume(server_url: str, token: str, minutes: int,
            silent: bool = False, note: str | None = None):
    """
    사용권 분 단위 FIFO 차감 (HMS v1.4.2+).
    - silent=True : 부모 알림 생략 (세션 중 매분 차감용)
    - note        : 알림 문구 지정 (세션 시작 1회 알림용)
    """
    body = {"minutes": int(minutes)}
    if silent:
        body["silent"] = True
    if note:
        body["note"] = note
    return _request(server_url, "POST", "/vouchers/consume", body, token=token)


# ─── 자녀 토큰 보관 (DPAPI) ──────────────────────────────────────────────────

def _token_path() -> Path:
    return _get_data_dir() / "guard_token.bin"


def save_child_token(token: str) -> None:
    raw = token.encode("utf-8")
    if _HAS_DPAPI:
        blob = win32crypt.CryptProtectData(raw, "dw-guard", None, None, None, 0)
    else:
        blob = b"PLAIN:" + raw  # 개발 환경 폴백 (배포 빌드에는 pywin32 포함)
    _token_path().write_bytes(blob)


def load_child_token() -> str | None:
    p = _token_path()
    if not p.exists():
        return None
    blob = p.read_bytes()
    try:
        if blob.startswith(b"PLAIN:"):
            return blob[6:].decode("utf-8")
        if _HAS_DPAPI:
            _, raw = win32crypt.CryptUnprotectData(blob, None, None, None, 0)
            return raw.decode("utf-8")
    except Exception:
        return None
    return None


def clear_child_token() -> None:
    p = _token_path()
    if p.exists():
        p.unlink()
