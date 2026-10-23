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

  const state = {
    data: null,
    selected: null,
    unit: "kt",
    enabled: new Set(AGENCY_ORDER),
    showPast: true,
    showCone: false,
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
  // 圖層順序（由下到上）：背景圖磚 200 → 衛星雲圖、海溫 300 → 地名標註 450 → 路徑。
  // 各自放在獨立的 pane，切換背景時新加入的圖磚才不會蓋住海溫
  map.createPane("sst");
  map.getPane("sst").style.zIndex = 300;
  map.getPane("sst").style.pointerEvents = "none";
  map.createPane("labels");
  map.getPane("labels").style.zIndex = 450;
  map.getPane("labels").style.pointerEvents = "none";
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

  // 海表面溫度：NASA GIBS 的 GHRSST MUR 每日海溫圖磚，日期與網址樣板由 data/latest.json 提供
  const sstGroup = L.layerGroup();
  let sstInfo = null;
  let sstTiles = null;
  const SST_NAME = "海表面溫度";
  L.control.layers(
    Object.fromEntries(Object.values(BASEMAPS)), { [SST_NAME]: sstGroup },
    { position: "topright", collapsed: false },
  ).addTo(map);
  if (store.get("tc-sst") !== "off") sstGroup.addTo(map);

  map.on("baselayerchange", (e) => {
    store.set("tc-basemap", Object.keys(BASEMAPS).find((k) => BASEMAPS[k][1] === e.layer));
  });
  map.on("overlayadd overlayremove", (e) => {
    if (e.layer === sstGroup) {
      store.set("tc-sst", e.type === "overlayadd" ? "on" : "off");
      renderSstLegend();
    }
  });

  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => render());

  const sstLegend = L.control({ position: "bottomleft" });
  sstLegend.onAdd = () => {
    const div = L.DomUtil.create("div", "sst-legend");
    L.DomEvent.disableClickPropagation(div);
    return div;
  };
  sstLegend.addTo(map);

  function updateSst(info) {
    if (!info || info.status !== "ok" || !info.template || !info.date) {
      sstInfo = null;
      sstGroup.clearLayers();
      sstTiles = null;
      renderSstLegend();
      return;
    }
    const url = info.template
      .replace("{Time}", info.date)
      .replace("{TileMatrixSet}", info.tile_matrix_set)
      .replace("{TileMatrix}", "{z}")
      .replace("{TileRow}", "{y}")
      .replace("{TileCol}", "{x}");
    if (!sstTiles) {
      sstTiles = L.tileLayer(url, {
        pane: "sst",
        opacity: 0.7,
        maxNativeZoom: info.max_zoom || 7,
        bounds: [[-85, -180], [85, 180]],
        attribution: '海溫：<a href="https://www.earthdata.nasa.gov/gibs">NASA GIBS</a> / JPL MUR',
      });
      sstGroup.addLayer(sstTiles);
    } else if (sstTiles._url !== url) {
      sstTiles.setUrl(url);
    }
    sstInfo = info;
    renderSstLegend();
  }

  function renderSstLegend() {
    const div = sstLegend.getContainer();
    const on = map.hasLayer(sstGroup);
    div.hidden = !on;
    if (!on) return;
    if (!sstInfo) {
      div.innerHTML = `<b>${SST_NAME}</b><div class="muted">目前無法取得海溫資料</div>`;
      return;
    }
    const [y, m, d] = sstInfo.date.split("-");
    div.innerHTML = `<b>${SST_NAME}</b> <span class="muted">${Number(m)}/${Number(d)}（${y}）日分析</span>` +
      (sstInfo.legend ? `<img src="${esc(sstInfo.legend)}" alt="海溫色標，0 到 32 °C" onerror="this.remove()">` : "") +
      `<div class="muted">海溫約 26.5 °C 以上有利颱風發展或維持強度</div>`;
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
    if (sel) selBounds = drawStorm(sel, true);

    $("detail").hidden = !sel;
    if (sel) {
      $("detail-title").textContent = stormTitle(sel);
      renderToggles(sel);
      renderChart(sel);
      renderTable(sel);
      if (fit && selBounds.length) map.fitBounds(selBounds, { padding: [40, 40], maxZoom: 6 });
    }
  }

  async function load(first = false) {
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
