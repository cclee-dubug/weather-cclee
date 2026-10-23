"""解析與合併的單元測試。不連網路，fixture 為 2026-10-17 颱風薔琵（CHAMPI）的實際資料。

執行：python -m unittest discover -s tests
"""

import copy
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetcher import __main__ as main_mod  # noqa: E402
from fetcher import cwa, jma, jtwc  # noqa: E402
from fetcher.common import FetchError, normalize_name  # noqa: E402
from fetcher.merge import group_storms  # noqa: E402

FX = Path(__file__).parent / "fixtures"
REF = datetime(2026, 10, 17, 16, 0, tzinfo=timezone.utc)


def load(name):
    return json.loads((FX / name).read_text(encoding="utf-8"))


def jma_storm():
    spec = jma.parse_specifications(load("jma_specifications.json"))
    return {"agency": "jma", "id": "TC2636", "number": spec["number"], "name_en": spec["name_en"],
            "name_local": spec["name_jp"], "issued": spec["issued"], "wind_avg_min": 10,
            "past": jma.parse_past_track(load("jma_forecast.json")), "points": spec["points"]}


def jtwc_storm():
    return {**jtwc.parse_warning((FX / "jtwc_wp2926web.txt").read_text(), "wp2926", REF), "agency": "jtwc"}


def cwa_storm():
    return {**cwa.parse(load("cwa_W-C0034-005.json"))[0], "agency": "cwa"}


class TestJma(unittest.TestCase):
    def test_specifications(self):
        s = jma.parse_specifications(load("jma_specifications.json"))
        self.assertEqual(s["name_en"], "Champi")
        self.assertEqual(s["number"], "2630")
        self.assertEqual([p["tau"] for p in s["points"]], [0, 12, 24, 48, 72, 96, 120])
        a = s["points"][0]
        self.assertEqual((a["lat"], a["lon"], a["pres_hpa"], a["vmax_kt"], a["vmax_ms"]), (12.7, 146.2, 945, 95, 50))
        self.assertEqual((a["r_gale_km"], a["r_storm_km"]), (440, 140))
        self.assertIsNone(a["r70_km"])
        self.assertEqual(s["points"][-1]["r70_km"], 220)
        self.assertIsNone(s["points"][-1]["r_gale_km"])  # 預報段不放風圈

    def test_asymmetric_wind_area_takes_longest(self):
        s = jma.parse_specifications(load("jma_specifications_asym.json"))
        self.assertIsNotNone(s["points"][0]["r_gale_km"])

    def test_low_stage_has_no_wind(self):
        specs = load("jma_specifications.json")
        last = specs[-1]
        last["category"] = {"jp": "低気圧", "en": "LOW"}
        last["maximumWind"] = {"sustained": {"m/s": "0", "kt": "0"}, "gust": {"m/s": "0", "kt": "0"}}
        p = jma.parse_specifications(specs)["points"][-1]
        self.assertEqual((p["category"], p["vmax_kt"], p["vmax_ms"], p["gust_kt"]), ("LOW", None, None, None))

    def test_past_track(self):
        past = jma.parse_past_track(load("jma_forecast.json"))
        self.assertEqual(past[0], {"lat": 9.5, "lon": 160.0, "stage": "td"})
        self.assertEqual((past[-1]["lat"], past[-1]["lon"]), (12.7, 146.2))
        # 熱帶性低氣壓與颱風兩段交界不重複
        pairs = [(p["lat"], p["lon"]) for p in past]
        self.assertEqual(len(pairs), len(set(zip(pairs, pairs[1:]))) + 1)

    def test_missing_title_raises(self):
        with self.assertRaises(FetchError):
            jma.parse_specifications([])


class TestCwa(unittest.TestCase):
    def test_parse(self):
        s = cwa.parse(load("cwa_W-C0034-005.json"))[0]
        self.assertEqual((s["name_en"], s["name_local"], s["number"]), ("Champi", "薔琵", "29"))
        self.assertEqual(s["issued"], "2026-10-17T12:00:00Z")
        self.assertEqual(len(s["past"]), 14)
        taus = [p["tau"] for p in s["points"]]
        self.assertEqual(taus, [0, 6, 12, 18, 24, 36, 48, 72, 96, 120])
        now = s["points"][0]
        self.assertEqual((now["vmax_ms"], now["pres_hpa"], now["r_gale_km"], now["r_storm_km"]), (51, 925, 180, 80))
        self.assertEqual(now["r_gale_quad_km"], {"ne": 200, "se": 160, "sw": 150, "nw": 200})
        last = s["points"][-1]
        self.assertEqual((last["time"], last["r70_km"]), ("2026-10-22T12:00:00Z", 510))

    def test_single_storm_as_object(self):
        p = load("cwa_W-C0034-005.json")
        tcs = p["records"]["TropicalCyclones"]
        tcs["TropicalCyclone"] = tcs["TropicalCyclone"][0]
        self.assertEqual(len(cwa.parse(p)), 1)

    def test_no_storm(self):
        for empty in ({"TropicalCyclone": []}, {}, ""):
            p = load("cwa_W-C0034-005.json")
            p["records"]["TropicalCyclones"] = empty
            self.assertEqual(cwa.parse(p), [])

    def test_bad_payload_raises(self):
        with self.assertRaises(FetchError):
            cwa.parse({"success": "false"})

    def test_missing_key(self):
        with mock.patch.dict("os.environ", {"CWA_API_KEY": ""}):
            with self.assertRaises(FetchError):
                cwa.fetch()


