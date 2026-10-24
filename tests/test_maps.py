"""模式天氣圖：去除渦旋的計算，以及每次起報產生圖片、沿用、清除舊圖的流程。"""

import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import numpy as np

from fetcher import maps, vortex


def synthetic(lat, lon, clat, clon, env=(7.0, -3.0), gamma=2.5e7, inflow=8.0):
    """均勻環境風＋高斯渦度的颱風＋只在中心附近的輻合。"""
    la, lo = np.meshgrid(lat, lon, indexing="ij")
    x = vortex.EARTH_R * np.deg2rad(lo - clon) * np.cos(np.deg2rad(la))
    y = vortex.EARTH_R * np.deg2rad(la - clat)
    r = np.maximum(np.hypot(x, y), 1.0)
    L = 150e3
    vt = gamma / (2 * np.pi * r) * (1 - np.exp(-(r / L) ** 2))
    vr = -inflow * (r / L) * np.exp(-(r / L) ** 2)
    u = env[0] - vt * y / r + vr * x / r
    v = env[1] + vt * x / r + vr * y / r
    return u, v


class VortexTest(unittest.TestCase):
    def test_removal_recovers_environment(self):
        lat = np.arange(10, 34.01, 0.25)
        lon = np.arange(110, 140.01, 0.25)
        u, v = synthetic(lat, lon, 22.0, 125.0)
        self.assertGreater(np.hypot(u - 7, v + 3).max(), 15)  # 渦旋本身夠強
        (ue, ve), = vortex.remove_vortex([(u, v)], lat, lon, 22.0, 125.0)
        err = np.hypot(ue - 7, ve + 3)
        self.assertLess(err.max(), 0.6)
        mu, mv = vortex.area_mean(ue, ve, lat, lon, 22.0, 125.0)
        self.assertAlmostEqual(mu, 7, delta=0.1)
        self.assertAlmostEqual(mv, -3, delta=0.1)

    def test_direction_from(self):
        self.assertEqual(vortex.direction_from(10, 0), 270)  # 高層西風較強：西風切
        self.assertEqual(vortex.direction_from(0, 10), 180)
        self.assertEqual(vortex.direction_from(-5, -5), 45)


def grid(env200=(20.0, 0.0), env850=(-5.0, 0.0), clat=20.0, clon=130.0):
    lat = np.arange(-5, 45.01, 0.5)
    lon = np.arange(100, 165.01, 0.5)
    g = {"lat": lat, "lon": lon}
    # 環境風隨氣壓線性變化，渦旋往高層減弱
    for p in maps.LEVELS:
        x = (850 - p) / 650
        env = (env850[0] + x * (env200[0] - env850[0]), env850[1] + x * (env200[1] - env850[1]))
        g["u", p], g["v", p] = synthetic(lat, lon, clat, clon, env, gamma=2.5e7 - x * 1.5e7)
    return g


class CropTest(unittest.TestCase):
    def test_crop_across_greenwich(self):
        g = {"lat": np.arange(-10, 10.01, 1.0), "lon": np.arange(0, 360, 1.0)}
        g["u", 200] = np.tile(g["lon"], (len(g["lat"]), 1))
        lat, lon, sub = maps.crop(g, -5, 5, 350, 365)
        self.assertEqual(list(lon), list(range(350, 366)))
        self.assertEqual(list(sub["u", 200][0]), list(range(350, 360)) + list(range(0, 6)))

    def test_shear_frame_westerly(self):
        fr = maps.shear_frame(grid(), 20.0, 130.0)
        self.assertAlmostEqual(fr["mean_kt"], 25 / maps.MS_PER_KT, delta=1.5)
        self.assertAlmostEqual(fr["mean_from"], 270, delta=3)

    def test_layer_weights(self):
        w = maps.layer_weights(maps.LEVELS, 400)
        self.assertEqual(sorted(w), [400, 500, 600, 700, 850])
        self.assertAlmostEqual(sum(w.values()), 1)
        self.assertAlmostEqual(w[850], 75 / 450)

    def test_steering_is_layer_mean_of_environment(self):
        fr = maps.frame_fields(grid(), 20.0, 130.0)
        for key, top in (("dlm400", 400), ("dlm300", 300), ("dlm200", 200)):
            # 線性變化的環境風，氣壓加權平均就是中間氣壓的風：u = -5 + 25 * (850 - 中點) / 650
            mid = (850 + top) / 2
            u = -5 + 25 * (850 - mid) / 650
            pr = fr["products"][key]
            self.assertAlmostEqual(pr["kt"], abs(u) / maps.MS_PER_KT, delta=1.0, msg=key)
            self.assertAlmostEqual(pr["dir"], 90 if u > 0 else 270, delta=3, msg=key)  # 去向


