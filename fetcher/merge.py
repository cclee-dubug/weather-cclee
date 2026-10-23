"""把各機構的颱風對應成同一顆，產生網頁讀取的 latest.json 內容。"""

from __future__ import annotations

import math

from .common import normalize_name, parse_iso

# 同一顆颱風在不同機構的實況位置差距通常在 1 度內；未命名時用距離配對
MATCH_DISTANCE_KM = 400
MATCH_TIME_HOURS = 12


def _distance_km(a: dict, b: dict) -> float:
    lat1, lon1, lat2, lon2 = map(math.radians, (a["lat"], a["lon"], b["lat"], b["lon"]))
    h = math.sin((lat2 - lat1) / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin((lon2 - lon1) / 2) ** 2
    return 6371 * 2 * math.asin(math.sqrt(h))


def _year(s: dict) -> int | None:
    if s.get("year"):
        return s["year"]
    t = parse_iso(s["points"][0]["time"]) if s.get("points") else None
    return t.year if t else None


def _close(a: dict, b: dict) -> bool:
    pa, pb = a["points"][0], b["points"][0]
    ta, tb = parse_iso(pa["time"]), parse_iso(pb["time"])
    if ta is None or tb is None or abs((ta - tb).total_seconds()) > MATCH_TIME_HOURS * 3600:
        return False
    return _distance_km(pa, pb) <= MATCH_DISTANCE_KM


def group_storms(agency_storms: list) -> list:
    """agency storm 清單 → 颱風清單，每顆含 agencies: {jma: ..., cwa: ..., jtwc: ...}。"""
    groups: list[dict] = []
    # 有名字的先處理，未命名的再用距離併入
    for s in sorted(agency_storms, key=lambda s: normalize_name(s.get("name_en")) is None):
        name = normalize_name(s.get("name_en"))
        year = _year(s)
        target = None
        if name:
            target = next((g for g in groups if g["_name"] == name and g["year"] == year), None)
        if target is None:
            target = next(
                (g for g in groups
                 if s["agency"] not in g["agencies"]
                 and (name is None or g["_name"] is None)
                 and any(_close(s, o) for o in g["agencies"].values())),
                None,
            )
        if target is None:
            target = {"_name": None, "year": year, "name_en": None, "name_zh": None, "agencies": {}}
            groups.append(target)
        if name and target["_name"] is None:
            target["_name"] = name
            target["name_en"] = s.get("name_en")
        if s["agency"] == "cwa" and s.get("name_local"):
            target["name_zh"] = s["name_local"]
        if s["agency"] in target["agencies"]:
            # 同機構同時有兩顆對到同一組（不應發生）：另開一組避免覆蓋
            target = {"_name": name, "year": year, "name_en": s.get("name_en"), "name_zh": None, "agencies": {}}
            groups.append(target)
        target["agencies"][s["agency"]] = {k: v for k, v in s.items() if k != "agency"}

    out = []
    for g in groups:
        if g["_name"]:
            key = f"{g['year']}-{g['_name']}"
        else:
            first_agency = sorted(g["agencies"])[0]
            key = f"{g['year']}-{first_agency}-{g['agencies'][first_agency]['id']}"
        numbers = {a: v.get("number") for a, v in g["agencies"].items() if v.get("number")}
        out.append({
            "key": key,
            "year": g["year"],
            "name_en": g["name_en"],
            "name_zh": g["name_zh"],
            "numbers": numbers,
            "agencies": g["agencies"],
        })
    # 最近有更新的排前面
    out.sort(key=lambda s: max((a.get("issued") or "") for a in s["agencies"].values()), reverse=True)
    return out
