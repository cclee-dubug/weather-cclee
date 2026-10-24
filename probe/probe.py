"""暫時用的資料來源探測（不合併）：下載樣本檔存到 probe/out。"""
import re, urllib.request, os
from datetime import datetime, timedelta, timezone
UA = "typhoon-tracker/1.0"
os.makedirs("probe/out", exist_ok=True)
def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:
        return str(e), b""
now = datetime.now(timezone.utc)
print("== ECMWF S3 listing")
for d in ((now).strftime("%Y%m%d"), (now - timedelta(days=1)).strftime("%Y%m%d")):
    for hh in ("00", "06", "12", "18"):
        for path in ("aifs-single/0p25/oper/", "aifs-ens/0p25/enfo/", "ifs/0p25/oper/"):
            st, b = get(f"https://ecmwf-forecasts.s3.eu-central-1.amazonaws.com/?list-type=2&prefix={d}/{hh}z/{path}")
            keys = re.findall(r"<Key>([^<]+)</Key>", b.decode())
            print(d, hh, path, st, len(keys), [k for k in keys if "bufr" in k or "tf" in k.rsplit("-", 1)[-1]])
NOM = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod"
d = now.strftime("%Y%m%d")
def latest(model, member):
    t = now.replace(minute=0, second=0, microsecond=0); t -= timedelta(hours=t.hour % 6)
    for _ in range(8):
        url = f"{NOM}/{model}.{t:%Y%m%d}/{t:%H}/tctrack/{member}.t{t:%H}z.cyclone.trackatcfunix"
        st, b = get(url)
        if st == 200 and b:
            return t, b
        t -= timedelta(hours=6)
    return None, b""
for model, members in (("aigfs", ["agfs", "agfsp"]), ("aigefs", ["aimn", "a000", "a001", "a000p"]), ("hgefs", ["ahmn"]),
                       ("cmce", ["cmc", "cemn", "cc00", "cp01"]), ("fens", ["ngx", "nemn", "nc00", "np01"]), ("gfs", ["avnop", "avnx"])):
    for m in members:
        t, b = latest(model, m)
        wp = [l for l in b.decode().splitlines() if l.startswith("WP")]
        print(model, m, t, len(b), len(wp), wp[:2])
        open(f"probe/out/{model}_{m}.atcfunix", "wb").write(b)
print("== HAFS")
t = now.replace(minute=0, second=0, microsecond=0); t -= timedelta(hours=t.hour % 6)
for _ in range(6):
    st, b = get(f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/hafs/prod/hfsa.{t:%Y%m%d}/{t:%H}/")
    files = sorted(set(re.findall(r'href="([^"]+trak\.atcfunix)"', b.decode())))
    if files:
        print(t, files)
        for f in files:
            if "w." in f:
                st, b2 = get(f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/hafs/prod/hfsa.{t:%Y%m%d}/{t:%H}/{f}")
                print(f, st, len(b2), b2.decode().splitlines()[:2])
                open(f"probe/out/hfsa_{f}", "wb").write(b2)
        break
    t -= timedelta(hours=6)
print("== Weather Lab ensembles")
WL = "https://deepmind.google.com/science/weatherlab/download/cyclones"
t = now.replace(minute=0, second=0, microsecond=0); t -= timedelta(hours=t.hour % 6)
for model in ("WNV3", "OPER", "FNV3P2", "FNV3", "GENC", "FNV3_LARGE_ENSEMBLE"):
    for prod in ("ensemble_mean", "ensemble"):
        tt = t
        for _ in range(6):
            st, b = get(f"{WL}/{model}/{prod}/paired/csv/{model}_{tt:%Y_%m_%dT%H_00}_paired.csv")
            if st == 200: break
            tt -= timedelta(hours=6)
        lines = b.decode().splitlines()
        ids = sorted(set(l.split(",")[1] for l in lines if l[:1].isdigit()))
        samples = sorted(set(int(l.split(",")[2]) for l in lines if l[:1].isdigit()))
        print(model, prod, tt, st, len(b), ids, samples[:3], samples[-3:])
        if prod == "ensemble_mean" or model in ("WNV3", "GENC"):
            keep = [l for l in lines if not l[:1].isdigit() or ",WP" in l]
            open(f"probe/out/wl_{model}_{prod}.csv", "w").write("\n".join(keep) + "\n")
