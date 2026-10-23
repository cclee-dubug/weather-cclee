"""日本氣象廳（RSMC Tokyo）颱風預報。

端點（免註冊）：
  https://www.jma.go.jp/bosai/typhoon/data/targetTc.json            現存熱帶氣旋清單
  https://www.jma.go.jp/bosai/typhoon/data/{tc}/specifications.json 各時刻位置、氣壓、風速、風圈、70% 機率圓
  https://www.jma.go.jp/bosai/typhoon/data/{tc}/forecast.json       過去路徑（只有座標，沒有時間）

最大風速為 10 分鐘平均。
"""

from __future__ import annotations

from .common import (
    FetchError, NotFound, get_json, iso_utc, kt_to_ms, parse_iso, to_float, valid_position,
)

BASE = "https://www.jma.go.jp/bosai/typhoon/data"


def _max_range_km(items) -> float | None:
    """galeWarning / stormWarning：非對稱時有多個方位，取最大半徑。"""
    kms = [to_float((it.get("range") or {}).get("km")) for it in items or [] if isinstance(it, dict)]
    kms = [k for k in kms if k is not None]
    return max(kms) if kms else None


def parse_specifications(specs: list) -> dict:
    """specifications.json → {name_en, name_jp, number, category, issued, points[]}。"""
    title = next((p for p in specs if isinstance(p, dict) and p.get("part") == "title"), None)
    if title is None:
        raise FetchError("specifications.json 缺 title 段")
    issued = parse_iso((title.get("issue") or {}).get("UTC"))
    name = title.get("name") or {}

    points = []
    for p in specs:
        if not isinstance(p, dict) or not isinstance(p.get("part"), dict):
            continue
        deg = (p.get("position") or {}).get("deg") or []
        vt = parse_iso((p.get("validtime") or {}).get("UTC"))
        if len(deg) < 2 or vt is None:
            continue
        lat, lon = to_float(deg[0]), to_float(deg[1])
        if not valid_position(lat, lon):
            continue
        wind = (p.get("maximumWind") or {})
        # 轉為溫帶氣旋或低氣壓（category LOW）時 JMA 不預報風速，欄位填 0，視為沒有資料
        vmax_kt = to_float((wind.get("sustained") or {}).get("kt")) or None
        gust_kt = to_float((wind.get("gust") or {}).get("kt")) or None
        tau = int(p.get("advancedHours") or 0)
        points.append({
            "tau": tau,
            "time": iso_utc(vt),
            "lat": lat,
            "lon": lon,
            "vmax_kt": vmax_kt,
            "vmax_ms": (to_float((wind.get("sustained") or {}).get("m/s")) or kt_to_ms(vmax_kt)) if vmax_kt else None,
            "gust_kt": gust_kt,
            "pres_hpa": to_float(p.get("pressure")),
            "category": (p.get("category") or {}).get("en"),
            "r70_km": to_float((p.get("probabilityCircleRadius") or {}).get("km")),
            # 只有實況（tau=0）的強風圈／暴風圈是當下半徑；預報段是警戒範圍，不放
            "r_gale_km": _max_range_km(p.get("galeWarning")) if tau == 0 else None,
            "r_storm_km": _max_range_km(p.get("stormWarning")) if tau == 0 else None,
        })
    points.sort(key=lambda x: x["tau"])
    return {
        "name_en": name.get("en"),
        "name_jp": name.get("jp"),
        "number": title.get("typhoonNumber"),
        "category": (title.get("category") or {}).get("en"),
        "issued": iso_utc(issued) if issued else None,
        "points": points,
    }


def parse_past_track(forecast: list) -> list:
    """forecast.json 實況段的 track（preTyphoon + typhoon）→ [{lat, lon, stage}]。"""
    for p in forecast or []:
        if isinstance(p, dict) and isinstance(p.get("part"), dict) and p.get("advancedHours") == 0:
            track = p.get("track") or {}
            out = []
            for stage in ("preTyphoon", "typhoon"):
                for pt in track.get(stage) or []:
                    if isinstance(pt, list) and len(pt) >= 2:
                        lat, lon = to_float(pt[0]), to_float(pt[1])
                        if valid_position(lat, lon):
                            # 兩段交界的點會重複，略過
                            if out and out[-1]["lat"] == lat and out[-1]["lon"] == lon:
                                continue
                            out.append({"lat": lat, "lon": lon, "stage": "td" if stage == "preTyphoon" else "ts"})
            return out
    return []


def fetch() -> list:
    """回傳各颱風的 agency storm dict。清單本身抓不到時 raise FetchError。"""
    target = get_json(f"{BASE}/targetTc.json")
    if not isinstance(target, list):
        raise FetchError("targetTc.json 格式異常")
    storms, errors = [], []
    for entry in target:
        tc = entry.get("tropicalCyclone") if isinstance(entry, dict) else None
        if not tc:
            continue
        try:
            spec = parse_specifications(get_json(f"{BASE}/{tc}/specifications.json"))
        except NotFound:
            continue  # 檔案已撤下
        except FetchError as e:
            errors.append(f"{tc}: {e}")
            continue
        try:
            past = parse_past_track(get_json(f"{BASE}/{tc}/forecast.json"))
        except FetchError:
            past = []  # 過去路徑是加值，抓不到不影響預報
        if not spec["points"]:
            continue
        storms.append({
            "agency": "jma",
            "id": tc,
            "number": spec["number"],
            "name_en": spec["name_en"],
            "name_local": spec["name_jp"],
            "category": spec["category"],
            "issued": spec["issued"],
            "wind_avg_min": 10,
            "past": past,
            "points": spec["points"],
        })
    if errors and not storms:
        raise FetchError("; ".join(errors))
    return storms
