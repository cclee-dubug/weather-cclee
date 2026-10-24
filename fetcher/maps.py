"""颱風周圍的模式天氣圖：去除颱風渦旋後的 200–850 hPa 環境垂直風切，
以及 400–850、300–850、200–850 hPa 三種深層平均駛流。

用法：python -m fetcher.maps models.json 圖片資料夾

每個模式、每個颱風、0 到 120 小時每 6 小時一張，中心是模式自己追蹤到的颱風位置
（models.json 的路徑）。只在模式有新的起報時重畫，資料夾裡的 index.json 記錄已經畫好的起報。

  GFS：NOMADS grib filter 只下載 850～200 hPa 八層的 u、v 與需要的範圍。
  IFS：ECMWF 開放資料的 .index 找出這些場在 GRIB 檔裡的位置，以 HTTP Range 只下載這幾段。

每一層各自去除渦旋（vortex.py），再組成各種圖：風切是 200 與 850 hPa 環境風相減；
深層駛流是各層環境風依氣壓加權的平均（梯形積分），反映颱風被環境氣流推動的方向與速度。

需要 numpy、matplotlib 與 eccodes。圖上文字用英文，避免執行環境缺中文字型。
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np

from . import ecmwf, vortex
from .common import FetchError, MS_PER_KT, USER_AGENT, TIMEOUT, http_get, iso_utc, parse_iso

TAUS = range(0, 121, 6)
LEVELS = (850, 700, 600, 500, 400, 300, 250, 200)  # GFS 與 IFS 開放資料都有的層
SCHEMA = 2
HALF_LAT, HALF_LON = 10.0, 13.0  # 圖的範圍：中心上下 10 度、左右 13 度
MARGIN = 1.0  # 計算渦度需要的外圍
SMOOTH = 2.0  # 風切場的高斯平滑，格點數（0.25 度網格）
MAX_STORMS = 6
DOWNLOAD_WORKERS = 4
KEEP = timedelta(hours=48)
NOMADS_FILTER = "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl"
COAST = Path(__file__).with_name("coast_wpac.json")

MODELS = {
    "gfs": {"name": "NCEP GFS", "short": "GFS", "credit": "Data: NOAA NCEP GFS 0.25°"},
    "ifs": {"name": "ECMWF IFS", "short": "IFS", "credit": "Data: ECMWF open data (CC BY 4.0)"},
}
MAX_TRIES = 3  # 同一次起報最多重試幾輪（每小時一輪），之後缺的時段就不補了

# 風切色階（kt），取自 Tropical Tidbits 的 200-850 mb Wind Shear 圖：5 以下白色，60 以上沿用最後一色
SHEAR_LEVELS = [5 + 2.5 * i for i in range(19)] + [55, 57.5, 60]
SHEAR_COLORS = [
    (179, 227, 249), (149, 205, 237), (118, 185, 227), (86, 163, 215), (56, 141, 203), (26, 120, 191),
    (34, 169, 54), (116, 191, 62), (199, 211, 70), (227, 223, 74), (255, 235, 76), (255, 217, 58),
    (255, 201, 38), (255, 183, 18), (255, 165, 0), (247, 129, 14), (240, 92, 30), (230, 57, 43),
    (217, 19, 59), (201, 18, 56), (180, 15, 49),
]
COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]

# 圖資種類。駛流的風速色階沿用同一組顏色，從 2.5 kt 起每 2.5 kt 一色
STEER_LEVELS = [2.5 * (i + 1) for i in range(22)]
PRODUCTS = {
    "shear": {"title": "200-850 hPa Wind Shear (Vortex Removed) [kt]", "levels": SHEAR_LEVELS,
              "ticks": [5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]},
    "dlm400": {"title": "400-850 hPa Deep-Layer Mean Steering (Vortex Removed) [kt]", "top": 400,
               "levels": STEER_LEVELS, "ticks": list(range(5, 56, 5))},
    "dlm300": {"title": "300-850 hPa Deep-Layer Mean Steering (Vortex Removed) [kt]", "top": 300,
               "levels": STEER_LEVELS, "ticks": list(range(5, 56, 5))},
    "dlm200": {"title": "200-850 hPa Deep-Layer Mean Steering (Vortex Removed) [kt]", "top": 200,
               "levels": STEER_LEVELS, "ticks": list(range(5, 56, 5))},
}


# ---------- 下載與解碼 ----------

def _fetch(url: str, offset: int | None = None, length: int | None = None, tries: int = 4) -> bytes:
    """下載整個檔案，或給 offset、length 時只下載那一段。"""
    headers = {"User-Agent": USER_AGENT}
    if offset is not None:
        headers["Range"] = f"bytes={offset}-{offset + length - 1}"
    req = urllib.request.Request(url, headers=headers)
    for i in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                data = resp.read()
            if length is None or len(data) == length:
                return data
            raise FetchError(f"長度不符 {len(data)}/{length}")
        except Exception as e:  # noqa: BLE001 - S3 常回 503 Slow Down（2026-10-23 實測），稍等再試
            if i == tries - 1:
                raise FetchError(f"{type(e).__name__}: {e}") from None
            time.sleep(5 * 2 ** i)
    raise FetchError("unreachable")


def gfs_grib(init: datetime, tau: int, box) -> bytes:
    south, north, west, east = box
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    params = {
        "dir": f"/gfs.{d}/{h}/atmos", "file": f"gfs.t{h}z.pgrb2.0p25.f{tau:03d}",
        "var_UGRD": "on", "var_VGRD": "on", **{f"lev_{p}_mb": "on" for p in LEVELS},
        "subregion": "", "toplat": north, "leftlon": west, "rightlon": east, "bottomlat": south,
    }
    for i in range(3):
        try:
            data = http_get(NOMADS_FILTER, params)
            if data[:4] == b"GRIB":
                return data
            raise FetchError(f"回應不是 GRIB（{len(data)} bytes）")
        except FetchError:
            if i == 2:
                raise
            time.sleep(5 * 2 ** i)
    raise FetchError("unreachable")


# ECMWF 開放資料的兩個來源，目錄結構相同。AWS S3 有時對同一個檔案持續回 503 Slow Down
# （2026-10-23 實測），就改用 ECMWF 自己的伺服器
IFS_MIRRORS = (ecmwf.BASE, "https://data.ecmwf.int/forecasts")


def _merge_ranges(rows) -> list[tuple[int, int]]:
    """相鄰的欄位合併成一次 Range 請求（同一變數的各層在檔案裡常是連續的）。"""
    out = []
    for r in sorted(rows, key=lambda r: r["_offset"]):
        if out and out[-1][0] + out[-1][1] == r["_offset"]:
            out[-1] = (out[-1][0], out[-1][1] + r["_length"])
        else:
            out.append((r["_offset"], r["_length"]))
    return out


def ifs_grib(init: datetime, tau: int, box=None) -> bytes:
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    error = None
    for k, mirror in enumerate(IFS_MIRRORS):
        base = f"{mirror}/{d}/{h}z/ifs/0p25/oper/{d}{h}0000-{tau}h-oper-fc"
        tries = 2 if k < len(IFS_MIRRORS) - 1 else 4  # 前面的來源限流時早點換下一個
        try:
            index = _fetch(base + ".index", tries=tries).decode("utf-8", errors="replace")
            rows = [json.loads(line) for line in index.splitlines() if line.startswith("{")]
            want = [r for r in rows if r.get("levtype") == "pl" and r.get("param") in ("u", "v")
                    and r.get("levelist") in {str(p) for p in LEVELS}]
            if len(want) != 2 * len(LEVELS):
                raise FetchError(f"IFS +{tau}h 的索引裡找不到全部的 u、v")
            parts = []
            for offset, length in _merge_ranges(want):
                parts.append(_fetch(base + ".grib2", offset, length, tries=tries))
                time.sleep(0.3)  # 放慢一點，比較不會被限流
            return b"".join(parts)
        except FetchError as e:
            error = e
    raise error


def decode(data: bytes) -> dict:
    """GRIB2 → {"lat", "lon"（0–360）, ("u", 200): 陣列, ...}，緯度與經度都排成遞增。"""
    import eccodes as codes

    out, pos = {}, 0
    while (start := data.find(b"GRIB", pos)) >= 0:
        h = codes.codes_new_from_message(data[start:])
        try:
            pos = start + codes.codes_get(h, "totalLength")
            ni, nj = codes.codes_get(h, "Ni"), codes.codes_get(h, "Nj")
            lats = codes.codes_get_array(h, "latitudes").reshape(nj, ni)[:, 0]
            lons = codes.codes_get_array(h, "longitudes").reshape(nj, ni)[0] % 360
            vals = codes.codes_get_values(h).reshape(nj, ni)
            key = (codes.codes_get(h, "shortName"), int(codes.codes_get(h, "level")))
        finally:
            codes.codes_release(h)
        ilat, ilon = np.argsort(lats), np.argsort(lons)
        out["lat"], out["lon"] = lats[ilat], lons[ilon]
        out[key] = vals[np.ix_(ilat, ilon)]
    return out


def crop(grid: dict, south, north, west, east):
    """取出範圍內的格點；經度可跨 0／360（回傳的經度會連續遞增）。"""
    lat, lon = grid["lat"], grid["lon"]
    jj = np.where((lat >= south - 1e-6) & (lat <= north + 1e-6))[0]
    rel = (lon - west) % 360
    ii = np.where(rel <= east - west + 1e-6)[0]
    ii = ii[np.argsort(rel[ii])]
    if (len(jj) < 3 or len(ii) < 3 or lat[jj[0]] > south + 0.5 or lat[jj[-1]] < north - 0.5
            or rel[ii[0]] > 0.5 or rel[ii[-1]] < east - west - 0.5):
        raise FetchError("下載的範圍不夠大")
    sub = {k: v[np.ix_(jj, ii)] for k, v in grid.items() if isinstance(k, tuple)}
    return lat[jj], west + rel[ii], sub


# ---------- 計算 ----------

def smooth(a, sigma: float):
    """可分離的高斯平滑（sigma 以格點數計），邊界用鏡射延伸。"""
    if sigma <= 0:
        return a
    n = int(3 * sigma)
    k = np.exp(-0.5 * (np.arange(-n, n + 1) / sigma) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        pad = [(0, 0), (0, 0)]
        pad[axis] = (n, n)
        b = np.pad(a, pad, mode="reflect")
        a = np.apply_along_axis(lambda m: np.convolve(m, k, mode="valid"), axis, b)
    return a


def layer_weights(levels, top: float, bottom: float = 850) -> dict:
    """bottom 到 top 之間各層的氣壓加權（梯形積分），總和為 1。"""
    ps = sorted((p for p in levels if top <= p <= bottom), reverse=True)
    w = {p: 0.0 for p in ps}
    for a, b in zip(ps, ps[1:]):
        w[a] += (a - b) / 2
        w[b] += (a - b) / 2
    total = bottom - top
    return {p: x / total for p, x in w.items()}


def frame_fields(grid: dict, clat: float, clon: float) -> dict:
    """一個颱風、一個時段：各層去除渦旋後，組成每種圖資的向量場與 0–500 公里平均。"""
    lat, lon, f = crop(grid, clat - HALF_LAT - MARGIN, clat + HALF_LAT + MARGIN,
                       clon - HALF_LON - MARGIN, clon + HALF_LON + MARGIN)
    clon_rel = lon[0] + (clon - lon[0]) % 360
    env = dict(zip(LEVELS, vortex.remove_vortex([(f["u", p], f["v", p]) for p in LEVELS], lat, lon, clat, clon_rel)))
    out = {"lat": lat, "lon": lon, "clat": clat, "clon": clon_rel, "products": {}}
    for key, cfg in PRODUCTS.items():
        if key == "shear":
            u, v = env[200][0] - env[850][0], env[200][1] - env[850][1]
        else:
            w = layer_weights(LEVELS, cfg["top"])
            u = sum(env[p][0] * x for p, x in w.items())
            v = sum(env[p][1] * x for p, x in w.items())
        # 0.25 度的風場有很多對流尺度的雜訊，平滑掉（約 1 度）才看得出環境場的分布
        u, v = smooth(u, SMOOTH), smooth(v, SMOOTH)
        mu, mv = vortex.area_mean(u, v, lat, lon, clat, clon_rel)
        # 風切以「來向」表示；駛流以「去向」表示（颱風被推往的方向）
        d = vortex.direction_from(mu, mv)
        out["products"][key] = {"u": u, "v": v, "kt": float(np.hypot(mu, mv)) / MS_PER_KT,
                                "dir": d if key == "shear" else (d + 180) % 360}
    return out


def shear_frame(grid: dict, clat: float, clon: float) -> dict:
    fr = frame_fields(grid, clat, clon)
    p = fr["products"]["shear"]
    return {"lat": fr["lat"], "lon": fr["lon"], "du": p["u"], "dv": p["v"], "clat": fr["clat"], "clon": fr["clon"],
            "mean_kt": p["kt"], "mean_from": p["dir"]}


# ---------- 繪圖 ----------

_coast = None


def coastlines():
    global _coast
    if _coast is None:
        _coast = [np.array(line) for line in json.loads(COAST.read_text())]
    return _coast


def _deg(v, pos, axis):
    v = round(v)
    if axis == "lat":
        return f"{abs(v)}°{'N' if v > 0 else 'S' if v < 0 else ''}"
    v = (v + 180) % 360 - 180
    return f"{abs(v)}°{'E' if 0 < v < 180 else 'W' if v < 0 else ''}"


def render(fr: dict, meta: dict, product: str = "shear") -> bytes:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from matplotlib.collections import LineCollection
    from matplotlib.colors import BoundaryNorm, ListedColormap
    from matplotlib.ticker import FuncFormatter, MultipleLocator
    from PIL import Image

    cfg = PRODUCTS[product]
    clat, clon = fr["clat"], fr["clon"]
    lat, lon = fr["lat"], fr["lon"]
    if "products" in fr:
        pr = fr["products"][product]
        u, v, mean_kt, mean_dir = pr["u"], pr["v"], pr["kt"], pr["dir"]
    else:
        u, v, mean_kt, mean_dir = fr["du"], fr["dv"], fr["mean_kt"], fr["mean_from"]
    spd = np.hypot(u, v) / MS_PER_KT
    levels = cfg["levels"]

    cmap = ListedColormap(np.array(SHEAR_COLORS) / 255).with_extremes(under="white", over=np.array(SHEAR_COLORS[-1]) / 255)
    norm = BoundaryNorm(levels, cmap.N)

    fig = plt.figure(figsize=(8.4, 7.6), dpi=100)
    ax = fig.add_axes([0.07, 0.17, 0.9, 0.73])
    ax.contourf(lon, lat, spd, levels=levels, cmap=cmap, norm=norm, extend="both")
    # 流線用「經度／緯度每單位時間」的速度，螢幕上的方向才正確
    cos = np.cos(np.deg2rad(lat))[:, None]
    ax.streamplot(lon, lat, u / cos, v, color="#1a1a1a", linewidth=0.75,
                  density=1.4, arrowsize=0.9, broken_streamlines=True)
    segs = [np.column_stack([ln[:, 0] + 360 * round((clon - ln[:, 0].mean()) / 360), ln[:, 1]]) for ln in coastlines()]
    ax.add_collection(LineCollection(segs, colors="#222222", linewidths=0.8))

    t = np.linspace(0, 2 * np.pi, 181)
    r = vortex.R0_KM / 111.2
    ax.plot(clon + r * np.sin(t) / np.cos(np.deg2rad(clat + r * np.cos(t))), clat + r * np.cos(t),
            color="#222222", lw=0.9, ls=(0, (4, 3)))
    if product != "shear" and mean_kt > 0.5:
        # 駛流箭頭：以 0–500 公里平均駛流移動 24 小時的距離
        dist = mean_kt * 1.852 * 24 / 111.2
        a = np.deg2rad(mean_dir)
        ax.annotate("", xy=(clon + dist * np.sin(a) / np.cos(np.deg2rad(clat)), clat + dist * np.cos(a)),
                    xytext=(clon, clat), zorder=5,
                    arrowprops={"arrowstyle": "-|>", "color": "#d00000", "lw": 2.4, "mutation_scale": 18})
    ax.text(clon, clat, "L", color="#d00000", fontsize=22, fontweight="bold", ha="center", va="center")
    if meta.get("pres"):
        ax.text(clon, clat - 1.1, f"{meta['pres']:.0f}", color="#d00000", fontsize=10, fontweight="bold",
                ha="center", va="top")

    ax.set_xlim(clon - HALF_LON, clon + HALF_LON)
    ax.set_ylim(clat - HALF_LAT, clat + HALF_LAT)
    ax.set_aspect(1 / np.cos(np.deg2rad(clat)))
    ax.xaxis.set_major_locator(MultipleLocator(5))
    ax.yaxis.set_major_locator(MultipleLocator(5))
    ax.xaxis.set_major_formatter(FuncFormatter(lambda v, p: _deg(v, p, "lon")))
    ax.yaxis.set_major_formatter(FuncFormatter(lambda v, p: _deg(v, p, "lat")))
    ax.grid(color="#555555", lw=0.5, ls=(0, (2, 3)), alpha=0.6)
    ax.tick_params(labelsize=9)

    pos = ax.get_position()
    left, right = pos.x0, pos.x1
    fig.text(left, 0.965, f"{meta['model']} {cfg['title']}",
             fontsize=12.5, fontweight="bold", va="top")
    fig.text(left, 0.93, f"Init: {meta['init']:%HZ %d %b %Y}   Forecast Hour: [{meta['tau']}]", fontsize=10, va="top")
    fig.text(right, 0.93, f"Valid: {meta['valid']:%HZ %a %d %b %Y}", fontsize=10, va="top", ha="right")
    fig.text(right, 0.965, meta["storm"], fontsize=12, fontweight="bold", va="top", ha="right")

    cax = fig.add_axes([left, 0.085, right - left, 0.022])
    cb = fig.colorbar(plt.cm.ScalarMappable(norm=norm, cmap=cmap), cax=cax, orientation="horizontal",
                      extend="max", ticks=cfg["ticks"])
    cb.ax.tick_params(labelsize=9)
    d = mean_dir
    if product == "shear":
        summary = f"0-500 km mean shear: {mean_kt:.0f} kt from {d:03.0f}° ({COMPASS[round(d / 45) % 8]})"
        note = "Dashed circle: 500 km (vortex removal and averaging radius)"
    else:
        summary = f"0-500 km mean steering: {mean_kt:.0f} kt toward {d:03.0f}° ({COMPASS[round(d / 45) % 8]})"
        note = "Dashed circle: 500 km. Arrow: 24-h displacement at the mean steering"
    fig.text(left, 0.035, summary, fontsize=9.5, fontweight="bold")
    fig.text(left, 0.01, note, fontsize=8.5, color="#555555")
    fig.text(right, 0.01, meta["credit"], fontsize=8.5, ha="right", color="#555555")

    buf = io.BytesIO()
    fig.savefig(buf, format="png")
    plt.close(fig)
    # 轉成 256 色的調色盤 PNG，檔案小一半以上
    img = Image.open(io.BytesIO(buf.getvalue())).convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT)
    out = io.BytesIO()
    img.save(out, format="PNG", optimize=True)
    return out.getvalue()


# ---------- 每次起報產生一組圖 ----------

GRIB = {"gfs": gfs_grib, "ifs": ifs_grib}


def _frames(track) -> dict:
    return {p[0]: p for p in track or [] if p[0] in TAUS and p[1] is not None and p[2] is not None}


def _box(tracks) -> tuple:
    """所有颱風、所有時段的圖都涵蓋在內的下載範圍（南、北、西、東，經度 0–360）。"""
    lats = [p[1] for t in tracks for p in t.values()]
    lons = [p[2] % 360 for t in tracks for p in t.values()]
    pad_lat, pad_lon = HALF_LAT + MARGIN + 1, HALF_LON + MARGIN + 1
    return (max(-80, int(np.floor(min(lats) - pad_lat))), min(80, int(np.ceil(max(lats) + pad_lat))),
            max(0, int(np.floor(min(lons) - pad_lon))), min(360, int(np.ceil(max(lons) + pad_lon))))


def _label(storm) -> str:
    sid, name = storm.get("id") or "", storm.get("name") or ""
    return f"{name} ({sid})" if name and name != sid else sid or name


def build_model(code: str, entry: dict, outdir: Path, grib=None, done: dict | None = None) -> dict:
    """done 是同一次起報上一輪已經畫好的圖（重試時只補缺的時段）。"""
    grib = grib or GRIB[code]
    init = parse_iso(entry["init"])
    storms = [s for s in entry.get("storms") or [] if _frames(s.get("track"))][:MAX_STORMS]
    tracks = [_frames(s["track"]) for s in storms]
    out = [{"id": s["id"], "name": s.get("name"), "track": s["track"], "frames": []} for s in storms]
    have = {(s["id"], f["tau"]): f for s in (done or {}).get("storms", []) for f in s["frames"]
            if all((outdir / m["img"]).exists() for m in f.get("maps", {}).values())}
    errors = []
    taus = sorted({tau for t in tracks for tau in t})
    box = _box(tracks) if tracks else None

    # 下載比繪圖慢（IFS 每個時段要十幾次 Range 請求），先以幾條執行緒同時下載，邊下載邊畫
    def get(tau):
        if all((s["id"], tau) in have for s, t in zip(storms, tracks) if tau in t):
            return None
        try:
            return grib(init, tau, box)
        except Exception as e:  # noqa: BLE001 - 一個時段失敗不影響其他時段
            return e

    pool = ThreadPoolExecutor(max_workers=DOWNLOAD_WORKERS)
    downloads = pool.map(get, taus)
    for tau, data in zip(taus, downloads):
        need = [(s, t, o) for s, t, o in zip(storms, tracks, out) if tau in t]
        for s, t, o in need:
            if (s["id"], tau) in have:
                o["frames"].append(have[s["id"], tau])
        need = [x for x in need if (x[0]["id"], tau) not in have]
        if not need:
            continue
        try:
            if isinstance(data, Exception):
                raise data
            grid = decode(data)
        except Exception as e:  # noqa: BLE001 - 一個時段失敗不影響其他時段
            errors.append(f"+{tau}h：{e}")
            continue
        valid = init + timedelta(hours=tau)
        for s, t, o in need:
            p = t[tau]
            try:
                fr = frame_fields(grid, p[1], p[2])
            except (FetchError, KeyError) as e:
                errors.append(f"{s['id']} +{tau}h：{e}")
                continue
            meta = {"model": MODELS[code]["short"], "init": init, "tau": tau, "valid": valid,
                    "storm": _label(s), "pres": p[4] if len(p) > 4 else None, "credit": MODELS[code]["credit"]}
            sid = re.sub(r"[^A-Za-z0-9]", "", s["id"]) or "TC"
            maps = {}
            for key in PRODUCTS:
                img = f"{code}/{init:%Y%m%d%H}/{sid}_{key}_{tau:03d}.png"
                path = outdir / img
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(render(fr, meta, key))
                pr = fr["products"][key]
                maps[key] = {"img": img, "kt": round(pr["kt"], 1), "dir": round(pr["dir"]) % 360}
            o["frames"].append({"tau": tau, "valid": iso_utc(valid), "lat": p[1], "lon": p[2], "maps": maps})
        print(f"[{code}] +{tau}h 完成", flush=True)
    pool.shutdown()
    return {"name": MODELS[code]["name"], "init": entry["init"], "complete": not errors,
            "errors": errors[:5], "storms": out}


def build(models: dict, prev: dict, outdir: Path, now: datetime, grib=None) -> dict:
    result = {"schema": SCHEMA, "products": list(PRODUCTS), "models": {}}
    if prev.get("schema") != SCHEMA:
        prev = {}  # 格式改過，全部重畫
    for code in MODELS:
        m = (models.get("models") or {}).get(code) or {}
        old = (prev.get("models") or {}).get(code)
        init = parse_iso(m.get("init"))
        if old and old.get("init") == m.get("init") and (old.get("complete") or old.get("tries", 1) >= MAX_TRIES):
            result["models"][code] = old
        elif not init:
            # 模式資料讀不到時保留上一版的圖
            if old:
                result["models"][code] = old
        elif now - init > KEEP:
            result["models"][code] = {"name": MODELS[code]["name"], "init": m["init"], "complete": True, "storms": []}
        else:
            same = old and old.get("init") == m["init"]
            tries = old.get("tries", 1) + 1 if same else 1
            new = build_model(code, m, outdir, grib and grib[code], old if same else None)
            result["models"][code] = {**new, "tries": tries}
        e = result["models"].get(code)
        if e:
            n = sum(len(s["frames"]) for s in e["storms"])
            print(f"[{code}] {e['init']} {len(e['storms'])} 個系統、{n} 張圖" + ("" if e.get("complete") else f"，缺 {len(e.get('errors') or [])} 項"))
    return result


def prune(outdir: Path, index: dict) -> None:
    """刪掉 index 沒用到的舊圖（舊的起報）。"""
    keep = {m["img"] for e in index["models"].values() for s in e["storms"] for f in s["frames"]
            for m in f.get("maps", {}).values()}
    for code in MODELS:
        for f in (outdir / code).rglob("*.png") if (outdir / code).exists() else []:
            if f.relative_to(outdir).as_posix() not in keep:
                f.unlink()
        for d in sorted((outdir / code).rglob("*"), reverse=True) if (outdir / code).exists() else []:
            if d.is_dir() and not any(d.iterdir()):
                d.rmdir()


def main(argv: list[str]) -> int:
    models_path, outdir = Path(argv[1]), Path(argv[2])
    try:
        models = json.loads(models_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        models = {}
    try:
        prev = json.loads((outdir / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    now = datetime.now(timezone.utc)
    index = build(models, prev, outdir, now)
    changed = json.dumps(index["models"], sort_keys=True) != json.dumps(prev.get("models"), sort_keys=True)
    if changed:
        index["updated_at"] = iso_utc(now)
        outdir.mkdir(parents=True, exist_ok=True)
        (outdir / "index.json").write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        prune(outdir, index)
        print("已更新 index.json")
    else:
        print("沒有新的起報，不更新")
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"], "a") as f:
            f.write(f"changed={'true' if changed else 'false'}\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
