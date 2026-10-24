# 西北太平洋颱風即時追蹤

完全免費的颱風資訊網頁：整合各機構官方預報路徑與強度，以 GitHub Actions 定時抓取資料、GitHub Pages 發布，不需要伺服器。

## 資料來源

| 機構 | 資料 | 最大風速定義 |
|---|---|---|
| 日本氣象廳（JMA） | [防災情報 颱風資料](https://www.jma.go.jp/bosai/map.html#contents=typhoon) | 10 分鐘平均 |
| 交通部中央氣象署（CWA） | [氣象資料開放平臺 W-C0034-005](https://opendata.cwa.gov.tw/dataset/warning/W-C0034-005) | 10 分鐘平均 |
| 美軍聯合颱風警報中心（JTWC） | [JTWC 警報](https://www.metoc.navy.mil/jtwc/jtwc.html) | 1 分鐘平均 |

背景地圖使用 Esri 海洋與衛星圖磚。地圖圖層：

- **海表面溫度**：[NASA GIBS](https://www.earthdata.nasa.gov/gibs) 的 GHRSST MUR 每日分析（通常比今天晚 1 到 2 天），在網頁上重新上色，26 °C 以上由黃轉橘、紅、粉紅。
- **衛星雲圖**：[日本氣象廳](https://www.jma.go.jp/bosai/map.html#contents=himawari)向日葵衛星紅外線圖磚，每 10 分鐘換成最新一張。
- **BD 強化雲圖**：NASA GIBS 的向日葵 Band 13 紅外線（約晚 30 分鐘），還原成雲頂溫度後套用 Dvorak 分析用的 BD 色階。日本氣象廳的圖磚在 -70 °C 左右就全白，分不出 BD 色階最重要的 -70～-80 °C，所以這張改用 GIBS。
- **系集路徑密度**：GEFS 或 EPS 各成員颱風中心通過某地 120 公里內的比例（與 ECMWF 侵襲機率的定義相同），在網頁上由成員路徑計算。

GIBS 圖磚是依色標上色的 PNG，網頁讀回像素、用 `assets/colormaps.json` 對照表還原數值後再上色。對照表由 `tools/gibs_colormap.py` 從 GIBS 色標檔產生，GIBS 改版色標時重跑即可。

模式預報（側欄「模式預報」可個別開關）：

| 模式 | 類型 | 資料 | 更新 |
|---|---|---|---|
| NCEP GFS | 決定性 | [NOAA NOMADS](https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/) 颱風追蹤產品 | 每 6 小時 |
| NCEP GEFS | 系集（平均＋31 成員） | 同上 | 每 6 小時 |
| ECMWF IFS | 決定性 | [ECMWF 開放資料](https://www.ecmwf.int/en/forecasts/datasets/open-data)（CC BY 4.0）颱風路徑 BUFR | 每 12 小時（00Z／12Z） |
| ECMWF EPS | 系集（平均＋51 成員） | 同上 | 每 12 小時（00Z／12Z） |

**模式天氣圖**（`model.html`）：以各模式自己預報的颱風位置為中心，畫出 0 到 120 小時每 6 小時一張的天氣圖，GFS 與 IFS 依有效時間並排比較。目前有：

- **200–850 hPa 環境垂直風切（去除渦旋）**：GFS 從 [NOMADS grib filter](https://nomads.ncep.noaa.gov/gribfilter.php?ds=gfs_0p25) 只下載 850～200 hPa 八層的 u、v；IFS 從 ECMWF 開放資料依 `.index` 以 HTTP Range 只下載這些場。颱風中心 500 公里內的渦度與輻散用 Green 函數反推風場後扣除（Davis et al. 2008 的方法，`fetcher/vortex.py`），剩下的環境風場再相減；另算 500 公里內的平均風切（與 SHIPS 的 SHDC 定義相同）。
- **深層駛流（去除渦旋）**：400–850、300–850、200–850 hPa 三種。850、700、600、500、400、300、250、200 hPa 各層分別去除渦旋後，依氣壓加權（梯形積分）平均；圖上紅色箭頭是 500 公里內平均駛流移動 24 小時的距離。

各機構風速定義不同，同一個颱風 JTWC 的數值通常較高，不宜直接比較大小。本站資料僅供參考，防災決策請以中央氣象署發布的資訊為準。

## 運作方式

- `fetcher/`：Python 程式（只用標準函式庫），抓取三個來源並合併成 `data/latest.json`，並記錄 NASA GIBS 海表面溫度圖層的最新日期。
- `.github/workflows/fetch-data.yml`：每 30 分鐘執行一次，資料有變化時自動提交。
- 某個來源暫時抓不到時，沿用 24 小時內上一次的資料並標示狀態，不會讓網頁整個消失。
- `fetcher/models.py` 與 `.github/workflows/fetch-models.yml`：每小時檢查一次模式有沒有新的起報，有才更新。系集資料較大，所以存在獨立的 `model-data` 分支，每次強制推送只留最新一版，網頁從 `raw.githubusercontent.com` 讀取，repo 不會越來越大。解 ECMWF 的 BUFR 檔需要 `pip install eccodes`。
- `fetcher/maps.py`：同一個 workflow 接著畫模式天氣圖（需要 numpy、matplotlib、eccodes），只在 GFS／IFS 有新的起報時重畫，圖片與 `index.json` 強制推送到 `model-maps` 分支，一樣只留最新一版。海岸線取自 Natural Earth 1:50m（公有領域），只留西北太平洋範圍存成 `fetcher/coast_wpac.json`。

本機執行：

```bash
CWA_API_KEY=你的授權碼 python3 -m fetcher data/latest.json
pip install eccodes numpy matplotlib   # 只有模式資料與天氣圖需要
python3 -m fetcher.models data/models.json data/models.json
python3 -m fetcher.maps data/models.json maps   # 圖片輸出到 maps/
python3 -m unittest discover -s tests
```

## 設定步驟

1. **CWA 授權碼**：到 [氣象資料開放平臺](https://opendata.cwa.gov.tw/) 註冊會員，在會員頁取得 API 授權碼。
   接著在這個 repo 的 **Settings → Secrets and variables → Actions → New repository secret** 新增，名稱填 `CWA_API_KEY`，值填授權碼。
2. **啟用 GitHub Pages**：**Settings → Pages**，Source 選 **Deploy from a branch**，Branch 選 `main`、資料夾 `/ (root)`。
3. **第一次執行**：**Actions → 更新颱風資料 → Run workflow**，之後就會自動每 30 分鐘更新。

## 注意事項

- GitHub 的排程可能延遲 5 到 20 分鐘，資料約為半小時到一小時內的最新版本。
- 公開 repo 連續 60 天沒有任何提交時，GitHub 會自動停用排程。程式在資料沒變時也會每 6 小時更新一次檢查時間，避免被停用；若仍被停用，到 Actions 頁面重新啟用即可。
