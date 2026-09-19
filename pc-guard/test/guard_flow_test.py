"""
세션 가드 통합 테스트 (수동 실행)
==================================
실제 HMS 서버 + 실제 GuardApp UI 코드 경로를 화면 조작 없이 구동한다.
(버튼 콜백을 직접 호출하고 tk 이벤트 루프를 수동 펌핑)

실행 전 환경변수:
    DW_TEST_SERVER  예: https://<HMS 서버 주소>
    DW_TEST_ID      테스트 자녀 아이디
    DW_TEST_PW      테스트 자녀 PIN
    DW_DATA_DIR     테스트용 데이터 폴더(운영 설정 오염 방지)

실행:
    python -m test.guard_flow_test
"""

import os
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.session import config, hms_client, watchdog
from src.session.guard import GuardApp

SERVER = os.environ["DW_TEST_SERVER"]
TEST_ID = os.environ["DW_TEST_ID"]
TEST_PW = os.environ["DW_TEST_PW"]

PASS = []
FAIL = []


def check(name: str, cond: bool, detail: str = ""):
    (PASS if cond else FAIL).append(f"{name} {detail}")
    print(("PASS " if cond else "FAIL ") + name, detail)


def pump(app: GuardApp, seconds: float):
    end = time.time() + seconds
    while time.time() < end:
        app.root.update()
        time.sleep(0.05)


def main():
    # 0) 사전 상태 — 부모 계정이 있으면 테스트 가족의 PC 설정을 '하루 종일 사용 가능'으로 잠깐 바꾼다
    #    (끝나면 원래대로 되돌림). 시간대 제한 때문에 밤에 테스트가 막히지 않도록.
    pid, ppw = os.environ.get("DW_TEST_PARENT_ID"), os.environ.get("DW_TEST_PARENT_PW")
    ptoken = before = None
    keys = ("max_session_min", "allowed_start", "allowed_end", "offline_grace_min", "free_windows")
    if pid and ppw:
        ptoken, _ = hms_client.login(SERVER, pid, ppw)
        before = hms_client.get_pc_settings(SERVER, ptoken)
        hms_client.put_pc_settings(SERVER, ptoken, {
            "max_session_min": 60, "allowed_start": "00:00", "allowed_end": "24:00",
            "offline_grace_min": 15, "free_windows": []})
    try:
        run(ptoken, pid, ppw)
    finally:
        if ptoken:
            hms_client.put_pc_settings(SERVER, ptoken, {k: before[k] for k in keys})


