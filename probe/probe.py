"""暫時用的資料來源探測（不合併）。"""
import re, sys, urllib.request, json
from datetime import datetime, timedelta, timezone

UA = "typhoon-tracker/1.0"
def get(url, n=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if n: req.add_header("Range", f"bytes=0-{n}")
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, b""
    except Exception as e:
        return str(e), b""

def links(url):
    st, b = get(url)
    t = b.decode("utf-8", "replace")
    names = re.findall(r'href="([^"?/][^"]*)"', t)
    return st, names

now = datetime.now(timezone.utc)
day = now.strftime("%Y%m%d"); yday = (now - timedelta(days=1)).strftime("%Y%m%d")

def section(t): print(f"\n===== {t}", flush=True)

section("NOMADS ens_tracker/prod")
st, n = links("https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/")
print(st, sorted(set(x.split(".")[0] for x in n)), n[-12:])
for model in ("aigfs", "aigefs", "hgefs", "gfs", "gefs", "cmce", "fens", "naefs", "ecme", "cens"):
    for d in (day, yday):
        st, n = links(f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/{model}.{d}/")
        if st == 200:
            print(model, d, "cycles", n)
            cyc = sorted(x.strip("/") for x in n if re.fullmatch(r"\d\d/?", x))
            if cyc:
                st2, n2 = links(f"https://nomads.ncep.noaa.gov/pub/data/nccf/com/ens_tracker/prod/{model}.{d}/{cyc[-1]}/tctrack/")
                print("  ", cyc[-1], st2, len(n2), [x for x in n2 if "atcfunix" in x][:80])
            break
    else:
        print(model, "none")

section("NOMADS hafs/prod")
for base in ("https://nomads.ncep.noaa.gov/pub/data/nccf/com/hafs/prod/",):
    st, n = links(base)
    print(st, n[-15:])
    for x in n[-6:]:
        st2, n2 = links(base + x)
        print(" ", x, st2, n2[:20])
        for y in n2[-2:]:
            st3, n3 = links(base + x + y)
            print("    ", y, st3, [z for z in n3 if "atcf" in z or "trak" in z][:20], n3[:10])

section("ECMWF open data AIFS")
for d in (day, yday):
    for hh in ("00", "06", "12", "18"):
        for path in ("aifs-single/0p25/oper/", "aifs-ens/0p25/enfo/", "ifs/0p25/oper/", "ifs/0p25/enfo/"):
            st, n = links(f"https://data.ecmwf.int/forecasts/{d}/{hh}z/{path}")
            tf = [x for x in n if "tf" in x.split("-")[-1] or x.endswith(".bufr")]
            print(d, hh, path, st, len(n), tf[:5])
    break

section("UCAR adecks_open")
st, n = links("https://hurricanes.ral.ucar.edu/repository/data/adecks_open/2026/")
wp = sorted(x for x in n if x.lower().startswith("awp"))
print(st, wp[-10:])
for f in wp[-3:]:
    st, b = get("https://hurricanes.ral.ucar.edu/repository/data/adecks_open/2026/" + f)
    lines = b.decode("utf-8", "replace").splitlines()
    techs = {}
    for ln in lines:
        p = [x.strip() for x in ln.split(",")]
        if len(p) > 5: techs.setdefault(p[4], set()).add(p[2])
    latest = max((max(v) for v in techs.values()), default="")
    print(f, st, len(lines), "latest", latest)
    print("  techs at latest/prev cycles:", sorted(k for k, v in techs.items() if max(v) >= latest[:8]))

section("Google Weather Lab")
for model in ("WNV3", "OPER", "FNV3P2", "FNV3", "GENC", "GENCAST"):
    t = now.replace(minute=0, second=0, microsecond=0)
    t -= timedelta(hours=t.hour % 6)
    for i in range(8):
        stamp = t.strftime("%Y_%m_%dT%H_00")
        url = f"https://deepmind.google.com/science/weatherlab/download/cyclones/{model}/ensemble_mean/paired/csv/{model}_{stamp}_paired.csv"
        st, b = get(url)
        if st == 200:
            txt = b.decode("utf-8", "replace")
            print(model, stamp, len(b)); print("\n".join(txt.splitlines()[:14]))
            ids = sorted(set(l.split(",")[0] for l in txt.splitlines() if l and not l.startswith("#")))
            print("track ids", ids[:30])
            break
        t -= timedelta(hours=6)
    else:
        print(model, "not found", st)
