"""NCEP GFS 與 GEFS 的颱風路徑（NOMADS 上的 ens_tracker 產品，ATCF 格式）。

  GFS ：.../ens_tracker/prod/gfs.{YYYYMMDD}/{HH}/tctrack/avno.t{HH}z.cyclone.trackatcfunix
  GEFS：.../ens_tracker/prod/gefs.{YYYYMMDD}/{HH}/tctrack/{aemn|ac00|ap01..ap30}.t{HH}z.cyclone.trackatcfunix

每天 00/06/12/18Z 四次，起報後約 5 小時（GFS）到 5.5 小時（GEFS）出現。
NOMADS 對 GitHub 的 HTTP/2 連線會回空白內容，urllib 走 HTTP/1.1 才正常（2026-10-23 實測）。
"""

from __future__ import annotations

import re
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


def fetch_det(model: str, member: str, now: datetime, known_init: str | None = None) -> dict | None:
    """決定性模式（或只有平均路徑的產品）：一個檔案一條路徑。"""
    found = _latest(model, member, now, known_init)
    if found is None:
        return None
    init, text = found
    parsed = adeck.parse(text)
    storms = [{"id": sid, "name": None, "track": techs.get(member.upper()) or next(iter(techs.values()))}
              for sid, techs in parsed["storms"].items()]
    return {"init": iso_utc(init), "storms": storms}


def fetch_ens(model: str, mean: str, members: list[str], now: datetime, known_init: str | None = None) -> dict | None:
    """系集模式：平均路徑一個檔案，每個成員各一個檔案。"""
    found = _latest(model, mean, now, known_init)
    if found is None:
        return None
    init, mean_text = found
    storms: dict[str, dict] = {}
    for sid, techs in adeck.parse(mean_text)["storms"].items():
        storms[sid] = {"id": sid, "name": None, "mean": next(iter(techs.values())), "members": []}
    for member in members:
        try:
            parsed = adeck.parse(_get(track_url(model, init, member)))
        except NotFound:  # 個別成員偶爾缺檔，略過即可
            continue
        for sid, techs in parsed["storms"].items():
            st = storms.setdefault(sid, {"id": sid, "name": None, "mean": None, "members": []})
            st["members"].extend(techs.values())
    return {"init": iso_utc(init), "storms": list(storms.values())}


def fetch_gfs(now: datetime, known_init: str | None = None) -> dict | None:
    return fetch_det("gfs", "avno", now, known_init)


def fetch_gefs(now: datetime, known_init: str | None = None) -> dict | None:
    return fetch_ens("gefs", "aemn", GEFS_MEMBERS, now, known_init)


# 其他放在 ens_tracker 的模式（2026-10-24 在 GitHub Actions 上確認檔名）：
#   cmce  ：加拿大 GDPS（cmc）與 GEPS 系集（cemn 平均、cc00 控制組、cp01..cp20），00／12Z
#   fens  ：美國海軍 NAVGEM（ngx）與 FNMOC 系集（nemn、nc00、np01..np20），00／12Z
#   aigfs ：NOAA AI GFS（agfs）
#   aigefs：NOAA AI GEFS（aimn 平均、a000..a030）
#   hgefs ：NOAA 混合系集 HGEFS（GEFS＋AIGEFS），只有平均（ahmn）
CMCE_MEMBERS = ["cc00"] + [f"cp{i:02d}" for i in range(1, 21)]
FENS_MEMBERS = ["nc00"] + [f"np{i:02d}" for i in range(1, 21)]
AIGEFS_MEMBERS = [f"a{i:03d}" for i in range(31)]


def fetch_cmc(now, known_init=None):
    return fetch_det("cmce", "cmc", now, known_init)


def fetch_cmce(now, known_init=None):
    return fetch_ens("cmce", "cemn", CMCE_MEMBERS, now, known_init)


def fetch_navgem(now, known_init=None):
    return fetch_det("fens", "ngx", now, known_init)


def fetch_fens(now, known_init=None):
    return fetch_ens("fens", "nemn", FENS_MEMBERS, now, known_init)


def fetch_aigfs(now, known_init=None):
    return fetch_det("aigfs", "agfs", now, known_init)


def fetch_aigefs(now, known_init=None):
    return fetch_ens("aigefs", "aimn", AIGEFS_MEMBERS, now, known_init)


def fetch_hgefs_mean(now, known_init=None):
    """HGEFS 只公開平均路徑，當成沒有成員的系集。"""
    got = fetch_det("hgefs", "ahmn", now, known_init)
    if got is None:
        return None
    return {"init": got["init"], "storms": [{"id": s["id"], "name": None, "mean": s["track"], "members": []}
                                            for s in got["storms"]]}


# HAFS-A 颶風模式：每個颱風一個目錄下的檔案 {29w}.{YYYYMMDDHH}.hfsa.trak.atcfunix。
# 颱風的檔案在起報後幾個小時陸續出現，所以不靠 known_init 跳過，每次都重新列出最新的目錄（只有幾 KB）
HAFS_BASE = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/hafs/prod"
RE_HAFS = re.compile(r'href="(\d\d[wW])\.(\d{10})\.hfsa\.trak\.atcfunix"')
RE_HAFS_ANY = re.compile(r'\.hfsa\.trak\.atcfunix"')


def fetch_hafs(now: datetime, known_init: str | None = None) -> dict | None:
    for init in candidate_inits(now):
        d, h = init.strftime("%Y%m%d"), init.strftime("%H")
        try:
            listing = _get(f"{HAFS_BASE}/hfsa.{d}/{h}/")
        except NotFound:
            continue
        if not RE_HAFS_ANY.search(listing):
            continue  # 這次起報還沒有任何路徑檔
        storms = []
        for sid, dtg in sorted(set(RE_HAFS.findall(listing))):
            try:
                parsed = adeck.parse(_get(f"{HAFS_BASE}/hfsa.{d}/{h}/{sid}.{dtg}.hfsa.trak.atcfunix"))
            except NotFound:
                continue
            for psid, techs in parsed["storms"].items():
                storms.append({"id": psid, "name": None, "track": techs.get("HFSA") or next(iter(techs.values()))})
        return {"init": iso_utc(init), "storms": storms}
    raise FetchError("NOMADS 找不到最近兩天的 HAFS-A 路徑檔")