def run(ptoken, pid, ppw):
    token, user = hms_client.login(SERVER, TEST_ID, TEST_PW)
    v0 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
    check("사전 잔여시간 조회", v0 > 2, f"(잔여 {v0}분)")

    # 1) 앱 기동 (창 모드, 차감 주기 3초)
    # 방어 계층(워치독·작업관리자 차단) 끄기 — 켜 두면 테스트가 끝난 뒤 워치독이
    # 실제 잠금 화면을 다시 띄운다
    watchdog.set_active(False)
    app = GuardApp(windowed=True, tick_seconds=3)
    pump(app, 0.5)
    check("로그인 화면 표시", hasattr(app, "e_id"))

    # 2) 로그인 (UI 콜백 경로)
    if app.e_server is not None:
        app.e_server.insert(0, SERVER)
    app.e_id.delete(0, "end")
    app.e_id.insert(0, TEST_ID)
    app.e_pw.insert(0, TEST_PW)
    app._do_login()
    pump(app, 1.0)
    check("자녀 로그인 → 자녀 화면", app.child_token is not None and hasattr(app, "spin"))
    check("토큰 저장(이어쓰기용)", hms_client.load_child_token() is not None)

    # 3) 세션 시작 (2분 예약, 첫 1분 차감 + 알림 1회)
    app.spin.delete(0, "end")
    app.spin.insert(0, "2")
    max_start = min(v0, app.cfg["settings"]["max_session_min"])
    app._start_session(max_start)
    pump(app, 1.0)
    check("세션 시작", app.session is not None)
    check("세션 상태 저장", config.load_session_state() is not None)
    v1 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
    check("시작 시 1분 차감", v1 == v0 - 1, f"({v0} → {v1})")

    # 4) 차감 틱 대기 (3초 주기 → 약 7초면 2회 이상)
    pump(app, 7.5)
    v2 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
    check("세션 중 무음 차감 동작", v2 < v1, f"({v1} → {v2})")

    # 5) 조기 종료 → 남은 시간 보존(이어쓰기)
    app._end_session("테스트 종료")
    pump(app, 0.5)
    check("세션 종료 후 상태 정리", app.session is None and config.load_session_state() is None)
    v3 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
    check("종료 후 잔여 보존(이어쓰기)", v3 == v2, f"(잔여 {v3}분)")

    # 6) 시간대 제한 계산
    s = {"allowed_start": "00:00", "allowed_end": "23:59", "max_session_min": 60,
         "offline_grace_min": 15}
    check("시간대 계산(항상 허용)", config.minutes_until_allowed_end(s) > 0)
    s2 = {"allowed_start": "00:00", "allowed_end": "00:01"}
    check("시간대 계산(마감 지남)", config.minutes_until_allowed_end(s2) == 0)

    # 7) 부모 로그인 → 설정 화면 (선택: DW_TEST_PARENT_ID/PW 설정 시)
    if pid and ppw:
        app.show_login()
        pump(app, 0.3)
        app.e_id.delete(0, "end")
        app.e_id.insert(0, pid)
        app.e_pw.insert(0, ppw)
        app._do_login()
        pump(app, 0.5)
        check("부모 로그인 → 설정 화면", hasattr(app, "auto_btn"))

        # 8) 자유 시간 (HMS v1.28.0+) — 테스트 가족의 PC 설정을 잠깐 바꿨다가 원래대로 돌린다
        base = {k: v for k, v in hms_client.get_pc_settings(SERVER, ptoken).items()
                if k in ("max_session_min", "allowed_start", "allowed_end", "offline_grace_min", "free_windows")}
        now = datetime.now()
        if now.hour == 23 and now.minute >= 45:
            print("SKIP 자유 시간 테스트 (자정 직전)")
        else:
            day = (now.weekday() + 1) % 7
            st = now.strftime("%H:%M")
            en = (now + timedelta(minutes=10)).strftime("%H:%M")
            try:
                # 8-1) 사용권 세션 중 자유 시간 시작 → 차감 중단
                hms_client.put_pc_settings(SERVER, ptoken, {**base, "free_windows": []})
                app.child_token = token
                app.show_child()
                pump(app, 0.5)
                app.spin.delete(0, "end")
                app.spin.insert(0, "5")
                app._start_session(5)
                pump(app, 1.0)
                check("사용권 세션 시작", app.session is not None and app.session["mode"] == "ticket")
                hms_client.put_pc_settings(SERVER, ptoken, {
                    **base, "free_windows": [{"day": day, "start": st, "end": en}]})
                app._sync_settings()
                a0 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
                pump(app, 4.0)
                check("자유 시간 시작 → 자유 모드 전환", app.session is not None and app.session["mode"] == "free")
                pump(app, 7.0)
                a1 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
                check("자유 시간 중 차감 없음", a1 == a0, f"({a0} → {a1})")
                app._end_session("테스트 종료")
                pump(app, 0.5)

                # 8-2) 자녀 화면에서 자유 시간 시작
                pump(app, 0.5)
                app._start_free_session()
                pump(app, 1.0)
                check("자유 시간 세션 시작", app.session is not None and app.session["mode"] == "free")
                check("자유 시간 끝 시각", app.session["end_at"].strftime("%H:%M") == en)
                check("자유 세션 상태 저장", (config.load_session_state() or {}).get("mode") == "free")
                pump(app, 7.0)
                a2 = hms_client.get_vouchers(SERVER, token)["remaining_minutes"]
                check("자유 세션 차감 없음", a2 == a1, f"({a1} → {a2})")

                # 8-3) 부모가 자유 시간을 지우면 세션 종료
                hms_client.put_pc_settings(SERVER, ptoken, {**base, "free_windows": []})
                app._sync_settings()
                pump(app, 4.0)
                check("자유 시간 삭제 → 잠금", app.session is None)
            finally:
                hms_client.put_pc_settings(SERVER, ptoken, base)

    app.root.destroy()

    print()
    print(f"PASS {len(PASS)} / FAIL {len(FAIL)}")
    if FAIL:
        sys.exit(1)


if __name__ == "__main__":
    main()
