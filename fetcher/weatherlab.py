"""Google DeepMind Weather Lab 的 AI 模式颱風路徑（CSV）。

  https://deepmind.google.com/science/weatherlab/download/cyclones/
      {MODEL}/{ensemble_mean|ensemble}/paired/csv/{MODEL}_{YYYY_MM_DD}T{HH}_00_paired.csv

模式代號（2026-10-24 在 GitHub Actions 上確認）：WNV3（WeatherNext 3，64 個成員）、
FNV3（WeatherNext 2 颱風版，50 個成員，Weather Lab 上的 OPER 與它相同）、GENC（GenCast，50 個成員）。
每 6 小時起報，約 6～7 小時後出現。檔案含全球所有海域，只留西北太平洋（track_id 開頭 WP）。

授權：未來時間的資料適用 Google 的實驗性即時資料使用條款
（https://storage.googleapis.com/weathernext-public/terms-of-use.pdf），過去時間的資料為 CC BY 4.0。
"""

from __future__ import annotations

import csv
import io
from datetime import datetime, timedelta

from .common import FetchError, NotFound, get_text, iso_utc

BASE = "https://deepmind.google.com/science/weatherlab/download/cyclones"


def url(model: str, product: str, init: datetime) -> str:
    stamp = init.strftime("%Y_%m_%dT%H_00")
    return f"{BASE}/{model}/{product}/paired/csv/{model}_{stamp}_paired.csv"


def candidate_inits(now: datetime, count: int = 8):
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 6)
    for _ in range(count):
        yield t
        t -= timedelta(hours=6)


def _num(v: str) -> float | None:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(text: str) -> dict:
    """CSV → {"29W": {sample: [[tau, lat, lon, vmax_kt, pres_hpa], ...]}}，sample -1 是系集平均。"""
    body = "\n".join(line for line in text.splitlines() if line and not line.startswith("#"))
    out: dict[str, dict[int, list]] = {}
    for row in csv.DictReader(io.StringIO(body)):
        tid = row.get("track_id") or ""
        if not tid.startswith("WP") or len(tid) < 4:
            continue
        sid = f"{tid[2:4]}W"
        lat, lon = _num(row.get("lat")), _num(row.get("lon"))
        tau = _num(row.get("lead_time_hours"))
        if lat is None or lon is None or tau is None:
            continue
        wind = _num(row.get("maximum_sustained_wind_speed_knots"))
        pres = _num(row.get("minimum_sea_level_pressure_hpa"))
        sample = int(_num(row.get("sample")) or 0)
        out.setdefault(sid, {}).setdefault(sample, []).append(
            [int(tau), round(lat, 1), round(lon % 360, 1),
             None if wind is None else round(wind), None if pres is None else round(pres)])
    for tracks in out.values():
        for pts in tracks.values():
            pts.sort(key=lambda p: p[0])
    return out


def fetch(model: str, now: datetime, known_init: str | None = None) -> dict | None:
    """最新一次起報的系集平均與各成員路徑；最新一次就是 known_init 時回傳 None。"""
    for init in candidate_inits(now):
        if known_init == iso_utc(init):
            return None
        try:
            mean_text = get_text(url(model, "ensemble_mean", init))
        except NotFound:
            continue
        members_text = get_text(url(model, "ensemble", init))
        means, members = parse(mean_text), parse(members_text)
        storms = []
        for sid in sorted(set(means) | set(members)):
            tracks = members.get(sid, {})
            storms.append({
                "id": sid, "name": None,
                "mean": next(iter(means.get(sid, {}).values()), None),
                "members": [tracks[k] for k in sorted(tracks) if k >= 0],
            })
        return {"init": iso_utc(init), "storms": storms}
    raise FetchError(f"Weather Lab 找不到最近兩天的 {model} 路徑檔")
