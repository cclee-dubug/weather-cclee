"""把 NASA GIBS 的色標檔（ColorMap v1.3 XML）轉成網頁用的 assets/colormaps.json。

GIBS 的海溫與紅外線圖磚是依色標上色的 PNG，色標檔列出每個顏色代表的數值區間。
網頁讀回圖磚像素、用這份對照表還原成數值，再用自己的色階重新上色。
色標很少變動，所以產生一次後存進 repo；GIBS 改版色標時再重跑：

  python3 tools/gibs_colormap.py > assets/colormaps.json
  python3 tools/gibs_colormap.py sst.xml ir.xml > assets/colormaps.json   # 用已下載的檔案
"""

from __future__ import annotations

import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fetcher.common import http_get  # noqa: E402

BASE = "https://gibs.earthdata.nasa.gov/colormaps/v1.3"
# 名稱 → GIBS 色標檔（海溫：GHRSST MUR；紅外線：向日葵 Band 13）
SOURCES = {
    "sst": f"{BASE}/GHRSST_Sea_Surface_Temperature.xml",
    "ir": f"{BASE}/Clean_Longwave_Infrared_Window_Band.xml",
}
RE_RANGE = re.compile(r"^[\[(]\s*([^,]+?)\s*,\s*([^\])]+?)\s*[\])]$")


def _bound(text: str) -> float | None:
    return None if "INF" in text.upper() else float(text)


def entries(xml_bytes: bytes) -> list[list[float]]:
    """回傳 [[r, g, b, 數值], ...]；數值取區間中點，開放區間（如 ≥ 32）取有限端往外 0.1。"""
    out = []
    for e in ET.fromstring(xml_bytes).iter():
        if not e.tag.endswith("ColorMapEntry") or e.get("nodata") == "true" or e.get("transparent") == "true":
            continue
        m = RE_RANGE.match(e.get("value") or "")
        if not m:
            continue
        lo, hi = _bound(m.group(1)), _bound(m.group(2))
        if lo is None and hi is None:
            continue
        v = (lo + hi) / 2 if lo is not None and hi is not None else (hi - 0.1 if lo is None else lo + 0.1)
        r, g, b = (int(x) for x in e.get("rgb").split(","))
        out.append([r, g, b, round(v, 3)])
    return out


def main(paths: list[str]) -> None:
    result = {}
    for i, (name, url) in enumerate(SOURCES.items()):
        data = Path(paths[i]).read_bytes() if i < len(paths) else http_get(url)
        result[name] = {"source": url, "entries": entries(data)}
    json.dump(result, sys.stdout, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main(sys.argv[1:])
