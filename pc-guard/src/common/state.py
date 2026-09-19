"""
가드 데이터 폴더 규칙
=====================
- 환경변수 DW_DATA_DIR 이 있으면 그 경로 (테스트용)
- exe 로 실행 중이면 %APPDATA%\\DigitalWellbeing\\
  (이전 버전과 같은 폴더 — 업데이트 후에도 로그인 정보·설정이 그대로 유지된다)
- 개발 환경이면 pc-guard/data
"""

import os
import sys
from pathlib import Path


def _get_data_dir() -> Path:
    env_path = os.environ.get("DW_DATA_DIR")
    if env_path:
        base = Path(env_path)
    elif getattr(sys, "frozen", False):
        base = Path(os.environ["APPDATA"]) / "DigitalWellbeing"
    else:
        base = Path(__file__).resolve().parents[2] / "data"
    base.mkdir(parents=True, exist_ok=True)
    return base
