"""抓取 JMA、CWA、JTWC 的颱風預報與海溫圖層資訊，寫入 data/latest.json。

用法：python -m fetcher [輸出路徑]

某個來源暫時抓不到時，沿用上一次該來源的資料（24 小時內），並在 sources 標示錯誤，
避免網頁因單次連線失敗而整個消失。
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import cwa, gibs, jma, jtwc
from .common import FetchError, iso_utc, parse_iso
from .merge import group_storms

SOURCES = {
    "jma": ("日本氣象廳", jma.fetch),
    "cwa": ("中央氣象署", cwa.fetch),
    "jtwc": ("美軍聯合颱風警報中心", jtwc.fetch),
}
STALE_LIMIT = timedelta(hours=24)
# 內容沒變時，至少每隔這麼久重寫一次檔案，讓「最後檢查時間」不會太舊，
# 也讓 repo 持續有提交，避免 GitHub 停用排程
HEARTBEAT = timedelta(hours=6)
# 海溫每天只更新一次，capabilities 又有數 MB，不必每 30 分鐘重抓
SST_REFRESH = timedelta(hours=3)


def _previous_agency_storms(prev: dict, agency: str, now: datetime) -> list:
    out = []
    for storm in prev.get("storms", []):
        a = storm.get("agencies", {}).get(agency)
        issued = parse_iso(a.get("issued")) if a else None
        if a and issued and now - issued <= STALE_LIMIT:
            out.append({**a, "agency": agency, "stale": True})
    return out


def build_sst(prev: dict, now: datetime) -> dict:
    old = (prev.get("layers") or {}).get("sst") or {}
    checked = parse_iso(old.get("checked_at"))
    if old.get("status") == "ok" and checked and now - checked < SST_REFRESH:
        return old
    try:
        sst = {"status": "ok", **gibs.fetch()}
    except Exception as e:  # 海溫只是背景圖層，失敗不影響颱風資料
        if old.get("status") == "ok":
            return {**old, "message": f"更新失敗，沿用上次：{e}"}
        return {"status": "error", "message": str(e)}
    sst["checked_at"] = iso_utc(now)
    print(f"[sst] {sst['date']}")
    return sst


def build(prev: dict, now: datetime) -> dict:
    collected, sources = [], {}
    for code, (name, fn) in SOURCES.items():
        try:
            storms = fn()
            collected.extend({**s, "agency": code} for s in storms)
            sources[code] = {"name": name, "status": "ok" if storms else "no_storm", "count": len(storms)}
        except FetchError as e:
            reused = _previous_agency_storms(prev, code, now)
            collected.extend(reused)
            sources[code] = {"name": name, "status": "error", "message": str(e), "count": len(reused)}
        except Exception as e:  # 解析程式本身的錯誤也不能讓其他來源跟著失敗
            reused = _previous_agency_storms(prev, code, now)
            collected.extend(reused)
            sources[code] = {"name": name, "status": "error",
                             "message": f"{type(e).__name__}: {e}", "count": len(reused)}
        print(f"[{code}] {sources[code]['status']} {sources[code].get('message', '')}".rstrip())
    return {
        "schema": 1,
        "checked_at": iso_utc(now),
        "sources": sources,
        "storms": group_storms(collected),
        "layers": {"sst": build_sst(prev, now)},
    }


def _content(d: dict) -> str:
    sst = {k: v for k, v in ((d.get("layers") or {}).get("sst") or {}).items() if k != "checked_at"}
    return json.dumps({"sources": d.get("sources"), "storms": d.get("storms"), "sst": sst},
                      sort_keys=True, ensure_ascii=False)


def main(argv: list[str]) -> int:
    out_path = Path(argv[1] if len(argv) > 1 else "data/latest.json")
    try:
        prev = json.loads(out_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    now = datetime.now(timezone.utc)
    data = build(prev, now)

    unchanged = prev and _content(prev) == _content(data)
    last_written = parse_iso(prev.get("checked_at")) if prev else None
    if unchanged and last_written and now - last_written < HEARTBEAT:
        print("內容沒有變化，不更新檔案")
        return 0
    data["updated_at"] = prev.get("updated_at") if unchanged else iso_utc(now)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(f"已寫入 {out_path}：{len(data['storms'])} 顆颱風")
    # 三個來源全部失敗時以非零結束，讓 GitHub 寄通知信
    return 1 if all(s["status"] == "error" for s in data["sources"].values()) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
