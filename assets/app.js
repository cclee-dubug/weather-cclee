/* 西北太平洋颱風追蹤：讀取 data/latest.json，畫出各機構路徑與強度。 */
(() => {
  "use strict";

  const DATA_URL = "data/latest.json";
  const REFRESH_MS = 10 * 60 * 1000;
  const MS_PER_KT = 0.514444;

  // 顏色之外再用形狀區分機構，色覺辨識困難時也能分辨
  const AGENCIES = {
    cwa: { name: "中央氣象署", short: "CWA", shape: "circle", avg: "10 分鐘平均" },
    jma: { name: "日本氣象廳", short: "JMA", shape: "square", avg: "10 分鐘平均" },
    jtwc: { name: "JTWC", short: "JTWC", shape: "diamond", avg: "1 分鐘平均" },
  };
  const AGENCY_ORDER = ["cwa", "jma", "jtwc"];
  const STATUS_TEXT = { ok: "正常", no_storm: "無颱風", error: "連線失敗" };

  // 模式路徑另存在 model-data 分支（每小時更新、不保留歷史），從 GitHub 原始檔網址讀取
  const MODELS_URL = "https://raw.githubusercontent.com/cclee-dubug/weather-cclee/model-data/models.json";
  // 同一家的決定性與系集用同一個顏色，以線型與地圖上的文字標籤區分
  const MODELS = {
    gfs: { name: "NCEP GFS", short: "GFS", family: "ncep", kind: "deterministic" },
    ifs: { name: "ECMWF IFS", short: "IFS", family: "ecmwf", kind: "deterministic" },
    gefs: { name: "NCEP GEFS", short: "GEFS", family: "ncep", kind: "ensemble" },
    eps: { name: "ECMWF EPS", short: "EPS", family: "ecmwf", kind: "ensemble" },
  };
  const MODEL_GROUPS = [["決定性模式", ["gfs", "ifs"]], ["系集模式", ["gefs", "eps"]]];
  // 系集成員數（GEFS：控制組＋30 個擾動成員；EPS：控制組＋50），沒追到這個颱風的成員也算在分母
  const ENSEMBLE_SIZE = { gefs: 31, eps: 51 };

  const state = {
    data: null,
    selected: null,
    unit: "kt",
    enabled: new Set(AGENCY_ORDER),
    showPast: true,
    showCone: false,
    models: null,
    modelsFailed: false,
    modelOn: new Set(["gfs", "ifs"]),
    density: "off", // 系集路徑密度：off、gefs、eps
  };

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = (agency) => css(`--agency-${agency}`);

  const fmtTime = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const fmt = (iso) => (iso ? fmtTime.format(new Date(iso)) : "—");

  function wind(kt, ms) {
    if (state.unit === "ms") {
      const v = ms ?? (kt != null ? kt * MS_PER_KT : null);
      return v == null ? null : Math.round(v);
    }
    return kt == null ? null : Math.round(kt);
  }
  const unitText = () => (state.unit === "ms" ? "m/s" : "kt");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function stormTitle(s) {
    if (s.name_zh && s.name_en) return `${s.name_zh} ${s.name_en}`;
    if (s.name_en) return s.name_en;
    const n = s.numbers || {};
    if (n.jtwc) return `熱帶性低氣壓 ${n.jtwc}`;
    // JMA 對未命名的熱帶性低氣壓用英文字母編號（例如 b）
    return n.jma ? `熱帶性低氣壓 ${n.jma}` : "熱帶性低氣壓";
  }
  function stormIds(s) {
    const n = s.numbers || {};
    const parts = [];
    if (n.jma && /^\d{4}$/.test(n.jma)) parts.push(`JMA ${n.jma}`);
    if (n.jtwc) parts.push(`JTWC ${n.jtwc}`);
    return parts.join(" · ");
  }

  /* ---------- 地圖 ---------- */

  const map = L.map("map", { worldCopyJump: false, zoomSnap: 0.5, minZoom: 3, maxZoom: 10 }).setView([22, 135], 4);

  // 背景地圖：Esri 免費圖磚，不需金鑰。使用者選過的會記在瀏覽器
  const esri = (service, sources) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, {
    attribution: `Tiles &copy; <a href="https://www.esri.com/">Esri</a>${sources ? ` &mdash; ${sources}` : ""}`,
  });
  // 圖層順序（由下到上）：背景圖磚 200 → 海溫 300 → 衛星雲圖 320 → BD 強化雲圖 325 → 海岸線 330
  // → 路徑密度 340 → 路徑 400 → 地名標註 450。各自放在獨立的 pane，切換背景時新加入的圖磚才不會蓋住其他圖層
  for (const [name, z] of [["sst", 300], ["clouds", 320], ["bd", 325], ["coast", 330], ["density", 340], ["labels", 450]]) {
    map.createPane(name);
    map.getPane(name).style.zIndex = z;
    map.getPane(name).style.pointerEvents = "none";
  }
  // 紅外線雲圖是灰階（雲白、晴空暗），用「濾色」混合讓暗的晴空區變透明，只留下雲
  map.getPane("clouds").style.mixBlendMode = "screen";
  const esriLabels = (service) => L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/${service}/MapServer/tile/{z}/{y}/{x}`, { pane: "labels" });
  const BASEMAPS = {
    ocean: ["海洋與地形", L.layerGroup([
      esri("Ocean/World_Ocean_Base", "Esri, Garmin, GEBCO, NOAA NGDC, and other contributors"),
      esriLabels("Ocean/World_Ocean_Reference"),
    ])],
    satellite: ["衛星影像", L.layerGroup([
      esri("World_Imagery", "Source: Esri, Vantor, Earthstar Geographics, and the GIS User Community"),
      esriLabels("Reference/World_Boundaries_and_Places"),
    ])],
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 無痕模式等情況忽略 */ } },
  };
  const savedBase = store.get("tc-basemap");
  (BASEMAPS[savedBase] || BASEMAPS.ocean)[1].addTo(map);

  // 海表面溫度：NASA GIBS 的 GHRSST MUR 每日海溫圖磚，日期與網址樣板由 data/latest.json 提供；
  // 在瀏覽器裡依 GIBS 色標還原溫度後改用自己的色階（26 °C 以上分得較細）
  const sstGroup = L.layerGroup();
  let sstInfo = null;
  let sstTiles = null;
  const SST_NAME = "海表面溫度";

  // 衛星雲圖：日本氣象廳向日葵衛星紅外線（B13）全圓盤圖磚，每 10 分鐘一張，原生最大縮放 5
  const HIMAWARI = "https://www.jma.go.jp/bosai/himawari/data/satimg";
  const CLOUD_NAME = "衛星雲圖";
  const cloudGroup = L.layerGroup();
  let cloudTiles = null;
  let cloudTime = null; // 最新一張的觀測時間（UTC，YYYYMMDDHHMMSS）
  let cloudStatus = "loading";

  // BD 強化雲圖：NASA GIBS 的向日葵 Band 13 紅外線（每 10 分鐘，約晚 30 分鐘上線，原生最大縮放 6），
  // 日本氣象廳的圖磚在 -70 °C 左右就全白，分不出 BD 色階最重要的 -70～-80 °C，所以改用 GIBS
  const GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best";
  const BD_NAME = "BD 強化雲圖";
  const bdGroup = L.layerGroup();
  let bdTiles = null;
  let bdTime = null; // ISO 時間
  let bdStatus = "loading";
  // 系集路徑密度（圖層在選取颱風後產生）
  let densityLayer = null;
  let densityKey = null;
  let densityInfo = null; // { code, init, members }，給圖例用

  // BD 雲圖是不透明的灰階，另外疊上海岸線
  const coastTiles = L.tileLayer(`${GIBS}/Coastlines_15m/default/default/GoogleMapsCompatible_Level13/{z}/{y}/{x}.png`, {
    pane: "coast", bounds: [[-85, -180], [85, 180]],
  });

  L.control.layers(
    Object.fromEntries(Object.values(BASEMAPS)), { [SST_NAME]: sstGroup, [CLOUD_NAME]: cloudGroup, [BD_NAME]: bdGroup },
    { position: "topright", collapsed: false },
  ).addTo(map);
  if (store.get("tc-sst") !== "off") sstGroup.addTo(map);
  if (store.get("tc-bd") === "on") {
    bdGroup.addTo(map);
    coastTiles.addTo(map);
  } else if (store.get("tc-cloud") !== "off") {
    cloudGroup.addTo(map);
  }

  map.on("baselayerchange", (e) => {
    store.set("tc-basemap", Object.keys(BASEMAPS).find((k) => BASEMAPS[k][1] === e.layer));
  });
  map.on("overlayadd overlayremove", (e) => {
    const on = e.type === "overlayadd" ? "on" : "off";
    if (e.layer === sstGroup) store.set("tc-sst", on);
    // 兩種雲圖擇一顯示：BD 雲圖不透明，同時開會把另一張蓋住。
    // 等圖層控制項處理完這次點擊再關另一張，否則控制項會依舊的勾選狀態把它加回來
    if (e.layer === cloudGroup) {
      store.set("tc-cloud", on);
      if (on === "on") {
        setTimeout(() => map.removeLayer(bdGroup));
        refreshClouds();
      }
    }
    if (e.layer === bdGroup) {
      store.set("tc-bd", on);
      if (on === "on") {
        setTimeout(() => map.removeLayer(cloudGroup));
        coastTiles.addTo(map);
        refreshBd();
      } else {
        map.removeLayer(coastTiles);
      }
    }
    renderLegend();
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

  const layerLegend = L.control({ position: "bottomleft" });
  layerLegend.onAdd = () => {
    const div = L.DomUtil.create("div", "layer-legend");
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  layerLegend.addTo(map);

  // 換成新的圖層：新圖層的圖磚載完後才移除舊的，避免畫面閃一下空白
  function swapLayer(group, old, next) {
    group.addLayer(next);
    if (!old) return;
    let removed = false;
    const drop = () => { if (!removed) { removed = true; group.removeLayer(old); } };
    next.once("load", drop);
    setTimeout(drop, 15000);
  }

  function updateSst(info) {
    if (!info || info.status !== "ok" || !info.template || !info.date) {
      sstInfo = null;
      sstGroup.clearLayers();
      sstTiles = null;
      renderLegend();
      return;
    }
    const url = info.template
      .replace("{Time}", info.date)
      .replace("{TileMatrixSet}", info.tile_matrix_set)
      .replace("{TileMatrix}", "{z}")
      .replace("{TileRow}", "{y}")
      .replace("{TileCol}", "{x}");
    if (sstTiles?.options.url !== url) {
      const next = TcRaster.sstLayer(url, {
        pane: "sst",
        opacity: 0.7,
        maxNativeZoom: info.max_zoom || 7,
        bounds: [[-85, -180], [85, 180]],
        attribution: '海溫：<a href="https://www.earthdata.nasa.gov/gibs">NASA GIBS</a> / JPL MUR',
      });
      swapLayer(sstGroup, sstTiles, next);
      sstTiles = next;
    }
    sstInfo = info;
    renderLegend();
  }

  const pad2 = (n) => String(n).padStart(2, "0");
  const himawariStamp = (ms) => {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}${pad2(d.getUTCMonth() + 1)}${pad2(d.getUTCDate())}${pad2(d.getUTCHours())}${pad2(d.getUTCMinutes())}00`;
  };
  const stampToIso = (t) => `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}T${t.slice(8, 10)}:${t.slice(10, 12)}:00Z`;
  const cloudUrl = (t) => `${HIMAWARI}/${t}/fd/${t}/B13/TBB/{z}/{x}/{y}.jpg`;
  const imageExists = (src) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = src;
  });

  async function latestCloudTime() {
    try {
      const res = await fetch(`${HIMAWARI}/targetTimes_fd.json`, { cache: "no-store" });
      const t = (await res.json()).at(-1)?.basetime;
      if (/^\d{14}$/.test(t)) return t;
    } catch (_) { /* 瀏覽器可能因跨網域限制讀不到時間清單，改用下面的方式 */ }
    // 從 10 分鐘前往回找，第一張存在的圖就是最新的（每天 02:40、14:40 UTC 沒有全圓盤觀測）
    let ms = Math.floor((Date.now() - 10 * 60e3) / 600e3) * 600e3;
    for (let i = 0; i < 12; i++, ms -= 600e3) {
      const t = himawariStamp(ms);
      if (await imageExists(cloudUrl(t).replace("{z}/{x}/{y}", "3/6/3"))) return t;
    }
    return null;
  }

  let cloudBusy = false;
  async function refreshClouds() {
    if (!map.hasLayer(cloudGroup) || cloudBusy) return;
    cloudBusy = true;
    const t = await latestCloudTime();
    cloudBusy = false;
    // 這次查不到但已有上一張時，繼續顯示上一張
    cloudStatus = t || cloudTime ? "ok" : "error";
    if (t && t !== cloudTime) {
      cloudTime = t;
      if (cloudTiles) {
        cloudTiles.setUrl(cloudUrl(t));
      } else {
        cloudTiles = L.tileLayer(cloudUrl(t), {
          pane: "clouds",
          maxNativeZoom: 5,
          // 向日葵位於東經 140.7 度上空，全圓盤以外沒有圖磚
          bounds: [[-80, 60], [80, 222]],
          attribution: '雲圖：<a href="https://www.jma.go.jp/bosai/map.html#contents=himawari">日本氣象廳</a>',
        });
        cloudGroup.addLayer(cloudTiles);
      }
    }
    renderLegend();
  }

  // GIBS 的最新觀測時間：請求時間填 default 會回最新一張，並在回應標頭寫出實際時間
  const BD_LAYER = "Himawari_AHI_Band13_Clean_Infrared";
  const bdUrl = (t) => `${GIBS}/${BD_LAYER}/default/${t}/GoogleMapsCompatible_Level6/{z}/{y}/{x}.png`;
  async function latestBdTime() {
    try {
      const res = await fetch(bdUrl("default").replace("{z}/{y}/{x}", "0/0/0"), { cache: "no-store" });
      const t = res.ok && res.headers.get("layer-time-actual");
      if (t && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t)) return t;
    } catch (_) { /* 網路錯誤時沿用上一張 */ }
    return null;
  }

  let bdBusy = false;
  async function refreshBd() {
    if (!map.hasLayer(bdGroup) || bdBusy) return;
    bdBusy = true;
    const t = await latestBdTime();
    bdBusy = false;
    bdStatus = t || bdTime ? "ok" : "error";
    if (t && t !== bdTime) {
      bdTime = t;
      const next = TcRaster.bdLayer(bdUrl(t), {
        pane: "bd",
        maxNativeZoom: 6,
        bounds: [[-80, 60], [80, 222]],
        attribution: '雲圖：<a href="https://www.earthdata.nasa.gov/gibs">NASA GIBS</a> / JMA Himawari',
      });
      swapLayer(bdGroup, bdTiles, next);
      bdTiles = next;
    }
    renderLegend();
  }

  function renderLegend() {
    const div = layerLegend.getContainer();
    const parts = [];
    if (densityInfo) {
      const meta = MODELS[densityInfo.code];
      parts.push(`<div><b>路徑密度</b> <span class="muted">${meta.short}，${fmt(densityInfo.init)} 起報</span></div>` +
        TcRaster.densityLegendHtml(meta.family) +
        `<div class="muted">${densityInfo.members} 個成員中，颱風中心通過該處 ${TcRaster.DENSITY_RADIUS_KM} 公里內的比例（整個預報期間）</div>`);
    }
    if (map.hasLayer(cloudGroup)) {
      const when = { loading: "載入中…", error: "目前無法取得雲圖" }[cloudStatus] ??
        `${fmt(stampToIso(cloudTime))} 觀測`;
      parts.push(`<div><b>${CLOUD_NAME}</b> <span class="muted">${when}</span></div>` +
        `<div class="muted">日本氣象廳向日葵衛星紅外線，越白代表雲頂越高越冷</div>`);
    }
    if (map.hasLayer(bdGroup)) {
      const when = { loading: "載入中…", error: "目前無法取得雲圖" }[bdStatus] ?? `${fmt(bdTime)} 觀測`;
      parts.push(`<div><b>${BD_NAME}</b> <span class="muted">${when}</span></div>` + TcRaster.bdLegendHtml() +
        `<div class="muted">向日葵衛星紅外線雲頂溫度（°C），以 Dvorak 分析用的 BD 色階分段，越冷代表對流越強</div>`);
    }
    if (map.hasLayer(sstGroup)) {
      if (!sstInfo) {
        parts.push(`<div><b>${SST_NAME}</b> <span class="muted">目前無法取得海溫資料</span></div>`);
      } else {
        const [y, m, d] = sstInfo.date.split("-");
        parts.push(`<div><b>${SST_NAME}</b> <span class="muted">${Number(m)}/${Number(d)}（${y}）日分析，°C</span></div>` +
          TcRaster.sstLegendHtml() +
          `<div class="muted">黃色以上（26 °C 以上）有利颱風發展或維持強度</div>`);
      }
    }
    div.hidden = !parts.length;
    div.innerHTML = parts.join('<hr>');
  }

  const layer = L.layerGroup().addTo(map);

  function shapeSvg(shape, fill, size, ring) {
    const s = size, h = s / 2, r = h - 2;
    const ringColor = css("--surface");
    let path;
    if (shape === "square") path = `<rect x="2" y="2" width="${s - 4}" height="${s - 4}" rx="1.5"/>`;
    else if (shape === "diamond") path = `<polygon points="${h},1 ${s - 1},${h} ${h},${s - 1} 1,${h}"/>`;
    else path = `<circle cx="${h}" cy="${h}" r="${r}"/>`;
    return `<svg width="${s}" height="${s}" viewBox="0 0 ${s} ${s}" xmlns="http://www.w3.org/2000/svg">` +
      `<g fill="${fill}" stroke="${ringColor}" stroke-width="${ring}">${path}</g></svg>`;
  }
  function shapeIcon(agency, size) {
    return L.divIcon({
      className: "tc-marker",
      html: shapeSvg(AGENCIES[agency].shape, color(agency), size, 2),
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
  }
  // 熱帶氣旋符號，標示目前位置
  function tcIcon(fill) {
    const svg = `<svg width="26" height="26" viewBox="-13 -13 26 26" xmlns="http://www.w3.org/2000/svg">
      <g fill="none" stroke="${fill}" stroke-width="2.4" stroke-linecap="round">
        <path d="M0,-5 A5,5 0 0,1 5,0 C5,6 -1,10 -8,10"/><path d="M0,5 A5,5 0 0,1 -5,0 C-5,-6 1,-10 8,-10"/>
      </g><circle r="3.2" fill="${fill}" stroke="${css("--surface")}" stroke-width="1.5"/></svg>`;
    return L.divIcon({ className: "tc-marker", html: svg, iconSize: [26, 26], iconAnchor: [13, 13] });
  }

  function pointTip(agency, a, p) {
    const meta = AGENCIES[agency];
    const w = wind(p.vmax_kt, p.vmax_ms);
    const g = wind(p.gust_kt, null);
    const rows = [
      `<b>${esc(meta.name)}</b> ${p.tau === 0 ? "目前位置" : `+${p.tau} 小時`}`,
      `${fmt(p.time)}　${p.lat.toFixed(1)}°N ${p.lon.toFixed(1)}°E`,
      w != null ? `最大風速 <b>${w} ${unitText()}</b>${g != null ? `，陣風 ${g} ${unitText()}` : ""} <span class="muted">（${meta.avg}）</span>` : "",
      p.category === "LOW" ? "預測減弱為低氣壓" : "",
      p.pres_hpa != null ? `中心氣壓 ${p.pres_hpa} hPa` : "",
      p.r70_km ? `70% 機率圈半徑 ${p.r70_km} km` : "",
      p.r_gale_km ? `七級風暴風半徑 ${p.r_gale_km} km` : "",
    ];
    return rows.filter(Boolean).join("<br>");
  }

  function drawStorm(storm, selected) {
    const bounds = [];
    for (const agency of AGENCY_ORDER) {
      const a = storm.agencies[agency];
      if (!a || !state.enabled.has(agency) || !a.points?.length) continue;
      const c = color(agency);
      const fade = selected ? 1 : 0.35;
      const pts = a.points.map((p) => [p.lat, p.lon]);
      bounds.push(...pts);

      if (state.showPast && a.past?.length) {
        const past = a.past.map((p) => [p.lat, p.lon]).concat([pts[0]]);
        L.polyline(past, { color: c, weight: 2, opacity: 0.55 * fade, interactive: false }).addTo(layer);
        bounds.push(...past);
      }
      if (state.showCone && selected) {
        for (const p of a.points) {
          if (p.r70_km) {
            L.circle([p.lat, p.lon], {
              radius: p.r70_km * 1000, color: c, weight: 1, opacity: 0.5, fillColor: c, fillOpacity: 0.06, interactive: false,
            }).addTo(layer);
          }
        }
      }
      L.polyline(pts, { color: c, weight: 2.5, opacity: 0.9 * fade, dashArray: "6 5", interactive: false }).addTo(layer);

      let lastDay = fmt(a.points[0].time).split(" ")[0];
      a.points.forEach((p, i) => {
        if (i === 0) return;
        const m = L.marker([p.lat, p.lon], { icon: shapeIcon(agency, selected ? 12 : 9), opacity: fade, keyboard: false })
          .bindTooltip(pointTip(agency, a, p), { className: "tc-tip", direction: "top", offset: [0, -6] })
          .addTo(layer);
        if (selected) m.on("click", () => m.openTooltip());
        // 選取的颱風在每天第一個預報點標上日期，只標第一個顯示中的機構以免重疊
        const day = fmt(p.time).split(" ")[0];
        if (selected && day !== lastDay && agency === firstEnabled(storm)) {
          L.tooltip({ permanent: true, direction: "right", offset: [8, 0], className: "tau-label" })
            .setLatLng([p.lat, p.lon]).setContent(day).addTo(layer);
        }
        lastDay = day;
      });
    }
    // 目前位置用主要機構（中央氣象署優先）
    const main = firstEnabled(storm);
    if (main) {
      const a = storm.agencies[main];
      const p0 = a.points[0];
      L.marker([p0.lat, p0.lon], { icon: tcIcon(selected ? css("--critical") : css("--muted")), zIndexOffset: 1000 })
        .bindTooltip(`<b>${esc(stormTitle(storm))}</b><br>` + pointTip(main, a, p0), { className: "tc-tip", direction: "top", offset: [0, -10] })
        .on("click", () => select(storm.key))
        .addTo(layer);
    }
    return bounds;
  }
  /* ---------- 模式路徑 ---------- */

  const modelColor = (code) => css(`--model-${MODELS[code].family}`);
  const DEG = Math.PI / 180;
  function distKm(lat1, lon1, lat2, lon2) {
    const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2 +
      Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
    return 12742 * Math.asin(Math.sqrt(a));
  }
  // 官方資料中，時間最接近 t 的颱風位置（預報點與中央氣象署的過去路徑都有時間）
  function stormPosAt(storm, t) {
    let best = null;
    for (const k of AGENCY_ORDER) {
      const a = storm.agencies[k];
      if (!a) continue;
      for (const p of [...(a.past || []), ...(a.points || [])]) {
        if (!p.time) continue;
        const dt = Math.abs(Date.parse(p.time) - t);
        if (!best || dt < best.dt) best = { dt, lat: p.lat, lon: p.lon };
      }
    }
    return best;
  }
  const modelRef = (ms) => ms.track?.[0] || ms.mean?.[0] || ms.members?.find((m) => m.length)?.[0];
  // 模式裡的系統與網頁上的颱風對應：英文名相同，或起報時的位置夠近（颱風移動約每小時 20 公里）
  function matchModelStorm(code, storm) {
    const m = state.models?.models?.[code];
    if (!m?.storms?.length || !m.init) return null;
    const init = Date.parse(m.init);
    const name = (storm.name_en || "").toUpperCase();
    let best = null;
    for (const ms of m.storms) {
      if (name && ms.name && ms.name.toUpperCase() === name) return ms;
      const ref = modelRef(ms);
      if (!ref) continue;
      const pos = stormPosAt(storm, init + ref[0] * 3600e3);
      if (!pos) continue;
      const d = distKm(pos.lat, pos.lon, ref[1], ref[2]);
      const limit = Math.min(800, 300 + 20 * pos.dt / 3600e3);
      if (d <= limit && (!best || d < best.d)) best = { d, ms };
    }
    return best?.ms ?? null;
  }

  function modelTip(code, init, p, label) {
    const w = wind(p[3], null);
    return [
      `<b>${esc(label)}</b> +${p[0]} 小時`,
      `${fmt(new Date(Date.parse(init) + p[0] * 3600e3).toISOString())}　${p[1].toFixed(1)}°N ${p[2].toFixed(1)}°E`,
      p[4] != null ? `中心氣壓 ${p[4]} hPa` : "",
      w != null ? `近中心最大風速 ${w} ${unitText()} <span class="muted">（模式輸出）</span>` : "",
      `<span class="muted">${fmt(init)} 起報</span>`,
    ].filter(Boolean).join("<br>");
  }

  function drawModelLine(code, init, pts, label, dashed) {
    if (pts.length < 2) return;
    const c = modelColor(code);
    const ll = pts.map((p) => [p[1], p[2]]);
    // 底下墊一條背景色的寬線，疊在衛星雲圖或海溫上也看得清楚
    L.polyline(ll, { color: css("--surface"), weight: 5.5, opacity: 0.75, interactive: false }).addTo(layer);
    L.polyline(ll, { color: c, weight: 3, opacity: 0.95, interactive: false, lineCap: "round", ...(dashed ? { dashArray: "1 7" } : {}) }).addTo(layer);
    for (const p of pts) {
      if (p[0] === 0 || p[0] % 24) continue;
      L.circleMarker([p[1], p[2]], { radius: 3.5, color: css("--surface"), weight: 1.5, fillColor: c, fillOpacity: 1 })
        .bindTooltip(modelTip(code, init, p, label), { className: "tc-tip", direction: "top", offset: [0, -4] })
        .addTo(layer);
    }
    const last = pts[pts.length - 1];
    L.tooltip({ permanent: true, direction: "right", offset: [6, 0], className: "model-label" })
      .setLatLng([last[1], last[2]]).setContent(`<span style="color:${c}">${esc(label)}</span>`).addTo(layer);
  }

  function drawModels(storm) {
    for (const code of ["gefs", "eps", "gfs", "ifs"]) {  // 系集先畫，決定性模式疊在上面
      if (!state.modelOn.has(code)) continue;
      const ms = matchModelStorm(code, storm);
      if (!ms) continue;
      const init = state.models.models[code].init;
      const meta = MODELS[code];
      if (meta.kind === "deterministic") {
        drawModelLine(code, init, ms.track || [], meta.short, false);
        continue;
      }
      const c = modelColor(code);
      for (const m of ms.members || []) {
        if (m.length < 2) continue;
        L.polyline(m.map((p) => [p[1], p[2]]), { color: c, weight: 1, opacity: 0.4, interactive: false }).addTo(layer);
      }
      if (ms.mean?.length) drawModelLine(code, init, ms.mean, `${meta.short} 平均`, true);
    }
  }

  // 路徑密度圖層只在颱風、模式或起報時間改變時重算
  function drawDensity(storm) {
    const code = state.density;
    const ms = storm && MODELS[code] ? matchModelStorm(code, storm) : null;
    const init = ms ? state.models.models[code].init : null;
    const key = ms ? `${code}|${init}|${ms.id}` : null;
    if (key !== densityKey) {
      if (densityLayer) map.removeLayer(densityLayer);
      densityLayer = null;
      densityKey = key;
      densityInfo = null;
      const grid = ms && TcRaster.trackDensity(ms.members || [], ENSEMBLE_SIZE[code]);
      if (grid) {
        densityLayer = new TcRaster.DensityLayer({ pane: "density", grid, family: MODELS[code].family }).addTo(map);
        densityInfo = { code, init, members: grid.members };
      }
    }
    renderLegend();
  }

  // 列表排序用：目前強度，10 分鐘平均的機構優先，沒有才用 JTWC
  function intensity(storm) {
    for (const k of ["cwa", "jma", "jtwc"]) {
      const v = storm.agencies[k]?.points?.[0]?.vmax_kt;
      if (v != null) return v;
    }
    return 0;
  }
  function firstEnabled(storm) {
    return AGENCY_ORDER.find((k) => state.enabled.has(k) && storm.agencies[k]?.points?.length);
  }

  /* ---------- 側欄 ---------- */

  function renderStatus() {
    const d = state.data;
    const el = $("status");
    if (!d) { el.textContent = "資料載入失敗，稍後自動重試"; return; }
    const parts = [`<span>最後檢查 ${fmt(d.checked_at)}</span>`];
    for (const k of AGENCY_ORDER) {
      const s = d.sources?.[k];
      if (!s) continue;
      const extra = s.status === "error" && s.count ? "（沿用上次資料）" : "";
      parts.push(`<span class="src" title="${esc(s.message || "")}"><span class="dot ${s.status}"></span>${esc(AGENCIES[k].name)} ${STATUS_TEXT[s.status] || s.status}${extra}</span>`);
    }
    el.innerHTML = parts.join("");
  }

  function renderList() {
    const list = $("storm-list");
    const storms = state.data?.storms || [];
    if (!storms.length) {
      list.innerHTML = `<li class="empty">目前沒有活躍的熱帶氣旋</li>`;
      return;
    }
    list.innerHTML = storms.map((s) => {
      const now = AGENCY_ORDER.filter((k) => s.agencies[k]).map((k) => {
        const p = s.agencies[k].points[0];
        const w = wind(p.vmax_kt, p.vmax_ms);
        return `<span>${AGENCIES[k].short}</span><span>${w != null ? `${w} ${unitText()}` : "—"}${p.pres_hpa != null ? ` · ${p.pres_hpa} hPa` : ""}　${fmt(s.agencies[k].issued)} 發布</span>`;
      }).join("");
      return `<li><button type="button" class="storm-card" data-key="${esc(s.key)}" aria-current="${s.key === state.selected}">
        <span class="name">${esc(stormTitle(s))}<span class="ids">${esc(stormIds(s))}</span></span>
        <span class="now">${now}</span></button></li>`;
    }).join("");
    list.querySelectorAll(".storm-card").forEach((b) => b.addEventListener("click", () => select(b.dataset.key)));
  }

  function renderToggles(storm) {
    const box = $("agency-toggles");
    box.innerHTML = AGENCY_ORDER.filter((k) => storm.agencies[k]).map((k) => {
      const stale = storm.agencies[k].stale ? `<span class="stale">舊資料</span>` : "";
      return `<button type="button" class="agency-chip" data-agency="${k}" aria-pressed="${state.enabled.has(k)}">
        ${shapeSvg(AGENCIES[k].shape, color(k), 12, 0)}${esc(AGENCIES[k].name)}${stale}</button>`;
    }).join("");
    box.querySelectorAll(".agency-chip").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.agency;
      state.enabled.has(k) ? state.enabled.delete(k) : state.enabled.add(k);
      render();
    }));
  }

  function renderModelToggles(storm) {
    const box = $("model-toggles");
    if (!state.models) {
      box.innerHTML = `<p class="note">${state.modelsFailed ? "模式資料載入失敗，稍後自動重試" : "模式資料載入中…"}</p>`;
      return;
    }
    box.innerHTML = MODEL_GROUPS.map(([title, codes]) => `<div class="model-group"><span class="group-label">${title}</span>` +
      codes.map((code) => {
        const m = state.models.models?.[code];
        const meta = MODELS[code];
        const has = m && matchModelStorm(code, storm);
        let sub;
        if (!m || !m.init) sub = "無資料";
        else if (!has) sub = "沒有這個颱風";
        else sub = `${fmt(m.init)} 起報`;
        const warn = m?.status === "error" ? `<span class="stale" title="${esc(m.message || "")}">更新失敗</span>` : "";
        const swatch = `<svg width="18" height="8" aria-hidden="true"><line x1="1" y1="4" x2="17" y2="4" stroke="${modelColor(code)}" stroke-width="3" stroke-linecap="round"${meta.kind === "ensemble" ? ' stroke-dasharray="1 5"' : ""}/></svg>`;
        return `<button type="button" class="agency-chip model-chip" data-model="${code}" aria-pressed="${state.modelOn.has(code)}"${has ? "" : " data-empty"}>
          ${swatch}<span>${meta.short}</span><span class="sub">${sub}</span>${warn}</button>`;
      }).join("") + `</div>`).join("") +
      `<div class="model-group"><span class="group-label">系集路徑密度</span>
        <div class="segmented" role="group" aria-label="系集路徑密度">` +
      [["off", "關閉"], ["gefs", "GEFS"], ["eps", "EPS"]].map(([k, label]) => {
        const empty = k !== "off" && !matchModelStorm(k, storm);
        return `<button type="button" data-density="${k}" aria-pressed="${state.density === k}"${empty ? ' disabled title="這個颱風沒有此模式的資料"' : ""}>${label}</button>`;
      }).join("") + `</div></div>`;
    box.querySelectorAll(".model-chip").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.model;
      state.modelOn.has(k) ? state.modelOn.delete(k) : state.modelOn.add(k);
      store.set("tc-models", [...state.modelOn].join(",") || "none");
      render();
    }));
    box.querySelectorAll("[data-density]").forEach((b) => b.addEventListener("click", () => {
      state.density = b.dataset.density;
      store.set("tc-density", state.density);
      render();
    }));
  }

  let chart = null;
  function renderChart(storm) {
    const datasets = AGENCY_ORDER.filter((k) => storm.agencies[k] && state.enabled.has(k)).map((k) => ({
      label: AGENCIES[k].name,
      data: storm.agencies[k].points
        .map((p) => ({ x: Date.parse(p.time), y: wind(p.vmax_kt, p.vmax_ms), p }))
        .filter((d) => d.y != null),
      borderColor: color(k),
      backgroundColor: color(k),
      borderWidth: 2,
      pointRadius: 4,
      pointHoverRadius: 6,
      pointStyle: { circle: "circle", square: "rect", diamond: "rectRot" }[AGENCIES[k].shape],
      pointBorderColor: css("--surface"),
      pointBorderWidth: 1.5,
      tension: 0,
    }));
    const grid = css("--grid"), muted = css("--muted"), text2 = css("--text-2");
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", intersect: false },
      scales: {
        x: {
          type: "linear", grid: { color: grid }, border: { color: grid },
          ticks: { color: muted, maxTicksLimit: 6, callback: (v) => fmt(new Date(v).toISOString()).split(" ")[0] },
        },
        y: {
          grid: { color: grid }, border: { display: false }, ticks: { color: muted, maxTicksLimit: 6 },
          title: { display: true, text: unitText(), color: muted },
        },
      },
      plugins: {
        legend: { labels: { color: text2, usePointStyle: true, boxHeight: 8 } },
        tooltip: {
          callbacks: {
            title: (items) => fmt(new Date(items[0].parsed.x).toISOString()),
            label: (item) => `${item.dataset.label}：${item.parsed.y} ${unitText()}${item.raw.p.pres_hpa != null ? `，${item.raw.p.pres_hpa} hPa` : ""}`,
          },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("intensity-chart"), { type: "line", data: { datasets }, options: opts });
  }

  function renderTable(storm) {
    const agencies = AGENCY_ORDER.filter((k) => storm.agencies[k] && state.enabled.has(k));
    const times = [...new Set(agencies.flatMap((k) => storm.agencies[k].points.map((p) => p.time)))].sort();
    const head = `<thead><tr><th>時間</th>${agencies.map((k) => `<th>${AGENCIES[k].short}</th>`).join("")}</tr></thead>`;
    const body = times.map((t) => {
      const cells = agencies.map((k) => {
        const p = storm.agencies[k].points.find((q) => q.time === t);
        if (!p) return `<td class="na">—</td>`;
        const w = wind(p.vmax_kt, p.vmax_ms);
        return `<td>${w ?? "—"}${p.pres_hpa != null ? ` / ${p.pres_hpa}` : ""}</td>`;
      }).join("");
      return `<tr><td>${fmt(t)}</td>${cells}</tr>`;
    }).join("");
    $("intensity-table").innerHTML = head + `<tbody>${body}</tbody>` +
      `<caption style="caption-side:bottom;text-align:left;color:var(--muted);padding-top:4px">風速 ${unitText()} / 中心氣壓 hPa</caption>`;
  }

  /* ---------- 主流程 ---------- */

  function select(key) {
    state.selected = key;
    render(true);
  }

  function render(fit = false) {
    renderStatus();
    renderList();
    document.querySelectorAll(".unit-label").forEach((e) => (e.textContent = `（${unitText()}）`));

    layer.clearLayers();
    const storms = state.data?.storms || [];
    $("map-empty").hidden = storms.length > 0;
    let selBounds = [];
    for (const s of storms) {
      if (s.key !== state.selected) drawStorm(s, false);
    }
    const sel = storms.find((s) => s.key === state.selected);
    if (sel) {
      drawModels(sel);  // 先畫模式，官方路徑疊在上面
      selBounds = drawStorm(sel, true);
    }
    drawDensity(state.models ? sel : null);

    $("detail").hidden = !sel;
    if (sel) {
      $("detail-title").textContent = stormTitle(sel);
      renderToggles(sel);
      renderModelToggles(sel);
      renderChart(sel);
      renderTable(sel);
      if (fit && selBounds.length) map.fitBounds(selBounds, { padding: [40, 40], maxZoom: 6 });
    }
  }

  async function loadModels() {
    try {
      const res = await fetch(MODELS_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.models = await res.json();
      state.modelsFailed = false;
    } catch (e) {
      console.warn("讀取模式資料失敗", e);
      state.modelsFailed = !state.models;
    }
  }

  async function load(first = false) {
    const models = loadModels();
    try {
      const res = await fetch(`${DATA_URL}?t=${Date.now()}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
    } catch (e) {
      console.warn("讀取資料失敗", e);
      if (!state.data) { render(); return; }
    }
    state.data.storms = (state.data.storms || []).sort((a, b) => intensity(b) - intensity(a));
    const storms = state.data.storms;
    updateSst(state.data.layers?.sst);
    refreshClouds();
    refreshBd();
    await models;
    let fit = false;
    if (!storms.some((s) => s.key === state.selected)) {
      state.selected = storms[0]?.key ?? null;
      fit = true;
    }
    render(first || fit);
  }

  document.querySelectorAll(".unit-switch button").forEach((b) => b.addEventListener("click", () => {
    state.unit = b.dataset.unit;
    document.querySelectorAll(".unit-switch button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    try { localStorage.setItem("tc-unit", state.unit); } catch (_) { /* 無痕模式等情況忽略 */ }
    render();
  }));
  $("show-past").addEventListener("change", (e) => { state.showPast = e.target.checked; render(); });
  $("show-cone").addEventListener("change", (e) => { state.showCone = e.target.checked; render(); });

  const savedModels = store.get("tc-models");
  if (savedModels) state.modelOn = new Set(savedModels.split(",").filter((k) => MODELS[k]));
  if (ENSEMBLE_SIZE[store.get("tc-density")]) state.density = store.get("tc-density");

  try {
    const u = localStorage.getItem("tc-unit");
    if (u === "kt" || u === "ms") {
      state.unit = u;
      document.querySelectorAll(".unit-switch button").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.unit === u)));
    }
  } catch (_) { /* 忽略 */ }

  load(true);
  setInterval(load, REFRESH_MS);
})();
