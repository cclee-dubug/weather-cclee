"""ECMWF 開放資料的熱帶氣旋路徑（BUFR，tf 檔）。

  https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/{YYYYMMDD}/{HH}z/ifs/0p25/{oper|enfo}/
      {YYYYMMDD}{HH}0000-{step}h-{oper|enfo}-tf.bufr

oper 是決定性模式（IFS），enfo 是系集（EPS，51 個成員）。AI 模式 AIFS 的路徑檔格式相同，放在
.../{HH}z/aifs-single/0p25/oper/（決定性）與 .../{HH}z/aifs-ens/0p25/enfo/（系集），每 6 小時一次、
都到 360 小時（2026-10-24 在 GitHub Actions 上確認）。每則 BUFR 訊息是一個颱風，
系集的 51 個成員是同一則訊息裡的 51 個 subset。解碼需要 eccodes（pip install eccodes），
只有這個模組用到，其他來源仍只用標準函式庫。

位置欄位的編號（ecCodes 範例 bufr_read_tropical_cyclone）：
  #2#latitude 是分析場的颱風中心；第 i 個預報時段的中心在 #(2i+2)#latitude，
  中心氣壓 #(i+1)#pressureReducedToMeanSeaLevel（Pa），近中心最大風速 #(i+1)#windSpeedAt10M（m/s）。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from .common import FetchError, NotFound, http_get, iso_utc

BASE = "https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com"
STEPS = {"oper": ("360h", "240h"), "enfo": ("360h",)}
MISSING = -1e99  # eccodes 以 -1e100 表示缺值
MS_PER_KT = 0.514444


def url(stream: str, init: datetime, step: str, model: str = "ifs") -> str:
    d, h = init.strftime("%Y%m%d"), init.strftime("%H")
    return f"{BASE}/{d}/{h}z/{model}/0p25/{stream}/{d}{h}0000-{step}-{stream}-tf.bufr"


def candidate_inits(now: datetime, count: int = 4, cycle: int = 12):
    """最新的起報時間往回數。IFS 只用 00Z／12Z（06Z／18Z 的路徑檔只到 144 小時），AIFS 每 6 小時。"""
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % cycle)
    for _ in range(count):
        yield t
        t -= timedelta(hours=cycle)


def _arr(codes, h, key):
    try:
        return list(codes.codes_get_array(h, key))
    except Exception:  # noqa: BLE001 - 這個時段沒有資料
        return None


def _val(values, i):
    """BUFR 陣列可能只有一個值（所有成員共用），也可能每個成員一個值。"""
    if not values:
        return None
    v = values[i] if len(values) > 1 else values[0]
    return None if v is None or v < MISSING else float(v)


def decode(data: bytes) -> list[dict]:
    """解出所有颱風：[{"id", "name", "init", "members": {成員編號: [[tau, lat, lon, vmax_kt, pres_hpa], ...]}}]"""
    import eccodes as codes  # 只在需要時載入

    storms = []
    pos = 0
    while True:
        start = data.find(b"BUFR", pos)
        if start < 0:
            break
        h = codes.codes_new_from_message(data[start:])
        pos = start + codes.codes_get(h, "totalLength")
        try:
            codes.codes_set(h, "unpack", 1)
            init = datetime(*(int(codes.codes_get(h, k)) for k in ("year", "month", "day", "hour")),
                            tzinfo=timezone.utc)
            sid = (codes.codes_get(h, "stormIdentifier") or "").strip()
            name = (codes.codes_get(h, "longStormName") or "").strip()
            n_sub = int(codes.codes_get(h, "numberOfSubsets"))
            members = _arr(codes, h, "ensembleMemberNumber") or [0]
            # 時段 0 是分析場，之後每個時段一筆
            steps = [(0, _arr(codes, h, "#2#latitude"), _arr(codes, h, "#2#longitude"),
                      _arr(codes, h, "#1#pressureReducedToMeanSeaLevel"), _arr(codes, h, "#1#windSpeedAt10M"))]
            i = 1
            while True:
                tp = _arr(codes, h, f"#{i}#timePeriod")
                if tp is None:
                    break
                steps.append((tp, _arr(codes, h, f"#{2 * i + 2}#latitude"), _arr(codes, h, f"#{2 * i + 2}#longitude"),
                              _arr(codes, h, f"#{i + 1}#pressureReducedToMeanSeaLevel"),
                              _arr(codes, h, f"#{i + 1}#windSpeedAt10M")))
                i += 1
        finally:
            codes.codes_release(h)

        tracks = {}
        for s in range(n_sub):
            member = int(_val(members, s) or 0)
            pts = []
            for tp, lat, lon, pres, wind in steps:
                tau = tp if isinstance(tp, int) else _val(tp, s)
                la, lo = _val(lat, s), _val(lon, s)
                if tau is None or la is None or lo is None:
                    continue
                p, w = _val(pres, s), _val(wind, s)
                pts.append([int(tau), round(la, 1), round(lo % 360, 1),
                            None if w is None else round(w / MS_PER_KT),
                            None if p is None else round(p / 100)])
            if pts:
                tracks[member] = pts
        if tracks:
            storms.append({"id": sid, "name": name, "init": iso_utc(init), "members": tracks})
    return storms


def in_wpac(points) -> bool:
    """以第一個位置判斷是否在西北太平洋（赤道到 60°N、100°E 到 180°）。"""
    lat, lon = points[0][1], points[0][2]
    return 0 <= lat <= 60 and 100 <= lon <= 185


def official(storm: dict) -> bool:
    """編號 70 以上是 ECMWF 自己偵測到的系統（可能與已編號颱風重複，或只是可能生成的擾動），不採用。"""
    num = storm["id"][:2]
    return not (num.isdigit() and int(num) >= 70)


def _download(u: str, tries: int = 3) -> bytes:
    """S3 偶爾回 503 SlowDown，稍等再試；找不到檔案（還沒產出）直接拋 NotFound。"""
    for i in range(tries):
        try:
            return http_get(u)
        except NotFound:
            raise
        except FetchError as e:
            if str(e) == "HTTP 403":  # S3 對不存在的檔案有時回 403
                raise NotFound(str(e)) from None
            if i == tries - 1:
                raise
            time.sleep(5 * 2 ** i)
    raise FetchError("unreachable")


def fetch(stream: str, now: datetime, known_init: str | None = None, model: str = "ifs") -> dict | None:
    """抓最新一次起報的路徑，只留西北太平洋。最新一次就是 known_init 時回傳 None（不必重抓）。"""
    last_error = None
    ai = model != "ifs"
    for init in candidate_inits(now, 8 if ai else 4, 6 if ai else 12):
        if known_init == iso_utc(init):
            return None
        for step in ("360h",) if ai else STEPS[stream]:
            try:
                data = _download(url(stream, init, step, model))
            except NotFound:
                continue
            except FetchError as e:
                # 新一次起報上傳期間，S3 對那個目錄常持續回 503，先改抓前一次（已經有就沿用），下次再試
                last_error = e
                break
            storms = [s for s in decode(data) if official(s) and in_wpac(next(iter(s["members"].values())))]
            return {"init": iso_utc(init), "storms": storms}
    raise last_error or FetchError("找不到最近兩天的 ECMWF 路徑檔")
