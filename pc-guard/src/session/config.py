"""
세션 가드 설정 관리
====================
guard_config.json — 서버 주소·자녀 아이디·PC 설정 사본
session_state.json — 진행 중 세션 상태(재부팅/강제종료 후 복원용)

PC 설정(1회 최대 세션, 사용 가능 시간대, 오프라인 유예, 요일별 자유 시간)은
HMS 부모 화면에서 가족 단위로 정하고, 가드는 서버에서 받아 여기 사본을 둔다.
(인터넷이 끊겨도 마지막으로 받은 설정으로 동작)
"""

import json
from datetime import datetime, timedelta
from pathlib import Path

from src.common.state import _get_data_dir

DEFAULTS = {
    "server_url": "",
    "child_login_id": "",
    "settings": {
        "max_session_min": 60,      # 1회 최대 세션 시간(분)
        "allowed_start": "08:00",   # 사용 가능 시작 (HH:MM)
        "allowed_end": "21:30",     # 사용 가능 종료 (HH:MM)
        "offline_grace_min": 15,     # 오프라인 허용(분) — 초과 시 세션 종료
        # 요일별 자유 이용 시간 [{day:0~6(0=일), start:'HH:MM', end:'HH:MM'}]
        # 이 시간엔 사용권 차감 없이 사용 — 사용 가능 시간대·1회 최대보다 우선
        "free_windows": [],
    },
    "server_configured": False,     # 서버(HMS 부모 화면)에 PC 설정이 저장돼 있는지
}

SERVER_KEYS = ("max_session_min", "allowed_start", "allowed_end",
               "offline_grace_min", "free_windows")


def _config_path() -> Path:
    return _get_data_dir() / "guard_config.json"


def _session_path() -> Path:
    return _get_data_dir() / "session_state.json"


def load_config() -> dict:
    p = _config_path()
    cfg = json.loads(json.dumps(DEFAULTS))  # deep copy
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            cfg.update({k: v for k, v in data.items() if k != "settings"})
            cfg["settings"].update(data.get("settings", {}))
        except (json.JSONDecodeError, OSError):
            pass
    return cfg


def save_config(cfg: dict) -> None:
    _config_path().write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")


def parse_hhmm(text: str, allow24: bool = False):
    """'HH:MM' → (h, m). 형식 오류 시 ValueError. allow24면 '24:00'(자정) 허용."""
    parts = text.strip().split(":")
    if len(parts) != 2:
        raise ValueError(text)
    h, m = int(parts[0]), int(parts[1])
    if allow24 and h == 24 and m == 0:
        return h, m
    if not (0 <= h <= 23 and 0 <= m <= 59):
        raise ValueError(text)
    return h, m


def to_min(text: str, allow24: bool = False) -> int:
    h, m = parse_hhmm(text, allow24)
    return h * 60 + m


def minutes_until_allowed_end(settings: dict, now: datetime | None = None) -> int:
    """지금부터 사용 가능 종료 시각까지 남은 분. 시간대 밖이면 0."""
    now = now or datetime.now()
    try:
        start = to_min(settings["allowed_start"])
        end = to_min(settings["allowed_end"], allow24=True)
    except (ValueError, KeyError, AttributeError):
        return 24 * 60  # 설정 오류 시 제한 없음으로 동작
    cur = now.hour * 60 + now.minute
    if start <= cur < end:
        return end - cur
    return 0


# ─── 요일별 자유 이용 시간 ──────────────────────────────────────────────────

def _hms_day(d: datetime) -> int:
    """서버 요일 규칙(0=일 … 6=토)으로 변환. 파이썬 weekday()는 0=월."""
    return (d.weekday() + 1) % 7


def _day_windows(settings: dict, day: int):
    out = []
    for w in settings.get("free_windows") or []:
        try:
            if int(w["day"]) != day:
                continue
            s, e = to_min(w["start"]), to_min(w["end"], allow24=True)
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
        if s < e:
            out.append((s, e))
    return sorted(out)


def free_window_end(settings: dict, now: datetime | None = None) -> datetime | None:
    """지금이 자유 이용 시간이면 그 자유 시간이 끝나는 시각, 아니면 None.
    바로 이어지는 자유 시간(같은 날 연속, 자정을 넘어 다음 날 00:00부터)은 하나로 본다."""
    now = now or datetime.now()
    cur = now.hour * 60 + now.minute
    day0 = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = None
    for s, e in _day_windows(settings, _hms_day(now)):
        if s <= cur < e:
            end = e
            break
    if end is None:
        return None
    # 연속 구간 이어 붙이기 (최대 7일)
    for offset in range(0, 8):
        base = offset * 1440
        day = _hms_day(day0 + timedelta(days=offset))
        extended = True
        while extended:
            extended = False
            for s, e in _day_windows(settings, day):
                if base + s <= end < base + e:
                    end = base + e
                    extended = True
        if end < base + 1440:
            break
    return day0 + timedelta(minutes=end)


def today_free_text(settings: dict, now: datetime | None = None) -> str:
    """오늘의 자유 시간 안내 문구 ('07:00~09:00, 20:00~21:00'). 없으면 빈 문자열."""
    now = now or datetime.now()
    parts = []
    for s, e in _day_windows(settings, _hms_day(now)):
        parts.append(f"{s // 60:02d}:{s % 60:02d}~{e // 60:02d}:{e % 60:02d}")
    return ", ".join(parts)


_DAY_KO = ["일", "월", "화", "수", "목", "금", "토"]
_DAY_ORDER = [1, 2, 3, 4, 5, 6, 0]


def free_summary(settings: dict) -> str:
    """자유 시간 요약 ('토·일 07:00~09:00'). 없으면 '없음'."""
    groups = {}
    for w in settings.get("free_windows") or []:
        try:
            key = (to_min(w["start"]), to_min(w["end"], allow24=True), w["start"], w["end"])
            groups.setdefault(key, set()).add(int(w["day"]))
        except (ValueError, KeyError, TypeError, AttributeError):
            continue
    if not groups:
        return "없음"
    parts = []
    for key in sorted(groups):
        days = groups[key]
        if len(days) == 7:
            label = "매일"
        elif days == {1, 2, 3, 4, 5}:
            label = "평일"
        else:
            label = "·".join(_DAY_KO[d] for d in _DAY_ORDER if d in days)
        parts.append(f"{label} {key[2]}~{key[3]}")
    return ", ".join(parts)


def apply_server_settings(cfg: dict, data: dict) -> bool:
    """서버에서 받은 PC 설정을 사본에 반영. 서버에 설정이 없으면(configured=False) 그대로 둔다.
    바뀐 게 있으면 True."""
    if not data or not data.get("configured"):
        changed = cfg.get("server_configured") is not False
        cfg["server_configured"] = False
        return changed
    before = json.dumps([cfg["settings"], cfg.get("server_configured")], sort_keys=True)
    for k in SERVER_KEYS:
        if k in data:
            cfg["settings"][k] = data[k]
    cfg["server_configured"] = True
    return before != json.dumps([cfg["settings"], True], sort_keys=True)


# ─── 세션 상태 (복원용) ─────────────────────────────────────────────────────

def save_session_state(state: dict | None) -> None:
    p = _session_path()
    if state is None:
        if p.exists():
            p.unlink()
        return
    p.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")


def load_session_state() -> dict | None:
    p = _session_path()
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None
