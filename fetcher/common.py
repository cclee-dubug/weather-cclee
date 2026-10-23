"""各來源共用的小工具：HTTP 抓取、數值轉換、名稱正規化。"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timezone

USER_AGENT = "typhoon-tracker/1.0 (+https://github.com; free non-commercial TC display)"
TIMEOUT = 30
MS_PER_KT = 0.514444


class FetchError(RuntimeError):
    """抓取或解析失敗。和「目前沒有颱風」是不同的狀態，不可混為一談。"""


class NotFound(FetchError):
    pass


def http_get(url: str, params: dict | None = None) -> bytes:
    if params:
        from urllib.parse import urlencode
        url = f"{url}?{urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(f"HTTP 404") from None
        raise FetchError(f"HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        # 不把完整 URL 放進錯誤訊息，避免 CWA 授權碼出現在公開的 log 裡
        raise FetchError(f"{type(e).__name__}: {getattr(e, 'reason', e)}") from None


def get_json(url: str, params: dict | None = None):
    raw = http_get(url, params)
    try:
        return json.loads(raw)
    except ValueError as e:
        raise FetchError(f"JSON 解析失敗：{e}") from None


def get_text(url: str) -> str:
    return http_get(url).decode("utf-8", errors="replace")


def to_float(v) -> float | None:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def kt_to_ms(kt: float | None) -> float | None:
    return None if kt is None else round(kt * MS_PER_KT, 1)


def ms_to_kt(ms: float | None) -> float | None:
    return None if ms is None else round(ms / MS_PER_KT)


def iso_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_iso(s) -> datetime | None:
    if not s:
        return None
    try:
        dt = datetime.fromisoformat(str(s).strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


_NUMBER_WORDS = re.compile(
    r"^(ONE|TWO|THREE|FOUR|FIVE|SIX|SEVEN|EIGHT|NINE|TEN|ELEVEN|TWELVE|THIRTEEN|FOURTEEN|"
    r"FIFTEEN|SIXTEEN|SEVENTEEN|EIGHTEEN|NINETEEN|TWENTY|THIRTY|FORTY|FIFTY|SIXTY|SEVENTY|"
    r"EIGHTY|NINETY)+$"
)


def normalize_name(name) -> str | None:
    """英文名稱轉成跨機構比對用的鍵。JTWC 未命名時用的數字名（TWENTYNINE）與 INVEST 視為沒有名字。"""
    if not name:
        return None
    key = re.sub(r"[^A-Z]", "", str(name).upper())
    if not key or key == "INVEST" or _NUMBER_WORDS.match(key):
        return None
    return key


def valid_position(lat, lon) -> bool:
    return lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 360
