"""前幾報預報的保留規則（fetcher/history.py）。"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetcher import history  # noqa: E402

NOW = datetime(2026, 10, 24, 3, 0, tzinfo=timezone.utc)


def agency(issued, lat=24.0, previous=None):
    a = {"id": "TC2636", "issued": issued,
         "points": [{"tau": 0, "time": issued, "lat": lat, "lon": 123.0, "vmax_kt": 60, "vmax_ms": 30,
                     "pres_hpa": 980, "r70_km": 50}]}
    if previous is not None:
        a["previous"] = previous
    return a


def storms(a):
    return [{"key": "2026-CHAMPI", "agencies": {"jma": a}}]


class TestAgencyHistory(unittest.TestCase):
    def test_new_issue_pushes_old(self):
        prev = {"storms": storms(agency("2026-10-24T00:00:00Z", previous=[]))}
        new = storms(agency("2026-10-24T06:00:00Z", lat=25))
        history.attach_agency_history(new, prev, NOW)
        h = new[0]["agencies"]["jma"]["previous"]
        self.assertEqual([x["issued"] for x in h], ["2026-10-24T00:00:00Z"])
        self.assertNotIn("r70_km", h[0]["points"][0])  # 只留路徑與強度

    def test_same_slot_replaced(self):
        # 日本氣象廳每小時發布：同一個 6 小時時段只留最後一報
        prev = {"storms": storms(agency("2026-10-24T01:45:00Z",
                                        previous=[{"issued": "2026-10-24T00:45:00Z", "points": []}]))}
        new = storms(agency("2026-10-24T02:45:00Z"))
        history.attach_agency_history(new, prev, NOW)
        self.assertEqual([x["issued"] for x in new[0]["agencies"]["jma"]["previous"]], ["2026-10-24T01:45:00Z"])

    def test_unchanged_issue_keeps_history(self):
        old = [{"issued": "2026-10-23T18:00:00Z", "points": []}]
        prev = {"storms": storms(agency("2026-10-24T00:00:00Z", previous=old))}
        new = storms(agency("2026-10-24T00:00:00Z"))
        history.attach_agency_history(new, prev, NOW)
        self.assertEqual(new[0]["agencies"]["jma"]["previous"], old)

    def test_old_and_excess_dropped(self):
        old = [{"issued": f"2026-10-{d:02d}T00:00:00Z", "points": []} for d in (23, 22, 21, 20)]
        prev = {"storms": storms(agency("2026-10-24T00:00:00Z", previous=old))}
        new = storms(agency("2026-10-24T00:00:00Z"))
        history.attach_agency_history(new, prev, NOW)
        self.assertEqual(len(new[0]["agencies"]["jma"]["previous"]), 2)  # 只留 72 小時內

    def test_new_storm_empty(self):
        new = storms(agency("2026-10-24T00:00:00Z"))
        history.attach_agency_history(new, {}, NOW)
        self.assertEqual(new[0]["agencies"]["jma"]["previous"], [])


class TestModelHistory(unittest.TestCase):
    def test_new_init_adds_slim_run(self):
        old = {"init": "2026-10-23T18:00:00Z", "previous": [],
               "storms": [{"id": "29W", "name": None, "mean": [[0, 24, 122, 60, 980]], "members": [[[0, 24, 122, 60, 980]]]}]}
        h = history.model_history(old, "2026-10-24T00:00:00Z", NOW)
        self.assertEqual(h, [{"init": "2026-10-23T18:00:00Z",
                              "storms": [{"id": "29W", "name": None, "mean": [[0, 24, 122, 60, 980]]}]}])

    def test_same_init_keeps(self):
        old = {"init": "2026-10-24T00:00:00Z", "storms": [],
               "previous": [{"init": "2026-10-23T18:00:00Z", "storms": []}]}
        self.assertEqual(history.model_history(old, "2026-10-24T00:00:00Z", NOW), old["previous"])

    def test_keep_limit(self):
        prev = [{"init": f"2026-10-23T{h:02d}:00:00Z", "storms": []} for h in (18, 12, 6, 0)]
        old = {"init": "2026-10-24T00:00:00Z", "storms": [{"id": "29W", "track": [[0, 1, 2, 3, 4]]}], "previous": prev}
        h = history.model_history(old, "2026-10-24T06:00:00Z", NOW)
        self.assertEqual([x["init"] for x in h], ["2026-10-24T00:00:00Z"] + [x["init"] for x in prev[:3]])


if __name__ == "__main__":
    unittest.main()
