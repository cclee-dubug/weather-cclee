"""保留前幾報的官方預報與模式路徑，讓網頁比較預報怎麼修正。

官方預報：日本氣象廳在颱風接近時每小時、中央氣象署每 3 小時發布一次，逐報保留的話
前幾報幾乎重疊，所以每個 6 小時時段（00、06、12、18Z）只留最後一報。
模式：每次起報都保留（GFS 每 6 小時、IFS 每 12 小時），系集只留平均路徑，檔案才不會太大。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from .common import parse_iso

AGENCY_KEEP = 7  # 含與目前這報同一時段的一筆，網頁最多顯示前 6 報
MODEL_KEEP = 4
MAX_AGE = timedelta(hours=72)
SLOT_SECONDS = 6 * 3600
POINT_KEYS = ("tau", "time", "lat", "lon", "vmax_kt", "vmax_ms", "pres_hpa")


def slot(iso: str | None) -> int | None:
    t = parse_iso(iso)
    return None if t is None else int(t.timestamp()) // SLOT_SECONDS


def _fresh(items: list, key: str, now: datetime) -> list:
    out = []
    for h in items:
        t = parse_iso(h.get(key))
        if t and now - t <= MAX_AGE:
            out.append(h)
    return out


def attach_agency_history(storms: list, prev: dict, now: datetime) -> None:
    """在每個機構的預報加上 previous：[{issued, points}]，新的在前。"""
    old = {}
    for s in prev.get("storms") or []:
        for agency, a in (s.get("agencies") or {}).items():
            if a.get("id"):
                old[(agency, a["id"])] = a
    for s in storms:
        for agency, a in s["agencies"].items():
            o = old.get((agency, a.get("id")))
            if o is None:
                a["previous"] = []
                continue
            hist = list(o.get("previous") or [])
            if o.get("issued") and o.get("issued") != a.get("issued") and o.get("points"):
                entry = {"issued": o["issued"],
                         "points": [{k: p.get(k) for k in POINT_KEYS} for p in o["points"]]}
                if hist and slot(hist[0]["issued"]) == slot(entry["issued"]):
                    hist[0] = entry
                else:
                    hist.insert(0, entry)
            a["previous"] = _fresh(hist, "issued", now)[:AGENCY_KEEP]


def model_history(old: dict, new_init: str | None, now: datetime) -> list:
    """模式換了新的起報時，把上一次起報的決定性路徑或系集平均加進 previous。"""
    hist = list(old.get("previous") or [])
    if old.get("init") and new_init and old["init"] != new_init and old.get("storms"):
        storms = []
        for s in old["storms"]:
            slim = {"id": s.get("id"), "name": s.get("name")}
            if s.get("track"):
                slim["track"] = s["track"]
            elif s.get("mean"):
                slim["mean"] = s["mean"]
            else:
                continue
            storms.append(slim)
        hist.insert(0, {"init": old["init"], "storms": storms})
    return _fresh(hist, "init", now)[:MODEL_KEEP]
