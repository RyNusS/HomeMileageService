"""
HMS 세션 가드 — PC방식 사용시간 제어
=====================================
사용권(HMS 사용시간권) 잔여가 있어야 PC를 쓸 수 있게 하는 전체화면 잠금 가드.

동작:
  1. 로그온 시 자동 실행(전체화면 잠금) → 자녀/부모 계정 로그인
  2. 자녀: 잔여 사용시간 확인 → 세션 시작(분 선택) → 실사용 분만 매분 차감(FIFO)
     - 남은 시간은 다음 로그인 때 이어서 사용
     - 세션 시작 시 부모 텔레그램 알림 1회, 이후 차감은 무음
     - 10/5/1분 전 경고, 만료 시 잠금화면 복귀
  3. 요일별 자유 시간: 로그인만 하면 사용권 차감 없이 사용 (사용 가능 시간대·1회 최대보다 우선)
     - 사용권으로 쓰던 중 자유 시간이 시작되면 그때부터 차감을 멈춘다
     - 자유 시간이 끝나면 잠금 (계속 쓰려면 다시 사용권으로 시작)
  4. PC 설정은 HMS 부모 화면(가족 탭 → PC 사용 설정)에서 가족 단위로 정한다.
     가드는 서버에서 받아 사본을 두고, 인터넷이 끊겨도 마지막 설정으로 동작한다.
  5. 부모: 설정 확인, 관리 모드(잠금 해제), 업데이트 확인, 종료/제거
  6. 오프라인: 사용권 세션 중 유예 시간(기본 15분) 초과 시 세션 종료 (우회 방지)
  7. 자동 업데이트: 잠금 화면일 때 서버의 새 버전을 받아 스스로 교체

실행:
    python -m src.session.guard              # 전체화면 잠금 모드
    python -m src.session.guard --windowed   # 창 모드 (개발/테스트)
옵션:
    --tick-seconds N   차감 주기(기본 60초; 테스트용 단축)
    --install-autostart / --remove-autostart
    --after-update     (내부용) 업데이트 직후 — 이전 가드가 끝날 때까지 기다렸다 시작
"""

import argparse
import os
import subprocess
import sys
import threading
import time
import tkinter as tk
from datetime import datetime, timedelta
from tkinter import messagebox, ttk

# --workdir 지원 (자동 시작 시 모듈 경로 보장)
if "--workdir" in sys.argv:
    _i = sys.argv.index("--workdir")
    os.chdir(sys.argv[_i + 1])
    sys.path.insert(0, sys.argv[_i + 1])

from src.session import autostart, config, hms_client, updater, watchdog
from src.session.hms_client import HmsError, HmsOffline

APP_TITLE = "PC 사용 시간 관리"
APP_VERSION = "v1.0.0"
BG = "#0F172A"
CARD = "#1E293B"
FG = "#F1F5F9"
SUB = "#94A3B8"
ACCENT = "#3B82F6"
WARN = "#F59E0B"
ERR = "#EF4444"
OK = "#10B981"

WARN_AT_MIN = (10, 5, 1)
SYNC_EVERY_TICKS = 5             # 세션 중 설정 동기화 주기 (차감 주기 × N)
UPDATE_CHECK_SEC = 30 * 60       # 자동 업데이트 확인 주기


def fmt_end(dt: datetime) -> str:
    """자유 시간 끝 시각 표시 — 다음 날 00:00 이면 '24:00'."""
    if dt.hour == 0 and dt.minute == 0 and dt.date() > datetime.now().date():
        return "24:00"
    return dt.strftime("%H:%M")


def beep():
    try:
        import winsound

        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
    except Exception:
        pass


