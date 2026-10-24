"""抓取各模式的颱風路徑，寫成 models.json。

模式分三類（網頁依此分組）：全球模式（global）、颶風模式（hurricane）、AI 模式（ai），
各自再分決定性（deterministic）與系集（ensemble）。完整清單見下方 MODELS。

用法：python -m fetcher.models 上一版.json 輸出.json

模式每天只更新 2 到 4 次，而且系集資料較大，所以和官方預報分開成另一個檔案，
由另一個 workflow 推到 model-data 分支（強制推送，git 不累積歷史）。
前幾次起報的路徑放在各模式的 previous（見 history.py），網頁用來比較預報的修正。
某個模式這次抓不到時，沿用上一版（48 小時內）並標示錯誤。
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from . import ecmwf, history, ncep, weatherlab
from .common import iso_utc, parse_iso

KEEP = timedelta(hours=48)
MEAN_MIN_SHARE = 0.5  # 系集平均只算到還有一半以上成員追得到颱風的時間


def _avg(values):
    v = [x for x in values if x is not None]
    return sum(v) / len(v) if v else None


def _round(v, nd=None):
    return None if v is None else round(v, nd)


def ensemble_mean(members: list[list]) -> list:
    by_tau: dict[int, list] = {}
    for track in members:
        for p in track:
            by_tau.setdefault(p[0], []).append(p)
    out = []
    for tau in sorted(by_tau):
        pts = by_tau[tau]
        if len(pts) < len(members) * MEAN_MIN_SHARE:
            break
        out.append([tau, _round(_avg(p[1] for p in pts), 1), _round(_avg(p[2] for p in pts), 1),
                    _round(_avg(p[3] for p in pts)), _round(_avg(p[4] for p in pts))])
    return out


def _ecmwf_det(model):
    def fetch(now, known_init):
        got = ecmwf.fetch("oper", now, known_init, model)
        if got is None:
            return None
        storms = [{"id": s["id"], "name": s["name"], "track": next(iter(s["members"].values()))} for s in got["storms"]]
        return {"init": got["init"], "storms": storms}
    return fetch


def _ecmwf_ens(model):
    def fetch(now, known_init):
        got = ecmwf.fetch("enfo", now, known_init, model)
        if got is None:
            return None
        storms = []
        for s in got["storms"]:
            members = list(s["members"].values())
            storms.append({"id": s["id"], "name": s["name"], "mean": ensemble_mean(members), "members": members})
        return {"init": got["init"], "storms": storms}
    return fetch


def _weatherlab(model):
    def fetch(now, known_init):
        got = weatherlab.fetch(model, now, known_init)
        if got is None:
            return None
        for s in got["storms"]:
            if not s["mean"]:
                s["mean"] = ensemble_mean(s["members"])
        return got
    return fetch


ecmwf_det = _ecmwf_det("ifs")
ecmwf_ens = _ecmwf_ens("ifs")


# Google Weather Lab 的資料要求附上的聲明（使用條款第 3、4 節）
NOTICES = {
    "wnv3,fnv3,genc": ("Copyright 2024-2026 Google LLC. Data from Google DeepMind Weather Lab. "
                       "Data relating to a time less than 1 hour ago or in the future is subject to the legally binding "
                       "terms of use at https://storage.googleapis.com/weathernext-public/terms-of-use.pdf ; "
                       "data relating to a time 1 hour or more in the past is licensed under CC BY 4.0. "
                       "Intended for experimental modelling only and not intended, validated, or approved for real world use. "
                       "Modified: reformatted (CSV to JSON), western North Pacific only, rounded to 0.1 degree."),
    "ifs,eps,aifs,aifse": "ECMWF open data, CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/).",
}


# 代號: (名稱, 類型, 分類, 系集成員數, 抓取函式)。順序就是網頁上的顯示順序
MODELS = {
    # 全球模式
    "gfs": ("NCEP GFS", "deterministic", "global", None, ncep.fetch_gfs),
    "ifs": ("ECMWF IFS", "deterministic", "global", None, ecmwf_det),
    "cmc": ("加拿大 GDPS", "deterministic", "global", None, ncep.fetch_cmc),
    "ngx": ("美國海軍 NAVGEM", "deterministic", "global", None, ncep.fetch_navgem),
    "gefs": ("NCEP GEFS", "ensemble", "global", 31, ncep.fetch_gefs),
    "eps": ("ECMWF EPS", "ensemble", "global", 51, ecmwf_ens),
    "cmce": ("加拿大 GEPS", "ensemble", "global", 21, ncep.fetch_cmce),
    "fens": ("美國海軍 FNMOC 系集", "ensemble", "global", 21, ncep.fetch_fens),
    # 颶風模式
    "hfsa": ("NOAA HAFS-A", "deterministic", "hurricane", None, ncep.fetch_hafs),
    # AI 模式
    "aifs": ("ECMWF AIFS", "deterministic", "ai", None, _ecmwf_det("aifs-single")),
    "aigfs": ("NOAA AIGFS", "deterministic", "ai", None, ncep.fetch_aigfs),
    "aifse": ("ECMWF AIFS 系集", "ensemble", "ai", 51, _ecmwf_ens("aifs-ens")),
    "aigefs": ("NOAA AIGEFS", "ensemble", "ai", 31, ncep.fetch_aigefs),
    "hgefs": ("NOAA HGEFS（GEFS＋AIGEFS 混合）", "ensemble", "ai", None, ncep.fetch_hgefs_mean),
    "wnv3": ("Google WeatherNext 3", "ensemble", "ai", 64, _weatherlab("WNV3")),
    "fnv3": ("Google FNV3", "ensemble", "ai", 50, _weatherlab("FNV3")),
    "genc": ("Google GenCast", "ensemble", "ai", 50, _weatherlab("GENC")),
}


def build(prev: dict, now: datetime, models=MODELS) -> dict:
    out = {"schema": 2, "checked_at": iso_utc(now), "notices": NOTICES, "models": {}}
    for code, (name, kind, category, size, fn) in models.items():
        old = (prev.get("models") or {}).get(code) or {}
        try:
            # 上一版正常時告訴抓取程式，最新一次已經有了就不必重新下載
            new = fn(now, old.get("init") if old.get("status") == "ok" else None)
        except Exception as e:  # noqa: BLE001 - 一個模式失敗不能影響其他模式
            msg = str(e) or type(e).__name__
            init = parse_iso(old.get("init"))
            if old.get("storms") is not None and init and now - init <= KEEP:
                entry = {**old, "status": "error", "message": f"更新失敗，沿用上次：{msg}"}
            else:
                entry = {"status": "error", "message": msg, "init": None, "storms": []}
        else:
            entry = old if new is None else {"status": "ok", **new}
        previous = history.model_history(old, entry.get("init"), now)
        if previous or "previous" in old:
            entry = {**entry, "previous": previous}
        meta = {"name": name, "kind": kind, "category": category, **({"size": size} if size else {})}
        out["models"][code] = {**meta, **{k: v for k, v in entry.items() if k not in meta}}
        m = out["models"][code]
        print(f"[{code}] {m['status']} {m.get('init')} {len(m.get('storms') or [])} 個系統 {m.get('message', '')}".rstrip())
    return out


def _content(d: dict) -> str:
    return json.dumps(d.get("models"), sort_keys=True, ensure_ascii=False)


def main(argv: list[str]) -> int:
    prev_path = Path(argv[1]) if len(argv) > 1 else Path("models.json")
    out_path = Path(argv[2]) if len(argv) > 2 else prev_path
    try:
        prev = json.loads(prev_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        prev = {}
    data = build(prev, datetime.now(timezone.utc))
    if prev and _content(prev) == _content(data):
        print("模式資料沒有變化，不更新檔案")
        return 0
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # 不縮排，系集資料才不會太大
    out_path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"已寫入 {out_path}（{out_path.stat().st_size // 1024} KB）")
    return 1 if all(m["status"] == "error" for m in data["models"].values()) else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
