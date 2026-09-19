# -*- mode: python ; coding: utf-8 -*-
# PC 가드 PyInstaller 빌드 설정 — build.ps1 이 사용한다 (직접 실행 X).
#   HMS_GUARD_NAME 환경변수 = 출력 파일 이름 (예: hms-guard.v1.1.0)
#
# 시작 속도: onefile exe 는 실행할 때마다 내부 파일을 모두 풀어놓고 시작하고, 백신이 그 파일을
# 하나하나 검사한다. 쓰지 않는 Tcl/Tk 부속 데이터(시간대 DB, 번역 메시지 등 약 800개)를 빼서
# 풀어야 할 파일 수를 크게 줄인다.
import os

name = os.environ.get("HMS_GUARD_NAME", "hms-guard")

# 가드 화면에 필요 없는 Tcl/Tk 데이터 (tkinter 는 이것들 없이 동작한다)
DROP_PREFIXES = (
    "_tcl_data/tzdata/",   # 세계 시간대 DB (~600 파일) — Tcl clock 의 시간대 기능 미사용
    "_tcl_data/msgs/",     # Tcl 번역 메시지
    "_tk_data/msgs/",      # Tk 대화상자 번역 메시지 (messagebox 는 Windows 기본 대화상자 사용)
    "_tk_data/demos/",
    "_tk_data/images/",
    "_tcl_data/http1.0/",
    "_tcl_data/opt0.4/",
)


def keep(entry):
    dest = entry[0].replace("\\", "/")
    return not any(dest.startswith(p) for p in DROP_PREFIXES)


a = Analysis(
    ["src/session/guard.py"],
    pathex=["."],
    binaries=[],
    datas=[],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["unittest", "pydoc", "doctest", "pdb", "lib2to3", "sqlite3", "xmlrpc"],
    noarchive=False,
    optimize=0,
)
before = len(a.datas)
a.datas = [d for d in a.datas if keep(d)]
print(f"[hms-guard] datas {before} -> {len(a.datas)}")

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name=name,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    # 실행할 때마다 내부 파일을 풀어두는 위치 — 백신 제외 폴더 안 (updater.runtime_dir 와 같아야 함)
    runtime_tmpdir="%LOCALAPPDATA%\\HMSGuard\\rt",
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