class GuardApp:
    def __init__(self, windowed: bool, tick_seconds: int):
        self.windowed = windowed
        self.tick_seconds = tick_seconds
        self.cfg = config.load_config()

        self.child_token = None      # 자녀 토큰 (세션 시작용)
        self.child_user = None
        # {"end_at": datetime, "warned": set, "offline_min": int, "mode": "ticket"|"free"}
        self.session = None
        self.timer_win = None
        self.screen = None           # 'login' | 'child' | 'parent' | 'admin' | 'session'
        self._child_gen = 0          # 자녀 화면 자동 새로고침 세대 (중복 예약 방지)
        self._child_free_shown = False
        self._tick_count = 0
        self._update_ready = None    # 내려받아 검증까지 끝난 새 exe 경로
        self._update_busy = False
        self._update_last = 0.0

        self.root = tk.Tk()
        self.root.title(APP_TITLE)
        self.root.configure(bg=BG)
        if not windowed:
            self.root.attributes("-fullscreen", True)
            self.root.attributes("-topmost", True)
            self.root.protocol("WM_DELETE_WINDOW", lambda: None)
            self.root.bind("<Alt-F4>", lambda e: "break")
            self._keep_front()
        else:
            self.root.geometry("560x640")

        self.container = tk.Frame(self.root, bg=BG)
        self.container.pack(expand=True)

        if not self.windowed:
            self._check_abnormal_exit()  # 마커 확인이 mark_running보다 먼저
            watchdog.mark_running()

        self._resume_or_login()
        self.root.after(3000, self._watchdog_tick)
        if updater.frozen() and not self.windowed:
            self.root.after(20 * 1000, self._update_tick)

    def _check_abnormal_exit(self):
        """이전 실행이 정상 종료되지 않았으면(강제 종료 의심) 부모에게 신고.
        신고는 서버 경유 텔레그램. 저장된 자녀 토큰이 있어야 인증 가능."""
        try:
            if not watchdog.was_unclean() or not watchdog.should_alert():
                return
            token = hms_client.load_child_token()
            server = self.cfg.get("server_url")
            if not (token and server):
                return

            def _send():
                try:
                    hms_client.report_event(server, token, "abnormal_exit")
                except Exception:
                    pass

            import threading
            threading.Thread(target=_send, daemon=True).start()
        except Exception:
            pass

    def _watchdog_tick(self):
        """워치독이 살아있는지 주기적으로 확인해 없으면 되살린다 (상호 감시)."""
        try:
            watchdog.ensure_watchdog()
        except Exception:
            pass
        self.root.after(3000, self._watchdog_tick)

    # ── 공통 UI 헬퍼 ────────────────────────────────────────────────────────
    def _keep_front(self):
        """잠금 상태에서 창을 항상 앞으로 (간단 우회 억제).

        가드가 이미 전경(foreground) 창이면 아무것도 하지 않는다 —
        2초마다 lift()/topmost를 재설정하면 창이 재활성화되며 입력 캐럿이
        풀리는 문제가 있었음(#10). Win32 전경 창을 직접 비교해
        다른 앱에 가려진 경우에만 앞으로 끌어와 포커스를 되찾는다.
        """
        if not self.windowed and self.session is None:
            try:
                import ctypes

                user32 = ctypes.windll.user32
                fg = user32.GetForegroundWindow()
                ours = user32.GetAncestor(self.root.winfo_id(), 2)  # GA_ROOT
                if fg != ours:
                    self.root.attributes("-topmost", True)
                    self.root.lift()
                    self.root.focus_force()
            except (tk.TclError, OSError, AttributeError):
                pass
        self.root.after(2000, self._keep_front)

    def _clear(self):
        for w in self.container.winfo_children():
            w.destroy()

    def _card(self):
        card = tk.Frame(self.container, bg=CARD, padx=36, pady=32)
        card.pack(pady=24)
        return card

    def _label(self, parent, text, size=11, color=FG, bold=False, **kw):
        f = ("Malgun Gothic", size, "bold" if bold else "normal")
        lb = tk.Label(parent, text=text, font=f, bg=parent["bg"], fg=color)
        lb.pack(**kw)
        return lb

    def _entry(self, parent, show=None, width=28):
        e = tk.Entry(parent, font=("Malgun Gothic", 12), width=width,
                     show=show, bg="#0B1220", fg=FG, insertbackground=FG,
                     relief="flat", highlightthickness=1,
                     highlightbackground="#334155", highlightcolor=ACCENT)
        e.pack(pady=(2, 10), ipady=6)
        return e

    def _button(self, parent, text, cmd, color=ACCENT, **kw):
        b = tk.Button(parent, text=text, command=cmd, font=("Malgun Gothic", 11, "bold"),
                      bg=color, fg="white", activebackground=color, relief="flat",
                      padx=18, pady=8, cursor="hand2")
        b.pack(**kw)
        return b

    # ── 시작: 세션 복원 or 로그인 화면 ──────────────────────────────────────
    def _resume_or_login(self):
        st = config.load_session_state()
        token = hms_client.load_child_token()
        if st and token:
            mode = st.get("mode", "ticket")
            end_at = datetime.fromisoformat(st["end_at"])
            if mode == "free":
                # 자유 시간 세션은 지금도 자유 시간일 때만 이어간다 (설정 기준으로 끝 시각 재계산)
                fe = config.free_window_end(self.cfg["settings"])
                end_at = fe if fe else datetime.now() - timedelta(seconds=1)
            if end_at > datetime.now():
                # 재부팅/재시작 후 세션 이어가기
                self.child_token = token
                self.session = {"end_at": end_at, "warned": set(), "offline_min": 0, "mode": mode}
                self._enter_session_mode(resumed=True)
                return
            config.save_session_state(None)
        self.show_login()

    # ── 로그인 화면 ─────────────────────────────────────────────────────────
    def show_login(self, notice: str | None = None):
        self._clear()
        self.screen = "login"
        card = self._card()
        self._label(card, "🔒 " + APP_TITLE, 20, bold=True, pady=(0, 4))
        self._label(card, "PC를 사용하려면 로그인하세요", 11, SUB, pady=(0, 18))

        if not self.cfg.get("server_url"):
            self._label(card, "서버 주소", 10, SUB, anchor="w")
            self.e_server = self._entry(card)
        else:
            self.e_server = None

        self._label(card, "아이디", 10, SUB, anchor="w")
        self.e_id = self._entry(card)
        if self.cfg.get("child_login_id"):
            self.e_id.insert(0, self.cfg["child_login_id"])
        self._label(card, "비밀번호(PIN)", 10, SUB, anchor="w")
        self.e_pw = self._entry(card, show="●")
        self.e_pw.bind("<Return>", lambda e: self._do_login())

        self._button(card, "로그인", self._do_login, pady=(8, 0), fill="x")
        self.login_msg = self._label(card, notice or "", 10, WARN, pady=(10, 0))
        self._button(card, "⏻ PC 끄기", self._shutdown_pc, color="#475569",
                     pady=(14, 0))
        self._label(card, APP_VERSION, 8, "#475569", pady=(6, 0))
        watchdog.set_task_manager(False)  # 자녀 제어 화면 — 작업 관리자 차단

    def _shutdown_pc(self):
        """잠금 화면에서 PC 정상 종료 (전원 버튼 강제 종료 방지)."""
        if not messagebox.askyesno(APP_TITLE, "PC를 종료할까요?"):
            return
        try:
            subprocess.Popen(["shutdown", "/s", "/t", "3"])
        except OSError:
            messagebox.showerror(APP_TITLE, "종료 명령을 실행하지 못했어요")
            return
        watchdog.request_stop()          # 종료 3초 동안 워치독 재실행 방지
        watchdog.mark_clean()            # 정상 종료(PC 끄기) 표시
        watchdog.set_task_manager(True)  # 작업 관리자 복원
        self.root.destroy()

    def _do_login(self):
        server = self.cfg.get("server_url")
        if self.e_server is not None:
            server = hms_client.normalize_server_url(self.e_server.get())
        login_id = self.e_id.get().strip()
        pw = self.e_pw.get()
        if not server or not login_id or not pw:
            self.login_msg.config(text="서버 주소·아이디·비밀번호를 입력하세요")
            return
        try:
            token, user = hms_client.login(server, login_id, pw)
        except HmsError as e:
            msg = "아이디 또는 비밀번호가 올바르지 않아요" if e.code == "invalid_credentials" else f"오류: {e.code}"
            self.login_msg.config(text=msg)
            return
        except HmsOffline:
            self.login_msg.config(text="서버에 연결할 수 없어요 (네트워크 확인)")
            return

        self.cfg["server_url"] = server
        if user["role"] == "child":
            self.cfg["child_login_id"] = login_id
            config.save_config(self.cfg)
            self.child_token = token
            self.child_user = user
            hms_client.save_child_token(token)
            self.show_child()
        elif user["role"] in ("parent", "admin", "super_admin"):
            config.save_config(self.cfg)
            self.show_parent(token, user)
        else:
            self.login_msg.config(text="지원하지 않는 계정 유형이에요")

    # ── 자녀 화면 ───────────────────────────────────────────────────────────
    def _sync_settings(self, token: str | None = None) -> bool:
        """서버의 가족 PC 설정을 받아 사본에 반영. 실패(오프라인·구버전 서버)면 False."""
        token = token or self.child_token
        server = self.cfg.get("server_url")
        if not (token and server):
            return False
        try:
            data = hms_client.get_pc_settings(server, token)
        except (HmsError, HmsOffline):
            return False
        if config.apply_server_settings(self.cfg, data):
            config.save_config(self.cfg)
        return True

    def show_child(self):
        self._clear()
        self.screen = "child"
        watchdog.set_task_manager(False)  # 자녀 세션 — 작업 관리자 차단
        card = self._card()
        self._sync_settings()
        try:
            v = hms_client.get_vouchers(self.cfg["server_url"], self.child_token)
            info = hms_client.me(self.cfg["server_url"], self.child_token)
        except (HmsError, HmsOffline):
            self.show_login("정보를 불러오지 못했어요. 다시 로그인해 주세요.")
            return

        remaining = v["remaining_minutes"]
        self._label(card, f"👋 {info['name']}", 16, bold=True)
        self._label(card, f"마일리지 {info['balance']}P", 11, SUB, pady=(0, 12))

        box = tk.Frame(card, bg="#0B1220", padx=20, pady=14)
        box.pack(fill="x", pady=(0, 14))
        self._label(box, "남은 PC 사용시간", 10, SUB)
        self._label(box, f"{remaining}분", 26, OK if remaining > 0 else ERR, bold=True)

        active = [x for x in v["vouchers"] if x["status"] == "active"]
        for x in active[:4]:
            self._label(card, f"🎟️ {x['label']} — {x['remaining_minutes']}/{x['total_minutes']}분",
                        10, SUB, anchor="w")

        settings = self.cfg["settings"]
        window_left = config.minutes_until_allowed_end(settings)
        free_end = config.free_window_end(settings)

        if free_end:
            fbox = tk.Frame(card, bg="#0F2A1E", padx=16, pady=12)
            fbox.pack(fill="x", pady=(14, 6))
            self._label(fbox, "🎉 지금은 자유 시간이에요!", 14, OK, bold=True)
            self._label(fbox, f"{fmt_end(free_end)}까지 사용권 차감 없이 쓸 수 있어요", 11, FG)
            self._button(card, "▶ 자유 시간 시작", self._start_free_session,
                         color=OK, pady=(8, 0), fill="x")
        elif remaining <= 0:
            self._label(card, "사용권이 없어요 😢", 13, ERR, bold=True, pady=(14, 2))
            self._label(card, "마일리지 상점에서 사용권을 구매해 주세요!", 11, FG, pady=(0, 10))
        elif window_left <= 0:
            self._label(card,
                        f"지금은 사용 가능 시간이 아니에요\n(사용 가능: {settings['allowed_start']} ~ {settings['allowed_end']})",
                        11, WARN, pady=(14, 10))
        else:
            max_start = min(remaining, settings["max_session_min"], window_left)
            row = tk.Frame(card, bg=CARD)
            row.pack(pady=(14, 4))
            self._label(row, "사용할 시간(분): ", 11, side="left")
            self.spin = tk.Spinbox(row, from_=5, to=max_start, increment=5,
                                   width=5, font=("Malgun Gothic", 12))
            self.spin.delete(0, "end")
            self.spin.insert(0, str(min(30, max_start)))
            self.spin.pack(side="left")
            self._label(card, f"(최대 {max_start}분 — 안 쓴 시간은 나중에 이어서 사용)",
                        9, SUB, pady=(0, 6))
            self._button(card, "▶ PC 사용 시작", lambda: self._start_session(max_start),
                         color=OK, pady=(6, 0), fill="x")

        today = config.today_free_text(settings)
        if today and not free_end:
            self._label(card, f"🎉 오늘 자유 시간: {today}", 10, SUB, pady=(10, 0))

        self._button(card, "로그아웃", self._logout_child, color="#475569", pady=(16, 0))

        # 자유 시간이 시작/끝나면 화면을 다시 그린다 (30초마다 확인)
        self._child_gen += 1
        self._child_free_shown = free_end is not None
        gen = self._child_gen
        self.root.after(30 * 1000, lambda: self._child_refresh(gen, 1))

    def _child_refresh(self, gen: int, n: int):
        if gen != self._child_gen or self.screen != "child" or self.session is not None:
            return
        if n % 10 == 0:  # 5분마다 설정 동기화
            self._sync_settings()
        now_free = config.free_window_end(self.cfg["settings"]) is not None
        if now_free != self._child_free_shown:
            self.show_child()
            return
        self.root.after(30 * 1000, lambda: self._child_refresh(gen, n + 1))

    def _report_free_start(self, free_end: datetime):
        server, token = self.cfg.get("server_url"), self.child_token
        if not (server and token):
            return

        def _send():
            try:
                hms_client.report_event(server, token, "free_start", until=fmt_end(free_end))
            except Exception:
                pass

        threading.Thread(target=_send, daemon=True).start()

    def _start_free_session(self):
        free_end = config.free_window_end(self.cfg["settings"])
        if not free_end:
            messagebox.showinfo(APP_TITLE, "자유 시간이 끝났어요")
            self.show_child()
            return
        self.session = {"end_at": free_end, "warned": set(), "offline_min": 0, "mode": "free"}
        config.save_session_state({"end_at": free_end.isoformat(), "mode": "free"})
        self._report_free_start(free_end)
        self._enter_session_mode()

    def _logout_child(self):
        hms_client.clear_child_token()
        self.child_token = None
        self.child_user = None
        self.show_login()

    def _start_session(self, max_start: int):
        try:
            minutes = int(self.spin.get())
        except ValueError:
            messagebox.showwarning(APP_TITLE, "시간을 숫자로 입력해 주세요")
            return
        if not (1 <= minutes <= max_start):
            messagebox.showwarning(APP_TITLE, f"5 ~ {max_start}분 사이로 선택해 주세요")
            return
        # 첫 1분 차감 + 부모 알림 1회 (이후 매분 무음 차감)
        try:
            hms_client.consume(self.cfg["server_url"], self.child_token, 1,
                               note=f"PC 사용 시작 — {minutes}분 예약")
        except HmsError as e:
            if e.code == "insufficient_vouchers":
                messagebox.showinfo(APP_TITLE, "사용권이 부족해요. 상점에서 구매해 주세요!")
            else:
                messagebox.showerror(APP_TITLE, f"시작 실패: {e.code}")
            return
        except HmsOffline:
            messagebox.showerror(APP_TITLE, "서버에 연결할 수 없어 시작하지 못했어요")
            return

        end_at = datetime.now() + timedelta(minutes=minutes)
        self.session = {"end_at": end_at, "warned": set(), "offline_min": 0, "mode": "ticket"}
        config.save_session_state({"end_at": end_at.isoformat(), "mode": "ticket"})
        self._enter_session_mode()

    # ── 세션 모드 (잠금 해제 + 타이머) ──────────────────────────────────────
    def _enter_session_mode(self, resumed: bool = False):
        self._clear()
        self.screen = "session"
        self.root.withdraw()

        self.timer_win = tk.Toplevel(self.root)
        self.timer_win.overrideredirect(True)
        self.timer_win.attributes("-topmost", True)
        self.timer_win.configure(bg=CARD)
        sw = self.timer_win.winfo_screenwidth()
        self.timer_win.geometry(f"240x64+{sw - 256}+16")
        self.lbl_time = tk.Label(self.timer_win, text="--:--",
                                 font=("Malgun Gothic", 15, "bold"), bg=CARD, fg=OK)
        self.lbl_time.pack(side="left", padx=(14, 6), pady=10)
        tk.Button(self.timer_win, text="종료", command=self._end_session_confirm,
                  font=("Malgun Gothic", 9), bg="#475569", fg="white",
                  relief="flat", padx=10).pack(side="right", padx=10)

        free = self.session.get("mode") == "free"
        if resumed:
            self._toast("이전 세션을 이어서 사용해요", OK)
        elif free:
            self._toast(f"🎉 자유 시간! {fmt_end(self.session['end_at'])}까지 차감 없이 사용해요", OK)
        self._tick_ui()
        if resumed and not free:
            # 복원 세션: 시작 차감이 없으므로 현재 분부터 즉시 차감
            self._tick_consume()
        else:
            # 새 세션: 시작 시 1분(알림 포함)을 이미 차감했으므로 다음 분부터
            self.root.after(self.tick_seconds * 1000, self._tick_consume)

    def _tick_ui(self):
        if self.session is None:
            return
        free = self.session.get("mode") == "free"
        left = self.session["end_at"] - datetime.now()
        secs = int(left.total_seconds())
        if secs <= 0:
            self._end_session("자유 시간이 끝났어요! 계속 쓰려면 사용권으로 시작해 주세요 👋"
                              if free else "사용 시간이 끝났어요! 다음에 또 만나요 👋")
            return
        mm, ss = divmod(secs, 60)
        hh, m2 = divmod(mm, 60)
        clock = f"{hh}:{m2:02d}:{ss:02d}" if hh else f"{mm:02d}:{ss:02d}"
        self.lbl_time.config(text=("자유 " if free else "") + clock,
                             fg=OK if mm >= 10 else (WARN if mm >= 5 else ERR))
        for w in WARN_AT_MIN:
            if mm + 1 == w and ss >= 58 and w not in self.session["warned"]:
                self.session["warned"].add(w)
                beep()
                self._toast(f"⏰ 자유 시간 {w}분 남았어요!" if free else f"⏰ {w}분 남았어요!",
                            WARN if w > 1 else ERR)
        self.root.after(1000, self._tick_ui)

    def _tick_consume(self):
        """실사용 분 단위 차감 — tick_seconds(기본 60초)마다 1분 무음 차감."""
        if self.session is None:
            return
        if datetime.now() >= self.session["end_at"]:
            return  # 만료 처리는 _tick_ui 담당
        self._tick_count += 1
        if self._tick_count % SYNC_EVERY_TICKS == 0:
            self._sync_settings()  # 부모가 설정을 바꿨으면 반영
        free_end = config.free_window_end(self.cfg["settings"])

        if self.session.get("mode") == "free":
            # 자유 시간: 차감 없음. 설정이 바뀌어 끝 시각이 달라졌으면 따라간다.
            if free_end is None:
                self._end_session("자유 시간이 끝났어요! 계속 쓰려면 사용권으로 시작해 주세요 👋")
                return
            if free_end != self.session["end_at"]:
                self.session["end_at"] = free_end
                self.session["warned"] = set()
                config.save_session_state({"end_at": free_end.isoformat(), "mode": "free"})
            self.root.after(self.tick_seconds * 1000, self._tick_consume)
            return

        if free_end is not None:
            # 사용권으로 쓰던 중 자유 시간 시작 → 지금부터 차감 멈춤, 자유 시간 끝에 잠금
            self.session.update({"mode": "free", "end_at": free_end, "warned": set(),
                                 "offline_min": 0})
            config.save_session_state({"end_at": free_end.isoformat(), "mode": "free"})
            self._toast(f"🎉 자유 시간 시작! 지금부터 {fmt_end(free_end)}까지 사용권이 차감되지 않아요", OK)
            self._report_free_start(free_end)
            self.root.after(self.tick_seconds * 1000, self._tick_consume)
            return

        try:
            hms_client.consume(self.cfg["server_url"], self.child_token, 1, silent=True)
            self.session["offline_min"] = 0
        except HmsError as e:
            if e.code == "insufficient_vouchers":
                self._end_session("사용권이 모두 소진됐어요")
                return
        except HmsOffline:
            self.session["offline_min"] += self.tick_seconds / 60
            grace = self.cfg["settings"].get("offline_grace_min", 15)
            if self.session["offline_min"] >= grace:
                self._end_session("인터넷 연결이 오래 끊겨 세션을 종료해요")
                return
            self._toast("⚠ 서버 연결 끊김 — 잠시 후 재시도", WARN)
        self.root.after(self.tick_seconds * 1000, self._tick_consume)

    def _toast(self, text: str, color=ACCENT):
        try:
            t = tk.Toplevel(self.root)
            t.overrideredirect(True)
            t.attributes("-topmost", True)
            t.configure(bg=color)
            lb = tk.Label(t, text=text, font=("Malgun Gothic", 13, "bold"),
                          bg=color, fg="white", padx=24, pady=14)
            lb.pack()
            t.update_idletasks()
            sw, sh = t.winfo_screenwidth(), t.winfo_screenheight()
            w, h = t.winfo_width(), t.winfo_height()
            t.geometry(f"+{(sw - w) // 2}+{sh - h - 90}")
            t.after(5000, t.destroy)
        except tk.TclError:
            pass

    def _end_session_confirm(self):
        left = self.session["end_at"] - datetime.now() if self.session else timedelta()
        mins = max(0, int(left.total_seconds() // 60))
        if messagebox.askyesno(APP_TITLE,
                               f"지금 종료하면 남은 {mins}분은 저장돼요.\n다음에 이어서 쓸 수 있어요. 종료할까요?"):
            self._end_session("남은 시간은 다음에 이어서 쓸 수 있어요!")

    def _end_session(self, msg: str):
        self.session = None
        config.save_session_state(None)
        if self.timer_win is not None:
            try:
                self.timer_win.destroy()
            except tk.TclError:
                pass
            self.timer_win = None
        self.root.deiconify()
        if not self.windowed:
            self.root.attributes("-fullscreen", True)
            self.root.attributes("-topmost", True)
        beep()
        self.show_child_or_login(msg)

    def show_child_or_login(self, notice: str):
        if self.child_token:
            self.show_child()
            self._toast(notice, ACCENT)
        else:
            self.show_login(notice)

    # ── 부모 화면 ───────────────────────────────────────────────────────────
    def show_parent(self, token: str, user: dict):
        self._clear()
        watchdog.set_task_manager(True)  # 부모 관리 화면 — 작업 관리자 복원
        card = self._card()
        self.screen = "parent"
        self._label(card, f"👨‍👩‍👧 부모 설정 — {user['name']}", 15, bold=True, pady=(0, 10))

        note = self._parent_sync(token)
        s = self.cfg["settings"]
        box = tk.Frame(card, bg="#0B1220", padx=16, pady=12)
        box.pack(fill="x", pady=(0, 6))
        self._label(box, "💻 PC 사용 설정 (모든 PC 공통)", 11, FG, bold=True, anchor="w")
        self._label(box, f"🎉 자유 시간: {config.free_summary(s)}", 10, OK, anchor="w", pady=(6, 0))
        self._label(box, f"🎟️ 사용권: {s['allowed_start']} ~ {s['allowed_end']} · 1회 최대 {s['max_session_min']}분",
                    10, FG, anchor="w")
        self._label(box, f"인터넷 끊김 허용 {s['offline_grace_min']}분", 10, SUB, anchor="w")
        self._label(card, "설정은 HMS 앱 → 가족 탭 → PC 사용 설정에서 바꿔요", 9, SUB)
        if note:
            self._label(card, note, 9, WARN)

        self._button(card, f"업데이트 확인 (현재 {APP_VERSION})", self._manual_update,
                     color="#475569", pady=(10, 0), fill="x")

        auto = autostart.is_installed()
        self.auto_btn = self._button(
            card, f"자동 시작 {'해제' if auto else '등록'}",
            self._toggle_autostart, color="#475569", pady=(8, 0), fill="x")

        self._button(card, "🔓 관리 모드 (잠금 해제)", self._admin_unlock,
                     color=WARN, pady=(8, 0), fill="x")
        self._button(card, "프로그램 종료", self._quit_program,
                     color="#475569", pady=(8, 0), fill="x")
        self._button(card, "🗑 PC에서 제거", self._uninstall_guard,
                     color=ERR, pady=(8, 0), fill="x")
        self._button(card, "로그아웃", lambda: self.show_login(), color="#475569",
                     pady=(14, 0))

    def _parent_sync(self, token: str) -> str:
        """부모 로그인 시 설정 동기화. 서버에 아직 설정이 없으면 이 PC의 기존 설정을 옮긴다."""
        server = self.cfg.get("server_url")
        try:
            data = hms_client.get_pc_settings(server, token)
            if not data.get("configured"):
                s = self.cfg["settings"]
                data = hms_client.put_pc_settings(server, token, {
                    k: s[k] for k in config.SERVER_KEYS if k in s})
                config.apply_server_settings(self.cfg, data)
                config.save_config(self.cfg)
                return "이 PC에 있던 기존 설정을 HMS로 옮겼어요"
            if config.apply_server_settings(self.cfg, data):
                config.save_config(self.cfg)
            return ""
        except HmsOffline:
            return "서버에 연결할 수 없어 마지막으로 받은 설정을 보여줘요"
        except HmsError as e:
            if e.status == 404:
                return "서버가 PC 설정 기능 이전 버전이에요 (이 PC의 설정으로 동작)"
            return f"설정을 불러오지 못했어요 ({e.code})"

    # ── 자동 업데이트 ───────────────────────────────────────────────────────
    def _update_allowed(self) -> bool:
        """잠금 화면(로그인·자녀 대기)일 때만 교체한다 — 사용 중·관리 모드엔 하지 않는다."""
        return self.session is None and self.screen in ("login", "child")

    def _update_tick(self):
        try:
            if self._update_ready and self._update_allowed():
                self._apply_update(self._update_ready)
                return
            now = time.time()
            server = self.cfg.get("server_url")
            if (server and not self._update_busy and not self._update_ready
                    and now - self._update_last >= UPDATE_CHECK_SEC):
                self._update_last = now
                self._update_busy = True

                def _work():
                    try:
                        info = updater.check(server, APP_VERSION)
                        if info:
                            self._update_ready = updater.download(server, info)
                    except Exception:
                        pass
                    finally:
                        self._update_busy = False

                threading.Thread(target=_work, daemon=True).start()
        except Exception:
            pass
        self.root.after(60 * 1000, self._update_tick)

    def _apply_update(self, exe):
        """새 가드 실행 후 지금 가드는 정상 종료 (워치독도 함께 멈춘다)."""
        watchdog.request_stop()
        watchdog.mark_clean()
        try:
            updater.launch(exe)
        except OSError:
            watchdog.clear_stop()
            self._update_ready = None
            self.root.after(60 * 1000, self._update_tick)
            return
        self.root.destroy()

    def _manual_update(self):
        if not updater.frozen():
            messagebox.showinfo(APP_TITLE, "개발 실행 중에는 업데이트할 수 없어요")
            return
        server = self.cfg.get("server_url")
        try:
            info = updater.check(server, APP_VERSION)
        except (HmsError, HmsOffline):
            messagebox.showerror(APP_TITLE, "업데이트 정보를 확인하지 못했어요")
            return
        if not info:
            messagebox.showinfo(APP_TITLE, f"최신 버전이에요 ({APP_VERSION})")
            return
        if not messagebox.askyesno(APP_TITLE, f"새 버전 {info['version']}이 있어요. 지금 설치할까요?\n"
                                              "(가드가 잠깐 꺼졌다가 새 버전으로 다시 켜져요)"):
            return
        try:
            exe = updater.download(server, info)
        except Exception as e:
            messagebox.showerror(APP_TITLE, f"내려받기에 실패했어요 ({e})")
            return
        self._apply_update(exe)

    def _quit_program(self):
        """부모 인증 상태에서 가드만 완전 종료 (자동 시작은 유지)."""
        if not messagebox.askyesno(
                APP_TITLE,
                "가드를 종료할까요?\n자동 시작이 등록돼 있으면 다음 로그온 때 다시 실행돼요."):
            return
        watchdog.request_stop()          # 워치독이 되살리지 않도록
        watchdog.mark_clean()            # 정상 종료 표시 (비정상 종료 오탐 방지)
        watchdog.set_task_manager(True)  # 작업 관리자 복원
        self.root.destroy()

    def _uninstall_guard(self):
        """자동 시작 해제 + 가드 데이터(설정/세션/토큰) 삭제 + 종료."""
        if not messagebox.askyesno(
                APP_TITLE,
                "가드를 이 PC에서 제거할까요?\n"
                "자동 시작 해제, 서버 주소·설정, 진행 중 세션, 저장된 로그인 정보가 삭제돼요.\n"
                "(마일리지·사용권 등 서버 데이터는 그대로 유지됩니다)"):
            return
        watchdog.request_stop()          # 워치독이 되살리지 않도록
        watchdog.mark_clean()            # 정상 종료 표시
        watchdog.set_task_manager(True)  # 작업 관리자 복원
        autostart.uninstall()
        hms_client.clear_child_token()
        for p in (config._config_path(), config._session_path()):
            try:
                if p.exists():
                    p.unlink()
            except OSError:
                pass
        exe = sys.executable if getattr(sys, "frozen", False) else None
        tail = f"\n\n마지막으로 실행 파일만 직접 삭제해 주세요:\n{exe}" if exe else ""
        messagebox.showinfo(APP_TITLE, f"제거가 끝났어요. 프로그램을 종료합니다.{tail}")
        self.root.destroy()

    def _toggle_autostart(self):
        if autostart.is_installed():
            autostart.uninstall()
            messagebox.showinfo(APP_TITLE, "자동 시작을 해제했어요")
        else:
            autostart.install()
            messagebox.showinfo(APP_TITLE, "로그온 시 자동 시작을 등록했어요")
        self.auto_btn.config(text=f"자동 시작 {'해제' if autostart.is_installed() else '등록'}")

    def _admin_unlock(self):
        """부모가 PC를 쓸 때: 잠금을 내리고 재잠금 버튼만 남김.
        플로팅 버튼은 마우스 드래그로 위치를 옮길 수 있다 (5px 이하 이동은 클릭)."""
        watchdog.set_task_manager(True)  # 부모가 PC 사용 — 작업 관리자 복원
        self.screen = "admin"
        self.root.withdraw()
        w = tk.Toplevel(self.root)
        w.overrideredirect(True)
        w.attributes("-topmost", True)
        w.configure(bg=WARN)
        sw = w.winfo_screenwidth()
        w.geometry(f"150x40+{sw - 166}+16")
        lbl = tk.Label(w, text="🔒 다시 잠그기", cursor="fleur",
                       font=("Malgun Gothic", 9, "bold"), bg=WARN, fg="black")
        lbl.pack(expand=True, fill="both")

        drag = {"ox": 0, "oy": 0, "sx": 0, "sy": 0, "moved": False}

        def press(e):
            # 창 내부 그랩 오프셋 + 시작 스크린 좌표
            drag["ox"] = e.x_root - w.winfo_rootx()
            drag["oy"] = e.y_root - w.winfo_rooty()
            drag["sx"], drag["sy"] = e.x_root, e.y_root
            drag["moved"] = False

        def motion(e):
            if (not drag["moved"]
                    and abs(e.x_root - drag["sx"]) <= 5
                    and abs(e.y_root - drag["sy"]) <= 5):
                return
            drag["moved"] = True
            nx = e.x_root - drag["ox"]
            ny = e.y_root - drag["oy"]
            nx = max(0, min(nx, sw - w.winfo_width()))
            ny = max(0, min(ny, w.winfo_screenheight() - w.winfo_height()))
            w.geometry(f"+{nx}+{ny}")

        def release(_e):
            if not drag["moved"]:
                w.destroy()
                self._relock()

        # Toplevel에만 바인딩 — bindtags로 자식(lbl) 이벤트까지 수신, 이중 발화 방지
        w.bind("<ButtonPress-1>", press)
        w.bind("<B1-Motion>", motion)
        w.bind("<ButtonRelease-1>", release)

    def _relock(self):
        self.root.deiconify()
        if not self.windowed:
            self.root.attributes("-fullscreen", True)
            self.root.attributes("-topmost", True)
        self.show_login()

    def run(self):
        self.root.mainloop()


def acquire_single_instance() -> bool:
    """중복 실행 방지 — 이미 실행 중이면 False. (두 인스턴스가 잠금 창을 두고
    서로 포커스를 뺏는 문제 방지)"""
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW(None, False, "DWSessionGuard_SingleInstance")
    return kernel32.GetLastError() != 183  # ERROR_ALREADY_EXISTS


def main():
    ap = argparse.ArgumentParser(description=APP_TITLE)
    ap.add_argument("--windowed", action="store_true", help="창 모드 (개발/테스트)")
    ap.add_argument("--tick-seconds", type=int, default=60, help="차감 주기(초)")
    ap.add_argument("--workdir", help="작업 디렉터리 (자동 시작용)")
    ap.add_argument("--install-autostart", action="store_true")
    ap.add_argument("--remove-autostart", action="store_true")
    ap.add_argument("--watchdog", action="store_true",
                    help="워치독 모드 (내부용, 가드 강제종료 대비 재실행)")
    ap.add_argument("--after-update", action="store_true",
                    help="업데이트 직후 실행 (내부용) — 이전 가드·워치독 종료를 기다린다")
    args = ap.parse_args()

    if args.install_autostart:
        print("등록:", autostart.install())
        return
    if args.remove_autostart:
        print("해제됨" if autostart.uninstall() else "등록돼 있지 않음")
        return

    if args.watchdog:
        watchdog.run_watchdog()
        return

    if args.after_update:
        # 이전 버전 가드·워치독이 완전히 끝날 때까지 대기 (최대 30초)
        for _ in range(60):
            if not (watchdog.mutex_exists(watchdog.GUARD_MUTEX)
                    or watchdog.mutex_exists(watchdog.WATCHDOG_MUTEX)):
                break
            time.sleep(0.5)

    if not acquire_single_instance():
        root = tk.Tk()
        root.withdraw()
        messagebox.showinfo(APP_TITLE, "이미 실행 중이에요.")
        return

    # 창(개발) 모드에서는 방어 계층을 끈다 (잠금 재실행·정책 변경 방지)
    watchdog.set_active(not args.windowed)
    # 이전 세션의 정상종료 플래그 정리 + 워치독 기동 (강제종료 방어)
    watchdog.clear_stop()
    watchdog.ensure_watchdog()

    if updater.frozen() and not args.windowed:
        try:
            autostart.sync_to_current()          # 자동 시작을 지금 exe 로 (업데이트 후 경로 변경)
            updater.cleanup_old(sys.executable)  # 예전 버전 파일 정리
        except Exception:
            pass

    app = GuardApp(windowed=args.windowed, tick_seconds=max(5, args.tick_seconds))
    app.run()


if __name__ == "__main__":
    main()
