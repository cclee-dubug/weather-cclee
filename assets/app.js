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
  const { AGENCY_ORDER, fmt, esc, stormTitle, stormIds, intensity, store } = TcCommon;
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
  // 模式路徑依強度上色用的分級（kt，Saffir-Simpson 颶風風力等級）。模式風速是網格平均，
  // 強颱風常被低估，只看相對變化
  const TC_SCALE = [
    [0, "#7fb2e5", "TD", "熱帶性低氣壓 34 kt 以下"],
    [34, "#3cbf5a", "TS", "熱帶風暴 34–63 kt"],
    [64, "#f2d230", "1", "一級 64–82 kt"],
    [83, "#f59a23", "2", "二級 83–95 kt"],
    [96, "#e5482e", "3", "三級 96–112 kt"],
    [113, "#d6338f", "4", "四級 113–136 kt"],
    [137, "#8e3fd1", "5", "五級 137 kt 以上"],
  ];
  const scaleColor = (kt) => {
    let c = TC_SCALE[0][1];
    for (const [min, col] of TC_SCALE) if (kt != null && kt >= min) c = col;
    return c;
  };
  // 系集機率橢圓：二維常態分布中涵蓋 70% 的範圍是馬氏距離平方 ≤ -2 ln(0.3)
  const ELLIPSE_K2 = -2 * Math.log(1 - 0.7);
  const ELLIPSE_TAUS = [24, 48, 72, 96, 120];
  const ELLIPSE_MIN_MEMBERS = 5;
  const SLOT_MS = 6 * 3600e3;  // 官方預報每 6 小時取一報（與 fetcher/history.py 相同）

  const state = {
    data: null,
    selected: null,
    unit: "kt",
    enabled: new Set(["cwa"]), // 預設只顯示中央氣象署；颱風沒有氣象署資料時改用第一個有資料的機構
    showPast: true,
    showCone: false,
    models: null,
    modelsFailed: false,
    agencyTouched: false, // 使用者點過機構按鈕後，不再自動替換沒有資料的機構
    modelOn: new Set(), // 預設不顯示模式路徑
    density: "off", // 系集路徑密度：off、gefs、eps
    trackColor: "model", // 模式路徑顏色：model 依模式、intensity 依強度
    showEllipse: false,
    showHours: false,
    prevCount: 0, // 顯示前幾報預報（0 為關閉）
  };

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = (agency) => css(`--agency-${agency}`);

  function wind(kt, ms) {
    if (state.unit === "ms") {
      const v = ms ?? (kt != null ? kt * MS_PER_KT : null);
      return v == null ? null : Math.round(v);
    }
    return kt == null ? null : Math.round(kt);
  }
  const unitText = () => (state.unit === "ms" ? "m/s" : "kt");

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
  // 打開網頁時一律是衛星影像＋衛星雲圖（不記住上次的選擇）
  BASEMAPS.satellite[1].addTo(map);

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
  let intensityLegend = false; // 模式路徑依強度上色時顯示色階

  // 海岸線：Natural Earth 1:50m（與模式天氣圖同一份），畫在雲圖之上；深色外框加亮黃色線，
  // 疊在白色雲頂、衛星影像或淺色海洋底圖上都看得清楚
  const COAST_NAME = "海岸線";
  const coastGroup = L.layerGroup();
  const coastRenderer = L.canvas({ pane: "coast", padding: 0.3 });
  fetch("fetcher/coast_wpac.json")
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((lines) => {
      const ll = lines.map((line) => line.map(([lon, lat]) => [lat, lon]));
      const opts = { renderer: coastRenderer, interactive: false, smoothFactor: 1.5 };
      coastGroup.addLayer(L.polyline(ll, { ...opts, color: "#101820", weight: 3.2, opacity: 0.75 }));
      coastGroup.addLayer(L.polyline(ll, { ...opts, color: "#ffe14d", weight: 1.3, opacity: 1 }));
    })
    .catch((e) => console.warn("讀取海岸線失敗", e));

  L.control.layers(
    Object.fromEntries(Object.values(BASEMAPS)),
    { [SST_NAME]: sstGroup, [CLOUD_NAME]: cloudGroup, [BD_NAME]: bdGroup, [COAST_NAME]: coastGroup },
    { position: "topright", collapsed: false },
  ).addTo(map);
  cloudGroup.addTo(map);
  coastGroup.addTo(map);

  map.on("overlayadd overlayremove", (e) => {
    const on = e.type === "overlayadd";
    if (e.layer === cloudGroup || e.layer === bdGroup) stopLoop();
    // 兩種雲圖擇一顯示：BD 雲圖不透明，同時開會把另一張蓋住。
    // 等圖層控制項處理完這次點擊再關另一張，否則控制項會依舊的勾選狀態把它加回來
    if (e.layer === cloudGroup && on) {
      setTimeout(() => map.removeLayer(bdGroup));
      refreshClouds();
    }
    if (e.layer === bdGroup && on) {
      setTimeout(() => map.removeLayer(cloudGroup));
      refreshBd();
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
    // 播放動畫時不換底圖，停止後下一次更新再換
    if (!map.hasLayer(cloudGroup) || cloudBusy || loop.timer) return;
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
    if (!map.hasLayer(bdGroup) || bdBusy || loop.timer) return;
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
    if (intensityLegend) {
      parts.push(`<div><b>模式路徑強度</b> <span class="muted">近中心最大風速（kt）</span></div>` +
        `<div class="tc-scale">${TC_SCALE.map(([, c, short, title]) => `<span title="${title}"><i style="background:${c}"></i>${short}</span>`).join("")}</div>`);
    }
    if (densityInfo) {
      const meta = MODELS[densityInfo.code];
      parts.push(`<div><b>路徑密度</b> <span class="muted">${meta.short}，${fmt(densityInfo.init)} 起報</span></div>` +
        TcRaster.densityLegendHtml() +
        `<div class="muted">${densityInfo.members} 個成員中，颱風中心通過該處 ${TcRaster.DENSITY_RADIUS_KM} 公里內的比例（%，整個預報期間，5% 以下不顯示）</div>`);
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
    renderLoopBar();
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
      if (!a || !isShown(storm, agency) || !a.points?.length) continue;
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
    const main = mainAgency(storm);
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
  const matchModelStorm = (code, storm) => TcCommon.matchModelStorm(state.models?.models?.[code], storm);

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

  // 依強度上色：每段用兩端風速的平均決定顏色，同色的線段合成一條多段線
  function intensitySegments(tracks) {
    const byColor = new Map();
    for (const pts of tracks) {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const kt = a[3] != null && b[3] != null ? (a[3] + b[3]) / 2 : (a[3] ?? b[3]);
        const c = scaleColor(kt);
        if (!byColor.has(c)) byColor.set(c, []);
        byColor.get(c).push([[a[1], a[2]], [b[1], b[2]]]);
      }
    }
    return byColor;
  }

  function drawModelLine(code, init, pts, label, dashed) {
    if (pts.length < 2) return;
    const byIntensity = state.trackColor === "intensity";
    const c = modelColor(code);
    const ll = pts.map((p) => [p[1], p[2]]);
    // 底下墊一條寬線，疊在衛星雲圖或海溫上也看得清楚；依強度上色時用深色底，淺黃色才看得到
    L.polyline(ll, {
      color: byIntensity ? "#1d1d1d" : css("--surface"), weight: byIntensity ? 6 : 5.5,
      opacity: byIntensity ? 0.55 : 0.75, interactive: false,
    }).addTo(layer);
    const lineOpts = { weight: 3, opacity: 0.95, interactive: false, lineCap: "round", ...(dashed ? { dashArray: "1 7" } : {}) };
    if (byIntensity) {
      for (const [col, segs] of intensitySegments([pts])) L.polyline(segs, { ...lineOpts, color: col }).addTo(layer);
    } else {
      L.polyline(ll, { ...lineOpts, color: c }).addTo(layer);
    }
    for (const p of pts) {
      if (p[0] === 0 || p[0] % 24) continue;
      L.circleMarker([p[1], p[2]], {
        radius: 3.5, color: byIntensity ? "#1d1d1d" : css("--surface"), weight: 1.5,
        fillColor: byIntensity ? scaleColor(p[3]) : c, fillOpacity: 1,
      })
        .bindTooltip(modelTip(code, init, p, label), { className: "tc-tip", direction: "top", offset: [0, -4] })
        .addTo(layer);
      if (state.showHours) {
        L.tooltip({ permanent: true, direction: "left", offset: [-5, 0], className: "tau-label hour-label" })
          .setLatLng([p[1], p[2]]).setContent(`${p[0]}h`).addTo(layer);
      }
    }
    const last = pts[pts.length - 1];
    L.tooltip({ permanent: true, direction: "right", offset: [6, 0], className: "model-label" })
      .setLatLng([last[1], last[2]]).setContent(`<span style="color:${c}">${esc(label)}</span>`).addTo(layer);
  }

  // 成員在某個預報時間的位置；剛好缺這個時間時，用前後 12 小時內的兩點內插
  function memberPos(m, tau) {
    for (let i = 0; i < m.length; i++) {
      if (m[i][0] === tau) return [m[i][1], m[i][2]];
      if (m[i][0] > tau) {
        const a = m[i - 1], b = m[i];
        if (!a || b[0] - a[0] > 12) return null;
        const f = (tau - a[0]) / (b[0] - a[0]);
        return [a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2])];
      }
    }
    return null;
  }

  // 成員位置 → 70% 機率橢圓的頂點（在平均位置附近用公里座標算共變異數）
  function ensembleEllipse(pos) {
    const n = pos.length;
    const lat0 = pos.reduce((s, p) => s + p[0], 0) / n;
    const lon0 = pos.reduce((s, p) => s + p[1], 0) / n;
    const kx = 111.32 * Math.cos(lat0 * Math.PI / 180), ky = 110.57;
    let sxx = 0, syy = 0, sxy = 0;
    for (const [lat, lon] of pos) {
      const x = (lon - lon0) * kx, y = (lat - lat0) * ky;
      sxx += x * x; syy += y * y; sxy += x * y;
    }
    sxx /= n - 1; syy /= n - 1; sxy /= n - 1;
    // 共變異數矩陣的特徵值與主軸方向
    const tr = (sxx + syy) / 2, det = Math.sqrt(((sxx - syy) / 2) ** 2 + sxy ** 2);
    const l1 = tr + det, l2 = Math.max(tr - det, 0);
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    // 成員幾乎重疊時至少畫 15 公里，避免變成看不見的點
    const a = Math.max(Math.sqrt(ELLIPSE_K2 * l1), 15), b = Math.max(Math.sqrt(ELLIPSE_K2 * l2), 15);
    const pts = [];
    for (let i = 0; i < 72; i++) {
      const t = (i / 72) * 2 * Math.PI;
      const x = a * Math.cos(t) * Math.cos(th) - b * Math.sin(t) * Math.sin(th);
      const y = a * Math.cos(t) * Math.sin(th) + b * Math.sin(t) * Math.cos(th);
      pts.push([lat0 + y / ky, lon0 + x / kx]);
    }
    return { center: [lat0, lon0], pts, a, b };
  }

  function drawEllipses(code, init, members) {
    const c = modelColor(code);
    const size = ENSEMBLE_SIZE[code];
    for (const tau of ELLIPSE_TAUS) {
      const pos = members.map((m) => memberPos(m, tau)).filter(Boolean);
      if (pos.length < ELLIPSE_MIN_MEMBERS) continue;
      const e = ensembleEllipse(pos);
      const valid = fmt(new Date(Date.parse(init) + tau * 3600e3).toISOString());
      L.polygon(e.pts, { color: c, weight: 1.8, opacity: 0.9, fillColor: c, fillOpacity: 0.08 })
        .bindTooltip([
          `<b>${MODELS[code].short} 70% 機率橢圓</b> +${tau} 小時`,
          `${valid}　中心 ${e.center[0].toFixed(1)}°N ${e.center[1].toFixed(1)}°E`,
          `長軸半徑約 ${Math.round(e.a)} km，短軸約 ${Math.round(e.b)} km`,
          `${pos.length} / ${size} 個成員在這個時間仍追得到颱風`,
          `<span class="muted">${fmt(init)} 起報</span>`,
        ].join("<br>"), { className: "tc-tip", sticky: true })
        .addTo(layer);
      const top = e.pts.reduce((best, p) => (p[0] > best[0] ? p : best));
      L.tooltip({ permanent: true, direction: "top", offset: [0, -2], className: "model-label" })
        .setLatLng(top).setContent(`<span style="color:${c}">${tau}h</span>`).addTo(layer);
    }
  }

  function drawModels(storm) {
    intensityLegend = false;
    for (const code of ["gefs", "eps", "gfs", "ifs"]) {  // 系集先畫，決定性模式疊在上面
      if (!state.modelOn.has(code)) continue;
      const ms = matchModelStorm(code, storm);
      if (!ms) continue;
      if (state.trackColor === "intensity") intensityLegend = true;
      const init = state.models.models[code].init;
      const meta = MODELS[code];
      if (meta.kind === "deterministic") {
        drawModelLine(code, init, ms.track || [], meta.short, false);
        continue;
      }
      const members = (ms.members || []).filter((m) => m.length >= 2);
      // 開了機率橢圓時成員路徑畫淡一點，橢圓才看得清楚
      const memberOpacity = state.showEllipse ? 0.2 : 0.4;
      if (state.trackColor === "intensity") {
        for (const [col, segs] of intensitySegments(members)) {
          L.polyline(segs, { color: col, weight: 1.2, opacity: memberOpacity + 0.15, interactive: false }).addTo(layer);
        }
      } else {
        const c = modelColor(code);
        for (const m of members) {
          L.polyline(m.map((p) => [p[1], p[2]]), { color: c, weight: 1, opacity: memberOpacity, interactive: false }).addTo(layer);
        }
      }
      if (state.showEllipse) drawEllipses(code, init, members);
      if (ms.mean?.length) drawModelLine(code, init, ms.mean, `${meta.short} 平均`, true);
    }
  }

  /* ---------- 前幾報預報 ---------- */

  const slotOf = (iso) => Math.floor(Date.parse(iso) / SLOT_MS);
  // 官方前幾報：每 6 小時時段只留一報，且不含與目前這報同一時段的
  function previousReports(a) {
    const cur = slotOf(a.issued);
    return (a.previous || []).filter((h) => h.points?.length && slotOf(h.issued) < cur).slice(0, state.prevCount);
  }
  // 越舊的越淡
  const prevOpacity = (i, n) => 0.75 - 0.45 * (n > 1 ? i / (n - 1) : 0);

  function drawPrevious(storm) {
    if (!state.prevCount) return;
    for (const agency of AGENCY_ORDER) {
      const a = storm.agencies[agency];
      if (!a || !isShown(storm, agency)) continue;
      const c = color(agency);
      const reports = previousReports(a);
      reports.forEach((h, i) => {
        const op = prevOpacity(i, reports.length);
        const title = `<b>${esc(AGENCIES[agency].name)} 前 ${i + 1} 報</b>　${fmt(h.issued)} 發布`;
        L.polyline(h.points.map((p) => [p.lat, p.lon]), { color: c, weight: 2, opacity: op, dashArray: "2 5" })
          .bindTooltip(title, { className: "tc-tip", sticky: true }).addTo(layer);
        for (const p of h.points) {
          if (!p.tau) continue;
          L.circleMarker([p.lat, p.lon], { radius: 2.5, color: c, weight: 1, opacity: op, fillColor: c, fillOpacity: op })
            .bindTooltip(`${title}<br>` + pointTip(agency, a, p).split("<br>").slice(1).join("<br>"),
              { className: "tc-tip", direction: "top", offset: [0, -4] })
            .addTo(layer);
        }
      });
    }
    if (!state.models) return;
    for (const code of ["gfs", "ifs", "gefs", "eps"]) {
      const m = state.models.models?.[code];
      if (!state.modelOn.has(code) || !m) continue;
      const runs = (m.previous || []).slice(0, state.prevCount);
      const meta = MODELS[code];
      const label = meta.kind === "ensemble" ? `${meta.short} 平均` : meta.short;
      runs.forEach((run, i) => {
        const ms = TcCommon.matchModelStorm(run, storm);
        const pts = ms?.track || ms?.mean;
        if (!pts || pts.length < 2) return;
        L.polyline(pts.map((p) => [p[1], p[2]]), {
          color: modelColor(code), weight: 2, opacity: prevOpacity(i, runs.length), dashArray: "2 5",
        })
          .bindTooltip(`<b>${esc(label)} 前 ${i + 1} 次起報</b>　${fmt(run.init)} 起報`, { className: "tc-tip", sticky: true })
          .addTo(layer);
      });
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
        densityLayer = new TcRaster.DensityLayer({ pane: "density", grid }).addTo(map);
        densityInfo = { code, init, members: grid.members };
      }
    }
    renderLegend();
  }

  // 這個颱風要畫的機構：勾選的機構裡有資料的。還沒點過機構按鈕時，颱風若沒有預設機構（中央氣象署）的資料，
  // 改用第一個有資料的機構；點過之後完全照使用者的選擇，全部取消就不畫
  function shownAgencies(storm) {
    const has = AGENCY_ORDER.filter((k) => storm.agencies[k]?.points?.length);
    const on = has.filter((k) => state.enabled.has(k));
    return on.length || state.agencyTouched ? on : has.slice(0, 1);
  }
  const isShown = (storm, k) => shownAgencies(storm).includes(k);
  function firstEnabled(storm) {
    return shownAgencies(storm)[0];
  }
  // 目前位置、時間軸起點用的機構：沒有顯示任何機構時仍用第一個有資料的，颱風才不會從地圖上消失
  const mainAgency = (storm) => firstEnabled(storm) || AGENCY_ORDER.find((k) => storm.agencies[k]?.points?.length);

  /* ---------- 雲圖動畫 ---------- */

  // 動畫長度（小時）→ 每幾分鐘一張；張數控制在 19 張左右，圖磚數量才不會太多
  const LOOP_STEP_MIN = { 3: 10, 6: 20 };
  const LOOP_FRAME_MS = 250;
  const LOOP_DWELL_MS = 1200; // 最後一張多停一下
  const loop = { frames: [], idx: 0, timer: null, group: null, base: null, span: 3, ready: false };

  function loopKind() {
    if (map.hasLayer(bdGroup) && bdTime) return "bd";
    if (map.hasLayer(cloudGroup) && cloudTime) return "ir";
    return null;
  }

  // 向日葵每天 02:40、14:40 UTC 沒有全圓盤觀測
  const himawariGap = (ms) => { const d = new Date(ms); return d.getUTCMinutes() === 40 && d.getUTCHours() % 12 === 2; };

  function loopTimes(latestMs, kind) {
    const step = LOOP_STEP_MIN[loop.span] * 60e3;
    const n = Math.round(loop.span * 3600e3 / step);
    const out = [];
    for (let i = n; i >= 0; i--) {
      const t = latestMs - i * step;
      if (kind === "ir" && himawariGap(t)) continue;
      out.push(t);
    }
    return out;
  }

  function startLoop() {
    const kind = loopKind();
    if (!kind) return;
    stopLoop();
    const latest = kind === "bd" ? Date.parse(bdTime) : Date.parse(stampToIso(cloudTime));
    loop.group = kind === "bd" ? bdGroup : cloudGroup;
    loop.base = kind === "bd" ? bdTiles : cloudTiles;
    const times = loopTimes(latest, kind);
    let loaded = 0;
    loop.frames = times.map((t) => {
      const lyr = kind === "bd"
        ? TcRaster.bdLayer(bdUrl(new Date(t).toISOString().replace(".000Z", "Z")),
          { pane: "bd", maxNativeZoom: 6, bounds: [[-80, 60], [80, 222]], opacity: 0 })
        : L.tileLayer(cloudUrl(himawariStamp(t)), { pane: "clouds", maxNativeZoom: 5, bounds: [[-80, 60], [80, 222]], opacity: 0 });
      lyr.once("load", () => {
        loaded += 1;
        if (!loop.ready) $("loop-label").textContent = `載入中 ${loaded}/${times.length}…`;
        if (loaded === times.length) loop.ready = true;
      });
      loop.group.addLayer(lyr);
      return { t, lyr };
    });
    loop.idx = 0;
    loop.ready = false;
    $("loop-label").textContent = `載入中 0/${times.length}…`;
    $("loop-play").textContent = "⏸ 停止";
    // 最多等 15 秒，沒載完的時段照樣播（缺的圖磚會是空白）
    const started = Date.now();
    const tick = () => {
      if (!loop.ready && Date.now() - started < 15000) { loop.timer = setTimeout(tick, 300); return; }
      loop.ready = true;
      loop.base?.setOpacity(0);
      showFrame(loop.idx);
      const last = loop.idx === loop.frames.length - 1;
      loop.idx = (loop.idx + 1) % loop.frames.length;
      loop.timer = setTimeout(tick, last ? LOOP_DWELL_MS : LOOP_FRAME_MS);
    };
    tick();
  }

  function showFrame(i) {
    loop.frames.forEach((f, k) => f.lyr.setOpacity(k === i ? 1 : 0));
    const f = loop.frames[i];
    $("loop-label").textContent = `${fmt(new Date(f.t).toISOString())}（${i + 1}/${loop.frames.length}）`;
  }

  function stopLoop() {
    clearTimeout(loop.timer);
    loop.timer = null;
    for (const f of loop.frames) loop.group?.removeLayer(f.lyr);
    loop.frames = [];
    loop.base?.setOpacity(1);
    loop.base = null;
    $("loop-play").textContent = "▶ 播放";
    renderLoopBar();
  }

  function renderLoopBar() {
    if (loop.timer) return;
    const kind = loopKind();
    $("loop-play").disabled = !kind;
    $("loop-play").title = kind ? "" : "請先開啟衛星雲圖或 BD 強化雲圖";
    $("loop-label").textContent = kind ? `播放過去 ${loop.span} 小時的${kind === "bd" ? " BD 強化" : "紅外線"}雲圖` : "未開啟雲圖";
  }

  function stormNow() {
    const sel = state.data?.storms?.find((s) => s.key === state.selected);
    const k = sel && mainAgency(sel);
    return k ? sel.agencies[k].points[0] : null;
  }
  function centerOnStorm() {
    const p0 = stormNow();
    if (p0) map.setView([p0.lat, p0.lon], Math.max(map.getZoom(), 5.5));
  }

  $("loop-play").addEventListener("click", () => {
    if (loop.timer) { stopLoop(); return; }
    // 動畫以颱風為中心：地圖還在大範圍時先移過去，載入的圖磚也比較少
    const p0 = stormNow();
    if (p0 && (map.getZoom() < 5 || !map.getBounds().pad(-0.25).contains([p0.lat, p0.lon]))) centerOnStorm();
    startLoop();
  });
  $("center-storm").addEventListener("click", centerOnStorm);
  $("loop-span").querySelectorAll("[data-span]").forEach((b) => b.addEventListener("click", () => {
    loop.span = Number(b.dataset.span);
    $("loop-span").querySelectorAll("[data-span]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    if (loop.timer) startLoop(); else renderLoopBar();
  }));

  /* ---------- 預報時間軸 ---------- */

  // 拖到某個時間時，標出各機構與各模式預報在這個時間的位置（系集成員以小點表示），比較分歧
  const FC_MAX_HOURS = 168;
  const FC_STEP = 3;
  const timeLayer = L.layerGroup().addTo(map);
  const fc = { hours: 0, base: null, timer: null };

  const lerp = (a, b, f) => (a == null || b == null ? (f < 0.5 ? a : b) : a + f * (b - a));
  function agencyAt(points, t) {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      const ta = Date.parse(a.time), tb = Date.parse(b.time);
      if (t < ta || t > tb) continue;
      const f = tb > ta ? (t - ta) / (tb - ta) : 0;
      return {
        lat: lerp(a.lat, b.lat, f), lon: lerp(a.lon, b.lon, f),
        vmax_kt: lerp(a.vmax_kt, b.vmax_kt, f), vmax_ms: lerp(a.vmax_ms, b.vmax_ms, f), pres_hpa: lerp(a.pres_hpa, b.pres_hpa, f),
      };
    }
    return null;
  }
  // 模式路徑 [tau, lat, lon, 風速, 氣壓] 在 tau 小時的位置，前後兩點相隔超過 12 小時不內插
  function modelAt(pts, tau) {
    for (let i = 0; i < pts.length; i++) {
      if (pts[i][0] === tau) return pts[i];
      if (pts[i][0] > tau) {
        const a = pts[i - 1], b = pts[i];
        if (!a || b[0] - a[0] > 12) return null;
        const f = (tau - a[0]) / (b[0] - a[0]);
        return [tau, lerp(a[1], b[1], f), lerp(a[2], b[2], f), lerp(a[3], b[3], f), lerp(a[4], b[4], f)];
      }
    }
    return null;
  }

  // 時間軸的起點是主要機構目前位置的時間，終點是顯示中的官方預報與模式路徑最晚的時間
  function updateTimeRange(storm) {
    const k = storm && mainAgency(storm);
    if (!k) { fc.base = null; return; }
    fc.base = Date.parse(storm.agencies[k].points[0].time);
    let end = fc.base;
    for (const a of shownAgencies(storm)) end = Math.max(end, Date.parse(storm.agencies[a].points.at(-1).time));
    for (const code of state.modelOn) {
      const ms = state.models && matchModelStorm(code, storm);
      const pts = ms?.track || ms?.mean;
      if (pts?.length) end = Math.max(end, Date.parse(state.models.models[code].init) + pts.at(-1)[0] * 3600e3);
    }
    const max = Math.min(FC_MAX_HOURS, Math.floor((end - fc.base) / 3600e3 / FC_STEP) * FC_STEP);
    $("fc-time").max = String(Math.max(max, FC_STEP));
    if (fc.hours > max) fc.hours = max;
    $("fc-time").value = String(fc.hours);
  }

  function drawTime() {
    timeLayer.clearLayers();
    const storm = state.data?.storms?.find((s) => s.key === state.selected);
    if (!storm || fc.base == null) { $("fc-label").textContent = "—"; return; }
    if (!fc.hours) { $("fc-label").textContent = "拖曳查看同一時間各預報的位置"; return; }
    const t = fc.base + fc.hours * 3600e3;
    $("fc-label").textContent = `+${fc.hours} 小時　${fmt(new Date(t).toISOString())}`;
    const tag = (ll, html) => L.tooltip({ permanent: true, direction: "right", offset: [9, 0], className: "model-label time-tag" })
      .setLatLng(ll).setContent(html).addTo(timeLayer);

    for (const code of ["gefs", "eps", "gfs", "ifs"]) {
      if (!state.modelOn.has(code)) continue;
      const ms = matchModelStorm(code, storm);
      if (!ms) continue;
      const init = state.models.models[code].init;
      const tau = (t - Date.parse(init)) / 3600e3;
      const c = modelColor(code);
      const meta = MODELS[code];
      for (const m of ms.members || []) {
        const p = modelAt(m, tau);
        if (p) L.circleMarker([p[1], p[2]], { radius: 3, stroke: false, fillColor: c, fillOpacity: 0.75, interactive: false }).addTo(timeLayer);
      }
      const p = modelAt(ms.track || ms.mean || [], tau);
      if (!p) continue;
      const label = meta.kind === "ensemble" ? `${meta.short} 平均` : meta.short;
      L.circleMarker([p[1], p[2]], { radius: 6, color: css("--surface"), weight: 2, fillColor: c, fillOpacity: 1 })
        .bindTooltip(modelTip(code, init, p.map((v, i) => (!i || v == null ? v : i <= 2 ? Math.round(v * 10) / 10 : Math.round(v))), label),
          { className: "tc-tip", direction: "top", offset: [0, -6] })
        .addTo(timeLayer);
      tag([p[1], p[2]], `<span style="color:${c}">${esc(label)}</span>`);
    }
    for (const agency of shownAgencies(storm)) {
      const a = storm.agencies[agency];
      const p = agencyAt(a.points, t);
      if (!p) continue;
      const w = wind(p.vmax_kt, p.vmax_ms);
      L.marker([p.lat, p.lon], { icon: shapeIcon(agency, 18), zIndexOffset: 2000, keyboard: false })
        .bindTooltip([
          `<b>${esc(AGENCIES[agency].name)}</b> +${fc.hours} 小時（內插）`,
          `${p.lat.toFixed(1)}°N ${p.lon.toFixed(1)}°E`,
          w != null ? `最大風速 ${w} ${unitText()}` : "",
          p.pres_hpa != null ? `中心氣壓 ${Math.round(p.pres_hpa)} hPa` : "",
        ].filter(Boolean).join("<br>"), { className: "tc-tip", direction: "top", offset: [0, -8] })
        .addTo(timeLayer);
      tag([p.lat, p.lon], `<span style="color:${color(agency)}">${AGENCIES[agency].short}</span>`);
    }
  }

  function stopFc() {
    clearInterval(fc.timer);
    fc.timer = null;
    $("fc-play").textContent = "▶ 播放";
  }
  $("fc-time").addEventListener("input", (e) => {
    stopFc();
    fc.hours = Number(e.target.value);
    drawTime();
  });
  $("fc-play").addEventListener("click", () => {
    if (fc.timer) { stopFc(); return; }
    const max = Number($("fc-time").max);
    if (fc.hours >= max) fc.hours = 0;
    $("fc-play").textContent = "⏸ 停止";
    fc.timer = setInterval(() => {
      fc.hours = Math.min(fc.hours + FC_STEP, max);
      $("fc-time").value = String(fc.hours);
      drawTime();
      if (fc.hours >= max) stopFc();
    }, 450);
  });

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
      return `<button type="button" class="agency-chip" data-agency="${k}" aria-pressed="${isShown(storm, k)}">
        ${shapeSvg(AGENCIES[k].shape, color(k), 12, 0)}${esc(AGENCIES[k].name)}${stale}</button>`;
    }).join("");
    box.querySelectorAll(".agency-chip").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.agency;
      // 正在用替代機構時，先把它算成已勾選，再切換點的那一個
      const shown = shownAgencies(storm);
      shown.forEach((x) => state.enabled.add(x));
      state.agencyTouched = true;
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
      render();
    }));
    box.querySelectorAll("[data-density]").forEach((b) => b.addEventListener("click", () => {
      state.density = b.dataset.density;
      render();
    }));
  }

  let chart = null;
  function renderChart(storm) {
    const datasets = AGENCY_ORDER.filter((k) => storm.agencies[k] && isShown(storm, k)).map((k) => ({
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
    if (state.prevCount) {
      for (const k of AGENCY_ORDER) {
        const a = storm.agencies[k];
        if (!a || !isShown(storm, k)) continue;
        const reports = previousReports(a);
        reports.forEach((h, i) => {
          const alpha = Math.round(prevOpacity(i, reports.length) * 255).toString(16).padStart(2, "0");
          datasets.push({
            label: `${AGENCIES[k].name} 前 ${i + 1} 報（${fmt(h.issued)}）`,
            prev: true,
            data: h.points.map((p) => ({ x: Date.parse(p.time), y: wind(p.vmax_kt, p.vmax_ms), p })).filter((d) => d.y != null),
            borderColor: color(k) + alpha,
            backgroundColor: color(k) + alpha,
            borderWidth: 1.5,
            borderDash: [3, 4],
            pointRadius: 0,
            pointHoverRadius: 4,
            tension: 0,
          });
        });
      }
    }
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
        legend: { labels: { color: text2, usePointStyle: true, boxHeight: 8, filter: (item, data) => !data.datasets[item.datasetIndex].prev } },
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
    const agencies = AGENCY_ORDER.filter((k) => storm.agencies[k] && isShown(storm, k));
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
      drawPrevious(sel);  // 前幾報在最下面
      drawModels(sel);  // 先畫模式，官方路徑疊在上面
      selBounds = drawStorm(sel, true);
    }
    if (!sel) intensityLegend = false;
    drawDensity(state.models ? sel : null);

    updateTimeRange(sel);
    drawTime();
    renderLoopBar();

    $("detail").hidden = !sel;
    if (sel) {
      $("detail-title").textContent = stormTitle(sel);
      const mapsHref = `model.html#${encodeURIComponent(sel.key)}`;
      $("model-maps-link").href = mapsHref;
      $("maps-tab").href = mapsHref;
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

  // 選項按鈕組；remember 為 true 時記在瀏覽器，重新整理後保留
  function segmented(id, attr, key, parse = (v) => v, remember = true) {
    const buttons = [...$(id).querySelectorAll(`[data-${attr}]`)];
    const apply = (v) => {
      state[key] = parse(v);
      buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset[attr] === String(v))));
    };
    const saved = remember ? store.get(`tc-${attr}`) : null;
    if (buttons.some((b) => b.dataset[attr] === saved)) apply(saved);
    buttons.forEach((b) => b.addEventListener("click", () => {
      apply(b.dataset[attr]);
      if (remember) store.set(`tc-${attr}`, b.dataset[attr]);
      render();
    }));
  }
  segmented("prev-count", "prev", "prevCount", Number, false);  // 打開網頁時一律關閉
  segmented("track-color", "color", "trackColor");
  for (const [id, key, storeKey] of [["show-ellipse", "showEllipse", "tc-ellipse"], ["show-hours", "showHours", "tc-hours"]]) {
    state[key] = store.get(storeKey) === "on";
    $(id).checked = state[key];
    $(id).addEventListener("change", (e) => {
      state[key] = e.target.checked;
      store.set(storeKey, state[key] ? "on" : "off");
      render();
    });
  }


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
