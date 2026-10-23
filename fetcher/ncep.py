"""NCEP GFS 與 GEFS 的颱風路徑（NOMADS 上的 ens_tracker 產品，ATCF 格式）。

  GFS ：.../ens_tracker/prod/gfs.{YYYYMMDD}/{HH}/tctrack/avno.t{HH}z.cyclone.trackatcfunix
  GEFS：.../ens_tracker/prod/gefs.{YYYYMMDD}/{HH}/tctrack/{aemn|ac00|ap01..ap30}.t{HH}z.cyclone.trackatcfunix

每天 00/06/12/18Z 四次，起報後約 5 小時（GFS）到 5.5 小時（GEFS）出現。
NOMADS 對 GitHub 的 HTTP/2 連線會回空白內容，urllib 走 HTTP/1.1 才正常（2026-10-23 實測）。
"""

from __future__ import annotations

from datetime import datetime, timedelta

from . import adeck
from .common import FetchError, NotFound, get_text, iso_utc

BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod"
GEFS_MEMBERS = ["ac00"] + [f"ap{i:02d}" for i in range(1, 31)]


def candidate_inits(now: datetime, count: int = 8):
    """最新的 6 小時起報時間往回數（NOMADS 只保留最近幾天）。"""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 6)
    for _ in range(count):
        yield t
        t -= timedelta(hours=6)


def track_url(model: str, init: datetime, member: str) -> str:
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    return f"{BASE}/{model}.{d}/{h}/tctrack/{member}.t{h}z.cyclone.trackatcfunix"


def _get(url: str) -> str:
    try:
        return get_text(url)
    except FetchError as e:
        # NOMADS 對還沒產出的目錄回 403 而不是 404（2026-10-23 實測）
        if str(e) == "HTTP 403":
            raise NotFound(str(e)) from None
        raise


def _latest(model: str, first_member: str, now: datetime, known_init: str | None):
    """找出最新一次已產出的起報；與 known_init 相同時回傳 None。"""
    for init in candidate_inits(now):
        if known_init == iso_utc(init):
            return None
        try:
            return init, _get(track_url(model, init, first_member))
        except NotFound:
            continue
    raise FetchError(f"NOMADS 找不到最近兩天的 {model.upper()} 路徑檔")


def fetch_gfs(now: datetime, known_init: str | None = None) -> dict | None:
    found = _latest("gfs", "avno", now, known_init)
    if found is None:
        return None
    init, text = found
    parsed = adeck.parse(text)
    storms = [{"id": sid, "name": None, "track": techs.get("AVNO") or next(iter(techs.values()))}
              for sid, techs in parsed["storms"].items()]
    return {"init": iso_utc(init), "storms": storms}


def fetch_gefs(now: datetime, known_init: str | None = None) -> dict | None:
    found = _latest("gefs", "aemn", now, known_init)
    if found is None:
        return None
    init, mean_text = found
    storms: dict[str, dict] = {}
    for sid, techs in adeck.parse(mean_text)["storms"].items():
        storms[sid] = {"id": sid, "name": None, "mean": techs.get("AEMN"), "members": []}
    for member in GEFS_MEMBERS:
        try:
            parsed = adeck.parse(_get(track_url("gefs", init, member)))
        except NotFound:  # 個別成員偶爾缺檔，略過即可
            continue
        for sid, techs in parsed["storms"].items():
            st = storms.setdefault(sid, {"id": sid, "name": None, "mean": None, "members": []})
            st["members"].extend(techs.values())
    return {"init": iso_utc(init), "storms": list(storms.values())}
