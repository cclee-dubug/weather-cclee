"""交通部中央氣象署 颱風消息與警報（資料集 W-C0034-005）。

端點（需免費註冊會員取得授權碼，放在環境變數 CWA_API_KEY）：
  https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005?format=JSON&Authorization=...

AnalysisData.Fix 為過去每 6 小時的實況（含時間與強度），ForecastData.Fix 為 InitialTime + ForecastHour 的預報。
最大風速為 10 分鐘平均，單位 m/s；風圈半徑單位 km。值多為字串，單一颱風時 TropicalCyclone 可能是物件而非陣列。
"""

from __future__ import annotations

import os
from datetime import timedelta

from .common import FetchError, get_json, iso_utc, ms_to_kt, parse_iso, to_float, valid_position

URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore/W-C0034-005"


def _as_list(v) -> list:
    if v is None or v == "":
        return []
    return v if isinstance(v, list) else [v]


def _children(node, key: str) -> list:
    if isinstance(node, dict):
        return _as_list(node.get(key))
    return _as_list(node)


def _radius(c) -> float | None:
    return to_float(c.get("Radius")) if isinstance(c, dict) else None


def _quadrants(c) -> dict | None:
    if not isinstance(c, dict):
        return None
    out = {}
    for q in _children(c.get("QuadrantRadii"), "Radius"):
        if isinstance(q, dict) and str(q.get("dir", "")).upper() in ("NE", "SE", "SW", "NW"):
            v = to_float(q.get("value"))
            if v is not None:
                out[q["dir"].lower()] = v
    return out or None


def _point(fix: dict, tau: int, time) -> dict | None:
    lat = to_float(fix.get("CoordinateLatitude"))
    lon = to_float(fix.get("CoordinateLongitude"))
    if not valid_position(lat, lon):
        return None
    vmax_ms = to_float(fix.get("MaxWindSpeed"))
    gust_ms = to_float(fix.get("MaxGustSpeed"))
    pt = {
        "tau": tau,
        "time": iso_utc(time),
        "lat": lat,
        "lon": lon,
        "vmax_kt": ms_to_kt(vmax_ms),
        "vmax_ms": vmax_ms,
        "gust_kt": ms_to_kt(gust_ms),
        "pres_hpa": to_float(fix.get("Pressure")),
        "r70_km": to_float(fix.get("Radius70PercentProbability")),
        "r_gale_km": _radius(fix.get("Circle15ms")),
        "r_storm_km": _radius(fix.get("Circle25ms")),
    }
    quads = _quadrants(fix.get("Circle15ms"))
    if quads:
        pt["r_gale_quad_km"] = quads
    return pt


def parse(payload: dict) -> list:
    if not isinstance(payload, dict) or str(payload.get("success", "")).lower() != "true":
        raise FetchError(f"W-C0034-005 回應異常（success={payload.get('success') if isinstance(payload, dict) else None!r}）")
    records = payload.get("records")
    if not isinstance(records, dict):
        raise FetchError("W-C0034-005 缺 records")
    tcs_node = records.get("TropicalCyclones")
    tcs = _children(tcs_node, "TropicalCyclone") if isinstance(tcs_node, dict) else []

    storms = []
    for tc in tcs:
        if not isinstance(tc, dict):
            continue
        analysis = [f for f in _children(tc.get("AnalysisData"), "Fix") if isinstance(f, dict)]
        forecast = [f for f in _children(tc.get("ForecastData"), "Fix") if isinstance(f, dict)]

        past = []
        for f in analysis:
            t = parse_iso(f.get("DateTime"))
            p = _point(f, 0, t) if t else None
            if p:
                past.append(p)
        past.sort(key=lambda p: p["time"])
        if not past:
            continue
        current = dict(past[-1])

        init = next((parse_iso(f.get("InitialTime")) for f in forecast if parse_iso(f.get("InitialTime"))), None)
        issued = init or parse_iso(current["time"])
        points = [current]
        for f in forecast:
            hr = to_float(f.get("ForecastHour"))
            base = parse_iso(f.get("InitialTime")) or init
            if hr is None or base is None:
                continue
            p = _point(f, int(hr), base + timedelta(hours=hr))
            if p:
                points.append(p)
        points.sort(key=lambda p: p["tau"])

        td_no = str(tc.get("CwaTdNo") or "").strip()
        ty_no = str(tc.get("CwaTyNo") or "").strip()
        storms.append({
            "agency": "cwa",
            "id": f"TD{td_no}" if td_no else (tc.get("TyphoonName") or ""),
            "number": ty_no or None,
            "name_en": (tc.get("TyphoonName") or "").strip().title() or None,
            "name_local": (tc.get("CwaTyphoonName") or "").strip() or None,
            "year": int(to_float(tc.get("Year")) or 0) or None,
            "issued": iso_utc(issued),
            "wind_avg_min": 10,
            "past": [{"lat": p["lat"], "lon": p["lon"], "time": p["time"], "vmax_ms": p["vmax_ms"],
                      "pres_hpa": p["pres_hpa"]} for p in past[:-1]],
            "points": points,
        })
    return storms


def fetch() -> list:
    key = os.environ.get("CWA_API_KEY", "").strip()
    if not key:
        raise FetchError("尚未設定 CWA_API_KEY")
    return parse(get_json(URL, {"Authorization": key, "format": "JSON"}))
