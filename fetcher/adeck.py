"""ATCF 格式（a-deck／atcfunix）模式路徑解析。

一行一個預報時間點（同一時間點會因 34/50/64 kt 暴風半徑重複數行），欄位：
  BASIN, CY, YYYYMMDDHH, TECHNUM, TECH, TAU, LatN/S, LonE/W, VMAX(kt), MSLP(hPa), ...
緯經度以 0.1 度為單位，例如 238N、1234E。
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from .common import iso_utc

RE_LAT = re.compile(r"^(\d+)([NS])$")
RE_LON = re.compile(r"^(\d+)([EW])$")
# 颱風編號的英文字尾（JTWC 慣例）
SUFFIX = {"WP": "W", "EP": "E", "CP": "C", "AL": "L", "SH": "S", "IO": "A"}


def _coord(text: str, pattern: re.Pattern, neg: str) -> float | None:
    m = pattern.match(text.strip())
    if not m:
        return None
    v = int(m.group(1)) / 10
    return -v if m.group(2) == neg else v


def _int(text: str) -> int | None:
    try:
        v = int(text.strip())
    except ValueError:
        return None
    return v if v > 0 else None


def parse_dtg(dtg: str) -> datetime:
    return datetime.strptime(dtg.strip(), "%Y%m%d%H").replace(tzinfo=timezone.utc)


def parse(text: str, basin: str = "WP") -> dict:
    """取出指定海域最新一次起報的所有路徑。

    回傳 {"init": ISO 時間, "storms": {"29W": {tech: [[tau, lat, lon, vmax_kt, pres_hpa], ...]}}}；
    檔案裡有多次起報時只留最新一次，避免把不同時間的預報混在一起。
    """
    rows: dict[str, dict[str, dict[str, dict[int, list]]]] = {}
    for line in text.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 10 or f[0] != basin:
            continue
        try:
            tau = int(f[5])
        except ValueError:
            continue
        lat = _coord(f[6], RE_LAT, "S")
        lon = _coord(f[7], RE_LON, "W")
        if lat is None or lon is None:
            continue
        if lon < 0:
            lon += 360  # 跨過換日線時保持經度連續
        storm = f"{f[1]}{SUFFIX.get(basin, basin[0])}"  # 29W
        by_tau = rows.setdefault(f[2], {}).setdefault(storm, {}).setdefault(f[4], {})
        by_tau.setdefault(tau, [tau, lat, lon, _int(f[8]), _int(f[9])])
    if not rows:
        return {"init": None, "storms": {}}
    latest = max(rows)
    storms = {
        sid: {tech: [by_tau[k] for k in sorted(by_tau)] for tech, by_tau in techs.items()}
        for sid, techs in rows[latest].items()
    }
    return {"init": iso_utc(parse_dtg(latest)), "storms": storms}