class IfsDownloadTest(unittest.TestCase):
    def test_falls_back_to_ecmwf_mirror(self):
        # u 的各層連續存放，v 的各層也連續但與 u 之間隔著別的欄位 → 合併成兩次 Range 請求
        rows = [("u", str(p)) for p in maps.LEVELS] + [("t", "500")] + [("v", str(p)) for p in maps.LEVELS]
        index = "\n".join(
            '{"levtype": "pl", "param": "%s", "levelist": "%s", "_offset": %d, "_length": 4}' % (p, lev, i * 4)
            for i, (p, lev) in enumerate(rows))
        urls, ranges = [], []

        def fake(url, offset=None, length=None, tries=4):
            urls.append(url)
            if url.startswith(maps.IFS_MIRRORS[0]):
                raise maps.FetchError("HTTPError: HTTP Error 503: Slow Down")
            if offset is None:
                return index.encode()
            ranges.append((offset, length))
            return b"G" * length

        with mock.patch.object(maps, "_fetch", fake), mock.patch.object(maps.time, "sleep"):
            data = maps.ifs_grib(datetime(2026, 10, 23, tzinfo=timezone.utc), 36)
        n = len(maps.LEVELS)
        self.assertEqual(ranges, [(0, 4 * n), (4 * (n + 1), 4 * n)])
        self.assertEqual(len(data), 8 * n)
        self.assertTrue(urls[1].startswith("https://data.ecmwf.int/forecasts/20261023/00z/ifs/0p25/oper/20261023000000-36h-oper-fc"))


class BuildTest(unittest.TestCase):
    def models(self, init):
        track = [[0, 20.0, 130.0, 80, 960], [6, 20.5, 129.5, 85, 955], [12, 21.0, 129.0, 85, 955]]
        return {"models": {
            "gfs": {"init": init, "status": "ok", "storms": [{"id": "29W", "name": None, "track": track}]},
            "ifs": {"init": init, "status": "ok", "storms": [{"id": "36W", "name": "CHAMPI", "track": track[:1]}]},
        }}

    def test_build_reuse_and_prune(self):
        calls = []

        def fake(init, tau, box):
            calls.append(tau)
            self.assertLessEqual(box[0], 20 - maps.HALF_LAT)
            return b""

        now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as d, mock.patch.object(maps, "decode", lambda data: grid()):
            out = Path(d)
            idx = maps.build(self.models("2026-10-23T06:00:00Z"), {}, out, now, {"gfs": fake, "ifs": fake})
            gfs = idx["models"]["gfs"]
            self.assertTrue(gfs["complete"])
            self.assertEqual([f["tau"] for f in gfs["storms"][0]["frames"]], [0, 6, 12])
            first = gfs["storms"][0]["frames"][0]["maps"]
            self.assertEqual(sorted(first), ["dlm200", "dlm300", "dlm400", "shear"])
            self.assertEqual(first["shear"]["img"], "gfs/2026102306/29W_shear_000.png")
            for m in first.values():
                self.assertTrue((out / m["img"]).read_bytes().startswith(b"\x89PNG"))
            self.assertEqual(sorted(calls), [0, 0, 6, 12])

            # 同一次起報：不再下載，直接沿用
            calls.clear()
            again = maps.build(self.models("2026-10-23T06:00:00Z"), idx, out, now, {"gfs": fake, "ifs": fake})
            self.assertEqual(calls, [])
            self.assertEqual(again["models"], idx["models"])

            # 新的起報：舊圖刪掉
            newer = maps.build(self.models("2026-10-23T12:00:00Z"), idx, out, now, {"gfs": fake, "ifs": fake})
            maps.prune(out, newer)
            self.assertFalse((out / first["shear"]["img"]).exists())
            self.assertTrue((out / "gfs/2026102312/29W_dlm300_000.png").exists())
            self.assertFalse((out / "gfs/2026102306").exists())

    def test_retry_only_fetches_missing_times(self):
        calls, broken = [], {6}

        def flaky(init, tau, box):
            calls.append(tau)
            if tau in broken:
                raise maps.FetchError("HTTP 503")
            return b""

        now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
        models = self.models("2026-10-23T06:00:00Z")
        models["models"].pop("ifs")
        with tempfile.TemporaryDirectory() as d, mock.patch.object(maps, "decode", lambda data: grid()):
            first = maps.build(models, {}, Path(d), now, {"gfs": flaky, "ifs": flaky})
            self.assertFalse(first["models"]["gfs"]["complete"])
            self.assertEqual([f["tau"] for f in first["models"]["gfs"]["storms"][0]["frames"]], [0, 12])
            calls.clear()
            broken.clear()
            second = maps.build(models, first, Path(d), now, {"gfs": flaky, "ifs": flaky})
            gfs = second["models"]["gfs"]
            self.assertEqual(calls, [6])
            self.assertTrue(gfs["complete"])
            self.assertEqual(gfs["tries"], 2)
            self.assertEqual([f["tau"] for f in gfs["storms"][0]["frames"]], [0, 6, 12])

    def test_failed_download_retried_then_given_up(self):
        def broken(init, tau, box):
            raise maps.FetchError("HTTP 503")

        now = datetime(2026, 10, 23, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as d:
            idx = {}
            for i in range(maps.MAX_TRIES + 1):
                idx = maps.build(self.models("2026-10-23T06:00:00Z"), idx, Path(d), now, {"gfs": broken, "ifs": broken})
            gfs = idx["models"]["gfs"]
            self.assertFalse(gfs["complete"])
            self.assertEqual(gfs["tries"], maps.MAX_TRIES)
            self.assertIn("HTTP 503", gfs["errors"][0])


if __name__ == "__main__":
    unittest.main()
