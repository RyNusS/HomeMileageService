"""
자유 이용 시간 계산 단위 테스트 (서버·화면 없이 실행)
    python -m unittest test.test_free_time
"""

import os
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault("DW_DATA_DIR", tempfile.mkdtemp())

from src.session import config  # noqa: E402

SAT = datetime(2026, 9, 19)  # 토요일
SUN = datetime(2026, 9, 20)
MON = datetime(2026, 9, 21)
FRI = datetime(2026, 9, 18)

WEEKEND = {"free_windows": [{"day": 6, "start": "07:00", "end": "09:00"},
                            {"day": 0, "start": "07:00", "end": "09:00"}]}


def at(d, h, m):
    return d.replace(hour=h, minute=m)


class FreeTime(unittest.TestCase):
    def test_weekend_morning(self):
        self.assertEqual(config.free_window_end(WEEKEND, at(SAT, 7, 0)), at(SAT, 9, 0))
        self.assertEqual(config.free_window_end(WEEKEND, at(SUN, 8, 59)), at(SUN, 9, 0))
        self.assertIsNone(config.free_window_end(WEEKEND, at(SAT, 6, 59)))
        self.assertIsNone(config.free_window_end(WEEKEND, at(SAT, 9, 0)))
        self.assertIsNone(config.free_window_end(WEEKEND, at(MON, 7, 30)))
        self.assertIsNone(config.free_window_end(WEEKEND, at(FRI, 8, 0)))

    def test_chain_same_day_and_midnight(self):
        s = {"free_windows": [{"day": 5, "start": "22:00", "end": "24:00"},
                              {"day": 6, "start": "00:00", "end": "01:00"},
                              {"day": 6, "start": "01:00", "end": "02:00"}]}
        self.assertEqual(config.free_window_end(s, at(FRI, 23, 0)), at(SAT, 2, 0))
        self.assertEqual(config.free_window_end(s, at(SAT, 0, 30)), at(SAT, 2, 0))

    def test_bad_entries_ignored(self):
        s = {"free_windows": [{"day": 6, "start": "9:xx", "end": "10:00"}, {"day": "x"}, None,
                              {"day": 6, "start": "10:00", "end": "09:00"}]}
        self.assertIsNone(config.free_window_end(s, at(SAT, 9, 30)))
        self.assertIsNone(config.free_window_end({}, at(SAT, 9, 30)))

    def test_today_text(self):
        self.assertEqual(config.today_free_text(WEEKEND, at(SAT, 12, 0)), "07:00~09:00")
        self.assertEqual(config.today_free_text(WEEKEND, at(MON, 12, 0)), "")

    def test_allowed_end_midnight(self):
        s = {"allowed_start": "08:00", "allowed_end": "24:00"}
        self.assertEqual(config.minutes_until_allowed_end(s, at(SAT, 23, 0)), 60)
        self.assertEqual(config.minutes_until_allowed_end(s, at(SAT, 7, 0)), 0)

    def test_apply_server_settings(self):
        cfg = config.load_config()
        self.assertFalse(cfg["server_configured"])
        self.assertFalse(config.apply_server_settings(cfg, {"configured": False}))
        changed = config.apply_server_settings(cfg, {"configured": True, "max_session_min": 90,
                                                     "allowed_start": "07:00", "allowed_end": "21:30",
                                                     "offline_grace_min": 15, **WEEKEND})
        self.assertTrue(changed)
        self.assertEqual(cfg["settings"]["max_session_min"], 90)
        self.assertEqual(len(cfg["settings"]["free_windows"]), 2)
        self.assertFalse(config.apply_server_settings(cfg, {"configured": True, "max_session_min": 90,
                                                            "allowed_start": "07:00", "allowed_end": "21:30",
                                                            "offline_grace_min": 15, **WEEKEND}))


if __name__ == "__main__":
    unittest.main()
