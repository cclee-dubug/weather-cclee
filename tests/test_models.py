"""模式路徑（GFS、GEFS、IFS、EPS）的單元測試。不連網路，fixture 為 2026-10-23 的實際資料：
NCEP GEFS 06Z 路徑檔、ECMWF 00Z BUFR（只留薔琵 36W、熱帶性低氣壓 37W 等幾則訊息）。

ECMWF 的測試需要 eccodes（pip install eccodes），沒裝時略過。
"""

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetcher import adeck, ecmwf, models, ncep  # noqa: E402
from fetcher.common import FetchError, NotFound  # noqa: E402

FX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 23, 13, 5, tzinfo=timezone.utc)
HAS_ECCODES = importlib.util.find_spec("eccodes") is not None


def text(name):
    return (FX / name).read_text(encoding="utf-8")


class TestAdeck(unittest.TestCase):
    def test_parse_gefs_mean(self):
        out = adeck.parse(text("gefs_aemn_sample.atcfunix"))
        self.assertEqual(out["init"], "2026-10-23T06:00:00Z")
        # 檔案裡另有東太平洋（EP）與南印度洋（SI），只留西北太平洋
        self.assertEqual(set(out["storms"]), {"29W", "97W"})
        champi = out["storms"]["29W"]["AEMN"]
        self.assertEqual(champi[0], [0, 23.8, 123.4, 88, 953])
        taus = [p[0] for p in champi]
        self.assertEqual(taus, sorted(set(taus)))  # 34/50/64 kt 的重複行只留一筆

    def test_south_west_and_dateline(self):
        line = "WP, 01, 2026102300, 03, AVNO, 012, 015S, 1795W,  40,  990, XX,  34, NEQ"
        pts = adeck.parse(line)["storms"]["01W"]["AVNO"]
        self.assertEqual(pts, [[12, -1.5, 180.5, 40, 990]])

    def test_keeps_latest_cycle_only(self):
        lines = ["WP, 29, 2026102300, 03, AVNO, 000, 230N, 1230E,  80,  950",
                 "WP, 29, 2026102306, 03, AVNO, 000, 238N, 1234E,  85,  955"]
        out = adeck.parse("\n".join(lines))
        self.assertEqual(out["init"], "2026-10-23T06:00:00Z")
        self.assertEqual(out["storms"]["29W"]["AVNO"][0][1], 23.8)


class TestNcep(unittest.TestCase):
    def fake(self, available):
        def get_text(url):
            for key, name in available.items():
                if key in url:
                    return text(name)
            raise NotFound("HTTP 404")
        return get_text

    def test_gefs_latest_cycle(self):
        # 12Z 還沒出來，退回 06Z
        files = {"gefs.20261023/06/tctrack/aemn": "gefs_aemn_sample.atcfunix",
                 "gefs.20261023/06/tctrack/ap01": "gefs_ap01_sample.atcfunix"}
        with mock.patch.object(ncep, "get_text", self.fake(files)):
            out = ncep.fetch_gefs(NOW)
        self.assertEqual(out["init"], "2026-10-23T06:00:00Z")
        champi = next(s for s in out["storms"] if s["id"] == "29W")
        self.assertEqual(len(champi["members"]), 1)  # 只有 ap01 有檔案
        self.assertEqual(champi["mean"][0][1:3], [23.8, 123.4])

    def test_known_init_skips_download(self):
        with mock.patch.object(ncep, "get_text", self.fake({})) as _:
            self.assertIsNone(ncep.fetch_gfs(NOW, known_init="2026-10-23T12:00:00Z"))

    def test_nothing_found(self):
        with mock.patch.object(ncep, "get_text", self.fake({})):
            with self.assertRaises(FetchError):
                ncep.fetch_gfs(NOW)


@unittest.skipUnless(HAS_ECCODES, "需要 eccodes")
class TestEcmwf(unittest.TestCase):
    def test_decode_deterministic(self):
        storms = ecmwf.decode((FX / "ecmwf_oper_tf_sample.bufr").read_bytes())
        by_id = {s["id"]: s for s in storms}
        champi = by_id["36W"]
        self.assertEqual(champi["name"], "CHAMPI")
        self.assertEqual(champi["init"], "2026-10-23T00:00:00Z")
        track = next(iter(champi["members"].values()))
        self.assertEqual(track[0], [0, 22.6, 123.7, 87, 951])
        self.assertEqual(track[1][:3], [6, 23.9, 123.1])
        # 70 以上是 ECMWF 自己偵測的系統，大西洋的 10L 不在西北太平洋
        kept = [s["id"] for s in storms if ecmwf.official(s) and ecmwf.in_wpac(next(iter(s["members"].values())))]
        self.assertEqual(sorted(kept), ["36W", "37W"])

    def test_decode_ensemble(self):
        storms = ecmwf.decode((FX / "ecmwf_enfo_tf_sample.bufr").read_bytes())
        champi = next(s for s in storms if s["id"] == "36W")
        self.assertEqual(len(champi["members"]), 51)
        for track in champi["members"].values():
            self.assertEqual([p[0] for p in track], sorted(p[0] for p in track))
            for _, lat, lon, _, pres in track:
                self.assertTrue(15 < lat < 45 and 110 < lon < 160)
                self.assertTrue(pres is None or 900 < pres < 1020)

    def test_candidate_inits(self):
        got = list(ecmwf.candidate_inits(NOW, 3))
        self.assertEqual([g.hour for g in got], [12, 0, 12])
        self.assertEqual(got[0].day, 23)


class TestModelsBuild(unittest.TestCase):
    def test_ensemble_mean_stops_when_few_members(self):
        members = [[[0, 10.0, 130.0, 30, 1000], [6, 11.0, 131.0, 40, 995]],
                   [[0, 12.0, 132.0, 50, 990]],
                   [[0, 11.0, 131.0, None, None]]]
        self.assertEqual(models.ensemble_mean(members), [[0, 11.0, 131.0, 40, 995]])

    def test_failure_reuses_previous(self):
        prev = {"models": {"gfs": {"status": "ok", "init": "2026-10-23T00:00:00Z", "storms": [{"id": "29W"}]}}}

        def boom(now, known):
            raise FetchError("HTTP 503")

        out = models.build(prev, NOW, {"gfs": ("NCEP GFS", "deterministic", boom)})
        gfs = out["models"]["gfs"]
        self.assertEqual(gfs["status"], "error")
        self.assertEqual(gfs["storms"], [{"id": "29W"}])
        self.assertIn("沿用上次", gfs["message"])

    def test_unchanged_run_keeps_entry(self):
        prev = {"models": {"ifs": {"name": "ECMWF IFS", "kind": "deterministic", "status": "ok",
                                   "init": "2026-10-23T00:00:00Z", "storms": []}}}
        seen = []

        def same(now, known):
            seen.append(known)
            return None

        out = models.build(prev, NOW, {"ifs": ("ECMWF IFS", "deterministic", same)})
        self.assertEqual(seen, ["2026-10-23T00:00:00Z"])
        self.assertEqual(models._content(out), models._content(prev))


if __name__ == "__main__":
    unittest.main()
