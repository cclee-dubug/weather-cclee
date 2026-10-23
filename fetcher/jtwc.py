"""美軍聯合颱風警報中心（JTWC）警報文字。

端點（免註冊）：
  https://www.metoc.navy.mil/jtwc/rss/jtwc.rss                    現行警報清單（內含各颱風警報文字連結）
  https://www.metoc.navy.mil/jtwc/products/wp{NN}{YY}web.txt      西北太平洋單一颱風警報文字

最大風速為 1 分鐘平均（通常比 10 分鐘平均高約 12%），單位 kt；風圈半徑單位 nm。
文字中的時間（DTG）只有「日時分」，年月要用抓取時間推回來。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from .common import FetchError, NotFound, get_text, iso_utc, kt_to_ms, valid_position

RSS_URL = "https://www.metoc.navy.mil/jtwc/rss/jtwc.rss"

RE_WARNING_LINK = re.compile(r"(https?://[^'\"<>\s]*?/(wp\d{4})web\.txt)", re.IGNORECASE)
RE_TITLE = re.compile(
    r"\b(SUPER TYPHOON|TYPHOON|TROPICAL STORM|TROPICAL DEPRESSION)\s+(\d{1,2}[A-Z])\s+\(([A-Z][A-Z-]*)\)\s+WARNING\s+NR\s+(\d+)",
    re.IGNORECASE,
)
RE_POS = r"(\d{6})Z\s+---?\s+(?:NEAR\s+)?(\d+(?:\.\d+)?)([NS])\s+(\d+(?:\.\d+)?)([EW])"
RE_WARN_POS = re.compile(r"WARNING POSITION:\s*\n\s*" + RE_POS, re.IGNORECASE)
RE_FCST = re.compile(r"(\d+)\s+HRS,?\s+VALID AT:\s*\n\s*" + RE_POS, re.IGNORECASE)
RE_WIND = re.compile(r"MAX SUSTAINED WINDS\s*-\s*(\d+)\s*KT(?:,\s*GUSTS\s*(\d+)\s*KT)?", re.IGNORECASE)
RE_RADII = re.compile(
    r"RADIUS OF (\d{3}) KT WINDS\s*-\s*((?:\d{3}\s*NM\s+[A-Z]+\s+QUADRANT\s*)+)", re.IGNORECASE)
RE_QUAD = re.compile(r"(\d{3})\s*NM\s+(NORTHEAST|SOUTHEAST|SOUTHWEST|NORTHWEST)", re.IGNORECASE)
RE_HEADER = re.compile(r"^WTPN\d{2}\s+PGTW\s+(\d{6})", re.MULTILINE)
RE_PRES = re.compile(r"MINIMUM CENTRAL PRESSURE AT \d{6}Z IS (\d{3,4}) MB", re.IGNORECASE)

QUAD_KEYS = {"NORTHEAST": "ne", "SOUTHEAST": "se", "SOUTHWEST": "sw", "NORTHWEST": "nw"}


def parse_dtg(dtg: str, ref: datetime) -> datetime | None:
    """DDHHMM（UTC）→ datetime。日期與參考日相差超過半個月時視為跨月。"""
    try:
        day, hour, minute = int(dtg[0:2]), int(dtg[2:4]), int(dtg[4:6])
    except ValueError:
        return None
    ref = ref.astimezone(timezone.utc)
    year, month = ref.year, ref.month
    if day - ref.day > 15:
        month -= 1
    elif ref.day - day > 15:
        month += 1
    if month == 0:
        year, month = year - 1, 12
    elif month == 13:
        year, month = year + 1, 1
    try:
        return datetime(year, month, day, hour, minute, tzinfo=timezone.utc)
    except ValueError:
        return None


def _latlon(lat, ns, lon, ew):
    lat = float(lat) * (1 if ns.upper() == "N" else -1)
    lon = float(lon) * (1 if ew.upper() == "E" else -1)
    if lon < 0:
        lon += 360  # 跨換日線時維持連續經度
    return lat, lon


def _block_details(block: str) -> dict:
    out = {}
    m = RE_WIND.search(block)
    if m:
        out["vmax_kt"] = float(m.group(1))
        out["gust_kt"] = float(m.group(2)) if m.group(2) else None
    radii = {}
    for r in RE_RADII.finditer(block):
        quads = {QUAD_KEYS[q.group(2).upper()]: float(q.group(1)) for q in RE_QUAD.finditer(r.group(2))}
        if quads:
            radii[f"r{int(r.group(1))}"] = quads
    if radii:
        out["radii_nm"] = radii
    return out


def parse_warning(text: str, storm_id: str, ref: datetime) -> dict | None:
    title = RE_TITLE.search(text)
    if not title:
        return None
    level, number, name, warning_nr = title.groups()

    # 每個時刻一個區塊（以 "---" 分隔），逐塊解析
    points = []
    m = RE_WARN_POS.search(text)
    if not m:
        return None
    marks = [(0, m)] + [(int(f.group(1)), f) for f in RE_FCST.finditer(text)]
    for i, (tau, mm) in enumerate(marks):
        if tau == 0:
            dtg, lat, ns, lon, ew = mm.groups()
        else:
            _, dtg, lat, ns, lon, ew = mm.groups()
        end = marks[i + 1][1].start() if i + 1 < len(marks) else text.find("REMARKS:", mm.end())
        block = text[mm.end(): end if end > 0 else None]
        t = parse_dtg(dtg, ref)
        la, lo = _latlon(lat, ns, lon, ew)
        if t is None or not valid_position(la, lo):
            continue
        d = _block_details(block)
        points.append({
            "tau": tau,
            "time": iso_utc(t),
            "lat": la,
            "lon": lo,
            "vmax_kt": d.get("vmax_kt"),
            "vmax_ms": kt_to_ms(d.get("vmax_kt")),
            "gust_kt": d.get("gust_kt"),
            "pres_hpa": None,
            **({"radii_nm": d["radii_nm"]} if "radii_nm" in d else {}),
        })
    if not points:
        return None

    pres = RE_PRES.search(text)
    if pres:
        points[0]["pres_hpa"] = float(pres.group(1))
    header = RE_HEADER.search(text)
    issued = parse_dtg(header.group(1), ref) if header else None

    return {
        "agency": "jtwc",
        "id": storm_id,
        "number": number.upper(),
        "name_en": name.title(),
        "category": level.upper(),
        "warning_nr": int(warning_nr),
        "issued": iso_utc(issued) if issued else points[0]["time"],
        "wind_avg_min": 1,
        "past": [],
        "points": points,
    }


def fetch(now: datetime | None = None) -> list:
    now = now or datetime.now(timezone.utc)
    rss = get_text(RSS_URL)
    if "<rss" not in rss[:2000].lower() and "<channel" not in rss.lower():
        raise FetchError("JTWC RSS 格式異常")
    seen, storms, errors = set(), [], []
    for m in RE_WARNING_LINK.finditer(rss):
        url, sid = m.group(1), m.group(2).lower()
        if sid in seen:
            continue
        seen.add(sid)
        try:
            parsed = parse_warning(get_text(url), sid, now)
        except NotFound:
            continue
        except FetchError as e:
            errors.append(f"{sid}: {e}")
            continue
        if parsed:
            storms.append(parsed)
        else:
            errors.append(f"{sid}: 警報文字解析失敗")
    if errors and not storms:
        raise FetchError("; ".join(errors))
    return storms
