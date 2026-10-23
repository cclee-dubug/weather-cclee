# 西北太平洋颱風即時追蹤

完全免費的颱風資訊網頁：整合各機構官方預報路徑與強度，以 GitHub Actions 定時抓取資料、GitHub Pages 發布，不需要伺服器。

## 資料來源

| 機構 | 資料 | 最大風速定義 |
|---|---|---|
| 日本氣象廳（JMA） | [防災情報 颱風資料](https://www.jma.go.jp/bosai/map.html#contents=typhoon) | 10 分鐘平均 |
| 交通部中央氣象署（CWA） | [氣象資料開放平臺 W-C0034-005](https://opendata.cwa.gov.tw/dataset/warning/W-C0034-005) | 10 分鐘平均 |
| 美軍聯合颱風警報中心（JTWC） | [JTWC 警報](https://www.metoc.navy.mil/jtwc/jtwc.html) | 1 分鐘平均 |

背景地圖使用 Esri 海洋與衛星圖磚；海表面溫度為 [NASA GIBS](https://www.earthdata.nasa.gov/gibs) 提供的 GHRSST MUR 每日分析（通常比今天晚 1 到 2 天）。衛星雲圖為[日本氣象廳](https://www.jma.go.jp/bosai/map.html#contents=himawari)向日葵衛星紅外線圖磚，網頁每 10 分鐘自動換成最新一張。

模式預報（側欄「模式預報」可個別開關）：

| 模式 | 類型 | 資料 | 更新 |
|---|---|---|---|
| NCEP GFS | 決定性 | [NOAA NOMADS](https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/) 颱風追蹤產品 | 每 6 小時 |
| NCEP GEFS | 系集（平均＋31 成員） | 同上 | 每 6 小時 |
| ECMWF IFS | 決定性 | [ECMWF 開放資料](https://www.ecmwf.int/en/forecasts/datasets/open-data)（CC BY 4.0）颱風路徑 BUFR | 每 12 小時（00Z／12Z） |
| ECMWF EPS | 系集（平均＋51 成員） | 同上 | 每 12 小時（00Z／12Z） |

各機構風速定義不同，同一個颱風 JTWC 的數值通常較高，不宜直接比較大小。本站資料僅供參考，防災決策請以中央氣象署發布的資訊為準。

## 運作方式

- `fetcher/`：Python 程式（只用標準函式庫），抓取三個來源並合併成 `data/latest.json`，並記錄 NASA GIBS 海表面溫度圖層的最新日期。
- `.github/workflows/fetch-data.yml`：每 30 分鐘執行一次，資料有變化時自動提交。
- 某個來源暫時抓不到時，沿用 24 小時內上一次的資料並標示狀態，不會讓網頁整個消失。
- `fetcher/models.py` 與 `.github/workflows/fetch-models.yml`：每小時檢查一次模式有沒有新的起報，有才更新。系集資料較大，所以存在獨立的 `model-data` 分支，每次強制推送只留最新一版，網頁從 `raw.githubusercontent.com` 讀取，repo 不會越來越大。解 ECMWF 的 BUFR 檔需要 `pip install eccodes`。

本機執行：

```bash
CWA_API_KEY=你的授權碼 python3 -m fetcher data/latest.json
pip install eccodes   # 只有模式資料需要
python3 -m fetcher.models data/models.json data/models.json
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
