"""
가드 워치독 & 변조 방어 (사용자 영역)
=====================================
자녀가 작업 관리자 등으로 가드를 강제 종료해도 방어하기 위한 계층.

1) 워치독 상호 부활: 가드(GUI)와 워치독 두 프로세스가 서로를 감시하다,
   한쪽이 사라지면 즉시 되살린다. 둘을 동시에 종료해야만 완전히 멈추므로
   손으로 끄기 어렵다. (관리자 권한 상승 없이 동작)
2) 작업 관리자 비활성화: 자녀가 화면을 제어할 때 HKCU 정책으로 작업 관리자를
   막고, 부모 화면·정상 종료 시 원복한다.

⚠️ 자녀 Windows 계정이 '관리자'이면 정책·프로세스를 우회할 수 있어 완벽하지
   않다. 근본 방어는 자녀를 '표준(비관리자)' 계정으로 두는 것.

정상 종료(부모의 프로그램 종료/제거/PC 끄기) 시에는 request_stop()으로 플래그를
남겨 워치독이 재실행하지 않도록 한다.
"""

import ctypes
import subprocess
import sys
import winreg
from pathlib import Path

from src.common.state import _get_data_dir

GUARD_MUTEX = "DWSessionGuard_SingleInstance"      # 가드 GUI 단일 인스턴스
WATCHDOG_MUTEX = "DWSessionGuard_Watchdog"          # 워치독 단일 인스턴스

_ERROR_ALREADY_EXISTS = 183
_MUTEX_ALL_ACCESS = 0x1F0001
_held = []  # 잡은 뮤텍스 핸들을 프로세스 수명 동안 유지

_TM_KEY = r"Software\Microsoft\Windows\CurrentVersion\Policies\System"
_TM_VALUE = "DisableTaskMgr"

# 창(개발/테스트) 모드에서는 방어를 끈다 — 실수로 잠금 화면을 재실행하거나
# 개발 PC의 정책을 건드리지 않도록.
_ACTIVE = True


def set_active(active: bool) -> None:
    global _ACTIVE
    _ACTIVE = active


# ── 정상 종료 플래그 ──────────────────────────────────────────────────────
def _stop_path() -> Path:
    return _get_data_dir() / "guard_stop.flag"


def request_stop() -> None:
    """정상 종료 직전 호출 — 워치독이 되살리지 않도록 플래그 생성."""
    try:
        _stop_path().write_text("stop", encoding="utf-8")
    except OSError:
        pass


def clear_stop() -> None:
    p = _stop_path()
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


def stop_requested() -> bool:
    return _stop_path().exists()


# ── 비정상 종료 감지용 실행 마커 ──────────────────────────────────────────
# 가드가 뜨면 마커를 남기고(running), 정상 종료 시 지운다(clean).
# 강제 종료/크래시로 사라지면 마커가 남아, 다음 시작 때 '비정상 종료'로 판단.
def _run_marker_path() -> Path:
    return _get_data_dir() / "guard_run.flag"


def _alert_ts_path() -> Path:
    return _get_data_dir() / "guard_alert.ts"


def was_unclean() -> bool:
    """이전 실행이 정상 종료되지 않았으면 True (실행 마커가 남아 있음)."""
    return _run_marker_path().exists()


def mark_running() -> None:
    try:
        _run_marker_path().write_text(str(int(_now())), encoding="utf-8")
    except OSError:
        pass


def mark_clean() -> None:
    p = _run_marker_path()
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


def _now() -> float:
    import time
    return time.time()


def should_alert(min_gap_sec: int = 180) -> bool:
    """직전 알림 후 min_gap_sec 이내면 False(스팸 방지). 통과 시 시각 기록."""
    p = _alert_ts_path()
    now = _now()
    try:
        if p.exists():
            last = float(p.read_text(encoding="utf-8").strip() or "0")
            if now - last < min_gap_sec:
                return False
    except (OSError, ValueError):
        pass
    try:
        p.write_text(str(int(now)), encoding="utf-8")
    except OSError:
        pass
    return True


# ── 이름 있는 뮤텍스로 상대 생존 확인 ─────────────────────────────────────
def mutex_exists(name: str) -> bool:
    k32 = ctypes.windll.kernel32
    h = k32.OpenMutexW(_MUTEX_ALL_ACCESS, False, name)
    if h:
        k32.CloseHandle(h)
        return True
    return False


def hold_mutex(name: str) -> bool:
    """이름 있는 뮤텍스를 잡고 핸들을 유지. 이미 잡혀 있으면 False."""
    k32 = ctypes.windll.kernel32
    h = k32.CreateMutexW(None, False, name)
    if k32.GetLastError() == _ERROR_ALREADY_EXISTS:
        if h:
            k32.CloseHandle(h)
        return False
    _held.append(h)
    return True


# ── 프로세스 재실행 ───────────────────────────────────────────────────────
def _spawn(extra_args) -> None:
    # DETACHED_PROCESS | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP
    flags = 0x00000008 | 0x08000000 | 0x00000200
    if getattr(sys, "frozen", False):
        cmd = [sys.executable] + extra_args
    else:
        pyw = str(Path(sys.executable).with_name("pythonw.exe"))
        root = str(Path(__file__).resolve().parents[2])
        cmd = [pyw, "-m", "src.session.guard", "--workdir", root] + extra_args
    try:
        subprocess.Popen(cmd, creationflags=flags, close_fds=True)
    except OSError:
        pass


def spawn_guard() -> None:
    _spawn([])


def spawn_watchdog() -> None:
    _spawn(["--watchdog"])


def ensure_watchdog() -> None:
    """가드가 시작 시·주기적으로 호출 — 워치독이 없으면 띄운다."""
    if not _ACTIVE:
        return
    if not stop_requested() and not mutex_exists(WATCHDOG_MUTEX):
        spawn_watchdog()


def run_watchdog(poll_seconds: float = 2.0) -> None:
    """워치독 진입점(--watchdog). 가드가 사라지면 되살린다.
    정상 종료 플래그가 있으면 되살리지 않고 스스로 종료."""
    import time
    if not hold_mutex(WATCHDOG_MUTEX):
        return  # 이미 워치독이 돌고 있음
    while True:
        if stop_requested():
            clear_stop()
            return
        if not mutex_exists(GUARD_MUTEX):
            spawn_guard()
            time.sleep(3)  # 기동 여유
        time.sleep(poll_seconds)


# ── 작업 관리자 정책 (HKCU) ───────────────────────────────────────────────
def set_task_manager(enabled: bool) -> None:
    """enabled=True 면 작업 관리자 사용 가능(정책 값 삭제),
    False 면 DisableTaskMgr=1 로 막는다. 실패(권한/정책 잠금)는 조용히 무시.
    ⚠️ HKCU Policies 브랜치가 관리(GPO/MDM)로 잠긴 PC에서는 쓰기가 거부돼
    적용되지 않을 수 있다 — 이 경우 워치독만으로 방어한다."""
    if not _ACTIVE:
        return
    try:
        if enabled:
            try:
                with winreg.OpenKey(winreg.HKEY_CURRENT_USER, _TM_KEY, 0,
                                    winreg.KEY_SET_VALUE) as k:
                    winreg.DeleteValue(k, _TM_VALUE)
            except FileNotFoundError:
                pass
        else:
            k = winreg.CreateKeyEx(winreg.HKEY_CURRENT_USER, _TM_KEY, 0,
                                   winreg.KEY_SET_VALUE)
            try:
                winreg.SetValueEx(k, _TM_VALUE, 0, winreg.REG_DWORD, 1)
            finally:
                winreg.CloseKey(k)
    except OSError:
        pass
