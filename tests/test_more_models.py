"""第三階段加入的模式：NOAA AI 模式、加拿大、HAFS、ECMWF AIFS、Google Weather Lab。
fixture 為 2026-10-24 06Z（加拿大 00Z）在 GitHub Actions 上抓到的實際檔案。"""

import importlib.util
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetcher import ecmwf, models, ncep, weatherlab  # noqa: E402
from fetcher.common import NotFound  # noqa: E402

FX = Path(__file__).parent / "fixtures"
NOW = datetime(2026, 10, 24, 14, 50, tzinfo=timezone.utc)
HAS_ECCODES = importlib.util.find_spec("eccodes") is not None


def text(name):
    return (FX / name).read_text(encoding="utf-8")


def fake(files):
    def get_text(url):
        for key, name in files.items():
            if key in url:
                return name if name.startswith("<") else text(name)
        raise NotFound("HTTP 404")
    return get_text


class TestNcepFamily(unittest.TestCase):
    def test_aigefs(self):
        files = {"aigefs.20261024/06/tctrack/aimn": "aigefs_aimn_sample.atcfunix",
                 "aigefs.20261024/06/tctrack/a001": "aigefs_a001_sample.atcfunix"}
        with mock.patch.object(ncep, "get_text", fake(files)):
            out = ncep.fetch_aigefs(NOW)
        self.assertEqual(out["init"], "2026-10-24T06:00:00Z")
        champi = next(s for s in out["storms"] if s["id"] == "29W")
        self.assertEqual(champi["mean"][0][:3], [0, 26.6, 123.4])
        self.assertEqual(len(champi["members"]), 1)

    def test_cmc_deterministic(self):
        with mock.patch.object(ncep, "get_text", fake({"cmce.20261024/00/tctrack/cmc.": "cmce_cmc_sample.atcfunix"})):
            out = ncep.fetch_cmc(NOW)
        self.assertEqual(out["init"], "2026-10-24T00:00:00Z")
        self.assertEqual({s["id"] for s in out["storms"]} >= {"29W", "30W"}, True)
        self.assertEqual(next(s for s in out["storms"] if s["id"] == "29W")["track"][0][:3], [0, 24.9, 123.0])

    def test_hgefs_mean_only(self):
        with mock.patch.object(ncep, "get_text", fake({"hgefs.20261024/06/tctrack/ahmn": "hgefs_ahmn_sample.atcfunix"})):
            out = ncep.fetch_hgefs_mean(NOW)
        s = out["storms"][0]
        self.assertEqual(s["members"], [])
        self.assertEqual(s["mean"][0][:3], [0, 26.6, 123.4])

    def test_hafs_listing(self):
        listing = ('<a href="22e.2026102406.hfsa.trak.atcfunix">x</a>'
                   '<a href="29w.2026102406.hfsa.trak.atcfunix">x</a>')
        files = {"hfsa.20261024/12/": "<html>no tracks yet</html>",
                 "hfsa.20261024/06/29w.": "hfsa_29w_sample.atcfunix",
                 "hfsa.20261024/06/": listing}
        with mock.patch.object(ncep, "get_text", fake(files)):
            out = ncep.fetch_hafs(NOW)
        # 12Z 目錄還沒有路徑檔，退回 06Z；東太平洋的 22E 不抓
        self.assertEqual(out["init"], "2026-10-24T06:00:00Z")
        self.assertEqual([s["id"] for s in out["storms"]], ["29W"])
        self.assertEqual(out["storms"][0]["track"][0][:3], [0, 26.9, 123.3])


class TestWeatherLab(unittest.TestCase):
    def test_parse_mean(self):
        out = weatherlab.parse(text("weatherlab_wnv3_mean.csv"))
        self.assertEqual(set(out), {"29W", "30W"})
        champi = out["29W"][-1]
        self.assertEqual(champi[0][0], 0)
        self.assertTrue(all(100 < p[2] < 200 for p in champi))

    def test_fetch(self):
        files = {"WNV3_2026_10_24T12": None, "ensemble_mean/paired/csv/WNV3_2026_10_24T06": "weatherlab_wnv3_mean.csv",
                 "ensemble/paired/csv/WNV3_2026_10_24T06": "weatherlab_wnv3_ensemble.csv"}

        def get_text(url):
            for key, name in files.items():
                if key in url and name:
                    return text(name)
            raise NotFound("HTTP 404")

        with mock.patch.object(weatherlab, "get_text", get_text):
            out = weatherlab.fetch("WNV3", NOW)
        self.assertEqual(out["init"], "2026-10-24T06:00:00Z")
        champi = next(s for s in out["storms"] if s["id"] == "29W")
        self.assertEqual(len(champi["members"]), 3)
        self.assertTrue(champi["mean"])


@unittest.skipUnless(HAS_ECCODES, "需要 eccodes")
class TestAifs(unittest.TestCase):
    def test_decode_aifs_single(self):
        storms = ecmwf.decode((FX / "aifs_single_tf_sample.bufr").read_bytes())
        kept = {s["id"]: s for s in storms if ecmwf.official(s) and ecmwf.in_wpac(next(iter(s["members"].values())))}
        self.assertEqual(sorted(kept), ["36W", "37W"])
        self.assertEqual(kept["36W"]["init"], "2026-10-24T06:00:00Z")

    def test_url_and_cycles(self):
        init = datetime(2026, 10, 24, 6, tzinfo=timezone.utc)
        self.assertTrue(ecmwf.url("enfo", init, "360h", "aifs-ens").endswith(
            "/20261024/06z/aifs-ens/0p25/enfo/20261024060000-360h-enfo-tf.bufr"))
        self.assertEqual([t.hour for t in ecmwf.candidate_inits(NOW, 3, 6)], [12, 6, 0])


class TestCatalog(unittest.TestCase):
    def test_categories(self):
        cats = {code: m[2] for code, m in models.MODELS.items()}
        self.assertEqual(set(cats.values()), {"global", "hurricane", "ai"})
        for code, (name, kind, cat, size, fn) in models.MODELS.items():
            self.assertIn(kind, ("deterministic", "ensemble"))
            self.assertTrue(callable(fn))


if __name__ == "__main__":
    unittest.main()
