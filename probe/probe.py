"""暫時用的資料來源探測（不合併）：下載 AIFS 路徑檔樣本。"""
import urllib.request
from datetime import datetime, timedelta, timezone
now = datetime.now(timezone.utc)
for model, stream in (("aifs-single", "oper"), ("aifs-ens", "enfo")):
    t = now.replace(minute=0, second=0, microsecond=0); t -= timedelta(hours=t.hour % 6)
    for _ in range(6):
        url = f"https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/{t:%Y%m%d}/{t:%H}z/{model}/0p25/{stream}/{t:%Y%m%d%H}0000-360h-{stream}-tf.bufr"
        try:
            b = urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "typhoon-tracker/1.0"}), timeout=60).read()
            print(model, t, len(b)); open(f"probe/out/{model}_tf.bufr", "wb").write(b); break
        except Exception as e:
            print(model, t, e); t -= timedelta(hours=6)
