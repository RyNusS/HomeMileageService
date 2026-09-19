"""
가드 자동 업데이트
==================
HMS 서버에 올려둔 최신 가드(exe)를 확인해, 지금보다 새 버전이면 내려받아 교체 실행한다.

  1. GET /api/guard/update → {version, file, sha256, size, url}
  2. %LOCALAPPDATA%\\HMSGuard\\<file> 로 내려받기 (.part → 크기·SHA-256 확인 → 이름 변경)
  3. 지금 가드를 정상 종료 표시하고, 새 exe 를 --after-update 로 실행
  4. 새 가드는 이전 가드·워치독이 완전히 끝날 때까지 기다린 뒤 뜨고,
     자동 시작 등록을 자기 경로로 바꾸고, 예전 버전 파일을 정리한다.

사용 중(세션 중·관리 모드)에는 업데이트하지 않는다 — 잠금 화면에서만.
"""

import hashlib
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

TIMEOUT_SEC = 60
_VER = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)")
_FILE = re.compile(r"^[A-Za-z0-9._-]{1,80}\.exe$")


def parse_version(v: str):
    m = _VER.match(str(v or "").strip())
    return tuple(int(x) for x in m.groups()) if m else None


def is_newer(latest: str, current: str) -> bool:
    a, b = parse_version(latest), parse_version(current)
    return bool(a and b and a > b)


def install_dir() -> Path:
    base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    p = Path(base) / "HMSGuard"
    p.mkdir(parents=True, exist_ok=True)
    return p


def check(server_url: str, current_version: str) -> dict | None:
    """새 버전 정보(dict) 또는 None."""
    from src.session import hms_client  # 순환 import 방지

    info = hms_client._request(server_url, "GET", "/guard/update")
    if not info or not info.get("version"):
        return None
    if not is_newer(info["version"], current_version):
        return None
    if not _FILE.match(str(info.get("file", ""))) or not re.fullmatch(r"[0-9a-f]{64}", str(info.get("sha256", ""))):
        return None
    return info


def download(server_url: str, info: dict) -> Path:
    """내려받아 검증한 exe 경로. 검증 실패 시 ValueError."""
    dest = install_dir() / info["file"]
    if dest.exists() and _sha256(dest) == info["sha256"]:
        return dest
    part = dest.with_suffix(".part")
    url = server_url.rstrip("/") + info["url"]
    h = hashlib.sha256()
    size = 0
    with urllib.request.urlopen(url, timeout=TIMEOUT_SEC) as res, open(part, "wb") as f:
        while True:
            chunk = res.read(1024 * 256)
            if not chunk:
                break
            f.write(chunk)
            h.update(chunk)
            size += len(chunk)
    if size != int(info.get("size", size)) or h.hexdigest() != info["sha256"]:
        try:
            part.unlink()
        except OSError:
            pass
        raise ValueError("checksum_mismatch")
    if dest.exists():
        dest.unlink()
    part.rename(dest)
    return dest


def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 256), b""):
            h.update(chunk)
    return h.hexdigest()


def launch(exe: Path) -> None:
    """새 가드를 분리 실행 (--after-update: 이전 가드 종료를 기다린 뒤 시작)."""
    flags = 0x00000008 | 0x00000200  # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    subprocess.Popen([str(exe), "--after-update"], creationflags=flags, close_fds=True)


def cleanup_old(current_exe: str) -> None:
    """설치 폴더의 예전 버전 exe·임시 파일 정리 (실패는 무시)."""
    try:
        cur = Path(current_exe).resolve()
        for p in install_dir().iterdir():
            if p.suffix.lower() in (".exe", ".part") and p.resolve() != cur:
                try:
                    p.unlink()
                except OSError:
                    pass
    except OSError:
        pass


def runtime_dir() -> Path:
    """exe 실행 시 내부 파일을 풀어두는 폴더 (build.ps1 의 --runtime-tmpdir 과 같은 위치).
    백신 제외 폴더(%LOCALAPPDATA%\\HMSGuard) 안이라 부팅 때 파일 검사로 느려지지 않는다."""
    return install_dir() / "rt"


def cleanup_runtime_dirs() -> None:
    """강제 종료 등으로 남은 예전 압축 해제 폴더(_MEI*) 정리. 지금 쓰는 폴더와
    다른 프로세스(워치독)가 쓰는 폴더는 잠겨 있어 지워지지 않으므로 그대로 둔다."""
    import shutil

    cur = getattr(sys, "_MEIPASS", None)
    base = runtime_dir()
    if not base.exists():
        return
    for p in base.glob("_MEI*"):
        try:
            if cur and p.resolve() == Path(cur).resolve():
                continue
            # 쓰고 있는 폴더는 이름 바꾸기가 실패한다 → 실행 중인 프로세스의 파일은 건드리지 않음
            trash = p.with_name("_old" + p.name)
            p.rename(trash)
            shutil.rmtree(trash, ignore_errors=True)
        except OSError:
            pass
    for p in base.glob("_old_MEI*"):  # 지난번에 지우다 남은 것
        shutil.rmtree(p, ignore_errors=True)


def frozen() -> bool:
    return bool(getattr(sys, "frozen", False))
