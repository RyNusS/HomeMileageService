"""
Windows 로그온 자동 시작 등록/해제 (HKCU Run 레지스트리)
"""

import sys
import winreg
from pathlib import Path

RUN_KEY = r"Software\Microsoft\Windows\CurrentVersion\Run"
APP_NAME = "DWSessionGuard"


def _launch_command() -> str:
    if getattr(sys, "frozen", False):
        return f'"{sys.executable}"'
    # 개발 환경: pythonw로 콘솔 없이 실행
    pyw = Path(sys.executable).with_name("pythonw.exe")
    script_dir = Path(__file__).resolve().parents[2]  # pc-guard 폴더
    return f'"{pyw}" -m src.session.guard --workdir "{script_dir}"'


def install() -> str:
    cmd = _launch_command()
    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, APP_NAME, 0, winreg.REG_SZ, cmd)
    return cmd


def uninstall() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
            winreg.DeleteValue(k, APP_NAME)
        return True
    except FileNotFoundError:
        return False


def is_installed() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, APP_NAME)
        return True
    except FileNotFoundError:
        return False


def sync_to_current() -> bool:
    """자동 시작이 등록돼 있는데 다른 exe(예: 업데이트 전 버전)를 가리키면
    지금 실행 중인 exe 로 고친다. 고쳤으면 True."""
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            cur, _ = winreg.QueryValueEx(k, APP_NAME)
    except FileNotFoundError:
        return False
    want = _launch_command()
    if str(cur).strip().lower() == want.lower():
        return False
    install()
    return True
