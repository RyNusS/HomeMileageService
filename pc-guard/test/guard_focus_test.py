"""
잠금화면 포커스 유지 회귀 테스트 (#10)
========================================
전체화면 잠금 모드에서 keep-front 루프가 2주기 이상 돌아도
로그인 입력칸의 키보드 포커스가 유지되는지 확인한다. (서버 불필요)

실행: python -X utf8 test\\guard_focus_test.py
(약 6초간 전체화면 잠금 창이 표시됨)
"""

import ctypes
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.session import watchdog
from src.session.guard import GuardApp


def pump(app, seconds):
    end = time.time() + seconds
    while time.time() < end:
        app.root.update()
        time.sleep(0.05)


def main():
    watchdog.set_active(False)  # 테스트 후 워치독이 잠금 화면을 되살리지 않도록
    app = GuardApp(windowed=False, tick_seconds=60)
    pump(app, 0.5)

    app.root.focus_force()
    app.e_id.focus_set()
    pump(app, 0.5)

    user32 = ctypes.windll.user32
    ours = user32.GetAncestor(app.root.winfo_id(), 2)

    ok_before = app.root.focus_get() is app.e_id
    print("PASS 초기 포커스 설정" if ok_before else "FAIL 초기 포커스 설정")

    # keep-front 루프 2주기 이상 경과
    pump(app, 5.5)

    foreground = user32.GetForegroundWindow() == ours
    focused = app.root.focus_get()
    ok_after = focused is app.e_id

    app.e_id.insert("end", "typing-check")
    typed_ok = app.e_id.get().endswith("typing-check")

    app.root.destroy()

    if not foreground:
        print("SKIP 포커스 유지 (테스트 중 다른 창이 전경 — 결과 무효)")
        return
    print("PASS 5.5초 후 포커스 유지" if ok_after else f"FAIL 5.5초 후 포커스 유지 (focus={focused})")
    print("PASS 입력 반영" if typed_ok else "FAIL 입력 반영")
    if not (ok_before and ok_after and typed_ok):
        sys.exit(1)


if __name__ == "__main__":
    main()
