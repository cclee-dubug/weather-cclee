"""tools/gibs_colormap.py：GIBS 色標檔轉換成網頁用的對照表。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tools import gibs_colormap  # noqa: E402

XML = b"""<?xml version="1.0" encoding="UTF-8"?>
<ColorMaps>
  <ColorMap title="Sea Surface Temperature" units="&#176;C">
    <Entries>
      <ColorMapEntry rgb="0,0,0" transparent="true" nodata="true" ref="0"/>
      <ColorMapEntry rgb="43,0,26" transparent="false" sourceValue="[-INF,0.00)" value="[-INF,0.00)" ref="1"/>
      <ColorMapEntry rgb="45,0,28" transparent="false" sourceValue="[0.00,0.15)" value="[0.00,0.15)" ref="2"/>
      <ColorMapEntry rgb="107,2,0" transparent="false" sourceValue="[32.00,+INF)" value="[32.00,+INF)" ref="3"/>
    </Entries>
  </ColorMap>
  <ColorMap title="Infrared">
    <Entries>
      <ColorMapEntry rgb="255,255,255" transparent="false" value="(-92.1,-91.1]" ref="4"/>
      <ColorMapEntry rgb="1,1,1" transparent="false" value="(56.9,+INF)" ref="5"/>
    </Entries>
  </ColorMap>
</ColorMaps>
"""


class TestGibsColormap(unittest.TestCase):
    def test_entries(self):
        self.assertEqual(gibs_colormap.entries(XML), [
            [43, 0, 26, -0.1],          # 開放區間取有限端往外 0.1
            [45, 0, 28, 0.075],         # 區間中點
            [107, 2, 0, 32.1],
            [255, 255, 255, -91.6],
            [1, 1, 1, 57.0],
        ])

    def test_repo_table_is_complete(self):
        import json
        maps = json.loads((Path(__file__).resolve().parents[1] / "assets" / "colormaps.json").read_text())
        for name in ("sst", "ir"):
            rgbs = [tuple(e[:3]) for e in maps[name]["entries"]]
            self.assertGreater(len(rgbs), 100)
            self.assertEqual(len(rgbs), len(set(rgbs)), f"{name} 色標的顏色必須一對一")


if __name__ == "__main__":
    unittest.main()