class TestJtwc(unittest.TestCase):
    def test_parse_warning(self):
        s = jtwc_storm()
        self.assertEqual((s["name_en"], s["number"], s["category"], s["warning_nr"]), ("Champi", "29W", "TYPHOON", 13))
        self.assertEqual(s["issued"], "2026-10-17T15:00:00Z")
        self.assertEqual([p["tau"] for p in s["points"]], [0, 12, 24, 36, 48, 60, 72, 96, 120])
        now = s["points"][0]
        self.assertEqual((now["lat"], now["lon"], now["vmax_kt"], now["gust_kt"], now["pres_hpa"]),
                         (12.6, 146.1, 120, 145, 945))
        self.assertEqual(now["radii_nm"]["r34"], {"ne": 110, "se": 110, "sw": 110, "nw": 100})
        self.assertEqual(s["points"][3]["vmax_kt"], 140)
        self.assertEqual(s["points"][-1]["time"], "2026-10-22T12:00:00Z")

    def test_dtg_month_rollover(self):
        self.assertEqual(jtwc.parse_dtg("301800", datetime(2026, 11, 1, tzinfo=timezone.utc)).month, 10)
        self.assertEqual(jtwc.parse_dtg("010000", datetime(2026, 12, 31, tzinfo=timezone.utc)),
                         datetime(2027, 1, 1, tzinfo=timezone.utc))

    def test_unparseable(self):
        self.assertIsNone(jtwc.parse_warning("NOTHING HERE", "wp0126", REF))


class TestMerge(unittest.TestCase):
    def test_same_name_grouped(self):
        g = group_storms([jma_storm(), cwa_storm(), jtwc_storm()])
        self.assertEqual(len(g), 1)
        self.assertEqual(g[0]["key"], "2026-CHAMPI")
        self.assertEqual(g[0]["name_zh"], "薔琵")
        self.assertEqual(set(g[0]["agencies"]), {"jma", "cwa", "jtwc"})
        self.assertEqual(g[0]["numbers"], {"jma": "2630", "cwa": "29", "jtwc": "29W"})
        json.dumps(g)

    def test_unnamed_matched_by_distance(self):
        j = jtwc_storm()
        j["name_en"] = "Twentynine"
        g = group_storms([jma_storm(), j])
        self.assertEqual(len(g), 1)

    def test_far_apart_not_grouped(self):
        j, m = jtwc_storm(), jma_storm()
        j["name_en"], m["name_en"] = "Thirty", None
        j["points"] = [dict(p, lat=p["lat"] + 10) for p in j["points"]]
        self.assertEqual(len(group_storms([m, j])), 2)

    def test_normalize_name(self):
        self.assertEqual(normalize_name("Choi-wan"), "CHOIWAN")
        for n in ("TWENTY-NINE", "Thirty", "Invest", "", None):
            self.assertIsNone(normalize_name(n))


class TestBuild(unittest.TestCase):
    def test_failed_source_reuses_previous(self):
        now = datetime(2026, 10, 17, 16, 0, tzinfo=timezone.utc)
        prev = {"storms": group_storms([jma_storm(), cwa_storm(), jtwc_storm()])}

        def fail():
            raise FetchError("HTTP 503")
        with mock.patch.dict(main_mod.SOURCES, {
            "jma": ("日本氣象廳", lambda: [{k: v for k, v in jma_storm().items() if k != "agency"}]),
            "cwa": ("中央氣象署", fail),
            "jtwc": ("美軍聯合颱風警報中心", lambda: []),
        }):
            out = main_mod.build(prev, now)
        self.assertEqual(out["sources"]["cwa"]["status"], "error")
        self.assertEqual(out["sources"]["jtwc"]["status"], "no_storm")
        agencies = out["storms"][0]["agencies"]
        self.assertTrue(agencies["cwa"]["stale"])
        self.assertNotIn("jtwc", agencies)

        # 超過 24 小時的舊資料不再沿用
        with mock.patch.dict(main_mod.SOURCES, {"jma": ("x", fail), "cwa": ("x", fail), "jtwc": ("x", fail)}):
            out = main_mod.build(prev, now + timedelta(days=2))
        self.assertEqual(out["storms"], [])


if __name__ == "__main__":
    unittest.main()
