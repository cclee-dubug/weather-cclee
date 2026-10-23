"""NASA GIBS 海表面溫度圖層（GHRSST MUR L4，每日、約 1 公里解析度）。

網頁直接向 GIBS 讀取圖磚，這裡只負責從 WMTS GetCapabilities 找出「最新可用日期」、
圖磚網址樣板與色標圖，寫進 latest.json，讓網頁不用自己下載數 MB 的 capabilities。

MUR 海溫通常比今天晚 1 到 2 天。
"""

from __future__ import annotations

import xml.etree.ElementTree as ET

from .common import FetchError, http_get

CAPS_URL = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml"
LAYER = "GHRSST_L4_MUR_Sea_Surface_Temperature"

NS = {
    "wmts": "http://www.opengis.net/wmts/1.0",
    "ows": "http://www.opengis.net/ows/1.1",
    "xlink": "http://www.w3.org/1999/xlink",
}


def _latest_date(dim: ET.Element) -> str | None:
    """Time 維度的 Value 形如 2002-06-01/2026-10-21/P1D，可能有多段；取所有段落最晚的結束日。"""
    ends = []
    for v in dim.findall("wmts:Value", NS):
        parts = (v.text or "").strip().split("/")
        if len(parts) >= 2:
            ends.append(parts[1][:10])
        elif parts and parts[0]:
            ends.append(parts[0][:10])
    if ends:
        return max(ends)
    default = dim.findtext("wmts:Default", default="", namespaces=NS).strip()
    return default[:10] or None


def parse_capabilities(xml_bytes: bytes, layer: str = LAYER) -> dict:
    try:
        root = ET.fromstring(xml_bytes)
    except ET.ParseError as e:
        raise FetchError(f"GIBS capabilities 解析失敗：{e}") from None
    for el in root.iter(f"{{{NS['wmts']}}}Layer"):
        if el.findtext("ows:Identifier", namespaces=NS) != layer:
            continue
        date = None
        for dim in el.findall("wmts:Dimension", NS):
            if (dim.findtext("ows:Identifier", namespaces=NS) or "").lower() == "time":
                date = _latest_date(dim)
        tms = el.findtext("wmts:TileMatrixSetLink/wmts:TileMatrixSet", namespaces=NS)
        template = None
        for r in el.findall("wmts:ResourceURL", NS):
            if r.get("resourceType") == "tile":
                template = r.get("template")
                break
        legend = None
        for lg in el.findall("wmts:Style/ows:LegendURL", NS) + el.findall("wmts:Style/wmts:LegendURL", NS):
            href = lg.get(f"{{{NS['xlink']}}}href")
            # 優先用橫式色標（檔名以 _H 結尾）
            if href and (legend is None or href.rsplit(".", 1)[0].endswith("_H")):
                legend = href
        if not (date and tms and template):
            raise FetchError(f"{layer} 缺少日期、TileMatrixSet 或網址樣板")
        max_zoom = None
        if tms.startswith("GoogleMapsCompatible_Level"):
            try:
                max_zoom = int(tms.rsplit("Level", 1)[1])
            except ValueError:
                pass
        return {
            "layer": layer,
            "date": date,
            "tile_matrix_set": tms,
            "max_zoom": max_zoom,
            "template": template,
            "legend": legend,
        }
    raise FetchError(f"GIBS capabilities 找不到圖層 {layer}")


def fetch() -> dict:
    return parse_capabilities(http_get(CAPS_URL))
