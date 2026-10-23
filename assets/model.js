/* 模式天氣圖：颱風周圍的 GFS、IFS 圖片（目前是去除渦旋的垂直風切），兩個模式依有效時間對齊。 */
(() => {
  "use strict";

  const { fmt, esc, stormTitle, stormIds, intensity, distKm, matchModelStorm } = TcCommon;

  const DATA_URL = "data/latest.json";
  // 圖片由 fetch-models workflow 產生，存在 model-maps 分支（每次強制推送、只留最新一版）
  const MAPS_BASE = "https://raw.githubusercontent.com/cclee-dubug/weather-cclee/model-maps";
  const REFRESH_MS = 10 * 60 * 1000;
  const PLAY_MS = 800;
  const MODELS = {
    gfs: { name: "NCEP GFS", short: "GFS", family: "ncep" },
    ifs: { name: "ECMWF IFS", short: "IFS", family: "ecmwf" },
  };
  const COMPASS = ["北", "東北", "東", "東南", "南", "西南", "西", "西北"];

  const state = { data: null, index: null, dataFailed: false, indexFailed: false, selected: null, time: null, timer: null };
  let chart = null;
  const preloaded = new Set();

  const $ = (id) => document.getElementById(id);
  const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const imgUrl = (f) => `${MAPS_BASE}/${f.img}`;
  const label = (ms) => (ms.name && ms.name !== ms.id ? `${ms.name}（${ms.id}）` : ms.id);

  // 兩個模式的系統在同一有效時間相距 400 公里內，就當成同一個
  function near(a, b) {
    for (const f of a.frames) {
      const g = b.frames.find((x) => x.valid === f.valid);
      if (g) return distKm(f.lat, f.lon, g.lat, g.lon) <= 400;
    }
    return false;
  }

  // 選單：每個官方颱風一項；兩個模式都對不上官方颱風的系統（例如還沒編號的擾動）另列
  function entries() {
    const list = [];
    const used = new Set();
    const storms = [...(state.data?.storms || [])].sort((a, b) => intensity(b) - intensity(a));
    for (const s of storms) {
      const models = {};
      for (const code of Object.keys(MODELS)) {
        const ms = matchModelStorm(state.index?.models?.[code], s);
        if (ms) { models[code] = ms; used.add(ms); }
      }
      list.push({ key: s.key, title: stormTitle(s), sub: stormIds(s), models });
    }
    const rest = (code) => (state.index?.models?.[code]?.storms || []).filter((ms) => ms.frames?.length && !used.has(ms));
    const ifsRest = rest("ifs");
    for (const g of rest("gfs")) {
      const i = ifsRest.find((x) => !used.has(x) && near(g, x));
      if (i) used.add(i);
      list.push({ key: `gfs-${g.id}`, title: `模式中的系統 ${label(g)}`, sub: "官方尚未發布", models: { gfs: g, ...(i && { ifs: i }) } });
    }
    for (const i of ifsRest.filter((x) => !used.has(x))) {
      list.push({ key: `ifs-${i.id}`, title: `模式中的系統 ${label(i)}`, sub: "官方尚未發布", models: { ifs: i } });
    }
    return list;
  }

  const timesOf = (entry) => [...new Set(Object.values(entry.models).flatMap((ms) => ms.frames.map((f) => Date.parse(f.valid))))]
    .sort((a, b) => a - b);

  function nearest(times, t) {
    return times.reduce((best, x) => (Math.abs(x - t) < Math.abs(best - t) ? x : best), times[0]);
  }

  function preload(entry) {
    for (const ms of Object.values(entry.models)) {
      for (const f of ms.frames) {
        const u = imgUrl(f);
        if (preloaded.has(u)) continue;
        preloaded.add(u);
        new Image().src = u;
      }
    }
  }

  function renderStatus() {
    const parts = [];
    if (state.indexFailed && !state.index) parts.push("天氣圖載入失敗，稍後自動重試");
    for (const [code, meta] of Object.entries(MODELS)) {
      const m = state.index?.models?.[code];
      if (m?.init) parts.push(`<span>${meta.short} ${fmt(m.init)} 起報${m.complete === false ? "（部分時段缺圖）" : ""}</span>`);
    }
    if (state.index?.updated_at) parts.push(`<span>圖更新於 ${fmt(state.index.updated_at)}</span>`);
    $("status").innerHTML = parts.join("") || "載入中…";
  }

  function renderTabs(list) {
    $("storm-tabs").innerHTML = list.map((e) => `<button type="button" class="storm-tab" data-key="${esc(e.key)}" aria-pressed="${e.key === state.selected}">
      <span class="name">${esc(e.title)}</span>${e.sub ? `<span class="ids">${esc(e.sub)}</span>` : ""}</button>`).join("");
    $("storm-tabs").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      state.selected = b.dataset.key;
      history.replaceState(null, "", `#${encodeURIComponent(state.selected)}`);
      render();
    }));
  }

  function renderPanel(code, entry) {
    const panel = document.querySelector(`.map-panel[data-model="${code}"]`);
    const ms = entry.models[code];
    const m = state.index?.models?.[code];
    const f = ms?.frames.find((x) => Date.parse(x.valid) === state.time);
    const img = panel.querySelector("img");
    const ph = panel.querySelector(".placeholder");
    panel.querySelector(".sub").textContent = m?.init ? `${fmt(m.init)} 起報${f ? `　+${f.tau} 小時` : ""}` : "";
    if (f) {
      if (img.getAttribute("src") !== imgUrl(f)) img.src = imgUrl(f);
      img.alt = `${MODELS[code].short} ${label(ms)} +${f.tau} 小時的 200–850 hPa 垂直風切圖`;
      img.hidden = false;
      ph.hidden = true;
      const dir = COMPASS[Math.round(f.shear_from / 45) % 8];
      panel.querySelector(".summary").innerHTML =
        `中心 500 公里內平均風切 <b>${Math.round(f.shear_kt)} kt</b>，${dir}風切（來自 ${String(f.shear_from).padStart(3, "0")}°）`;
    } else {
      img.hidden = true;
      img.removeAttribute("src");
      ph.hidden = false;
      ph.textContent = !m ? "這個模式的天氣圖還沒產生"
        : !ms ? `${MODELS[code].short} 沒有追蹤到這個颱風`
        : `這個時間沒有 ${MODELS[code].short} 的圖（只畫到起報後 120 小時，或模式中颱風已消散）`;
      panel.querySelector(".summary").textContent = "";
    }
  }

  // 圖表上標出目前顯示的時間
  const cursorPlugin = {
    id: "cursor",
    afterDatasetsDraw(c) {
      if (state.time == null) return;
      const x = c.scales.x.getPixelForValue(state.time);
      const { top, bottom } = c.chartArea;
      const ctx = c.ctx;
      ctx.save();
      ctx.strokeStyle = css("--text-2");
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
      ctx.restore();
    },
  };

  function renderChart(entry, times) {
    const datasets = Object.entries(entry.models).map(([code, ms]) => ({
      label: MODELS[code].name,
      data: ms.frames.map((f) => ({ x: Date.parse(f.valid), y: f.shear_kt, f })),
      borderColor: css(`--model-${MODELS[code].family}`),
      backgroundColor: css(`--model-${MODELS[code].family}`),
      borderWidth: 2, pointRadius: 3, pointHoverRadius: 5, tension: 0,
    }));
    $("trend").hidden = !datasets.length;
    if (!datasets.length) return;
    const grid = css("--grid"), muted = css("--muted"), text2 = css("--text-2");
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "nearest", axis: "x", intersect: false },
      onClick: (ev, els, c) => {
        const x = c.scales.x.getValueForPixel(ev.x);
        state.time = nearest(times, x);
        stop();
        render();
      },
      scales: {
        x: {
          type: "linear", min: times[0], max: times[times.length - 1], grid: { color: grid }, border: { color: grid },
          ticks: { color: muted, stepSize: 24 * 3600e3, callback: (v) => fmt(new Date(v).toISOString()).split(" ")[0] },
        },
        y: {
          beginAtZero: true, suggestedMax: 40, grid: { color: grid }, border: { display: false },
          ticks: { color: muted, stepSize: 10 }, title: { display: true, text: "kt", color: muted },
        },
      },
      plugins: {
        legend: { labels: { color: text2, boxHeight: 2, boxWidth: 16 } },
        tooltip: {
          callbacks: {
            title: (items) => fmt(new Date(items[0].parsed.x).toISOString()),
            label: (item) => `${item.dataset.label}：${Math.round(item.parsed.y)} kt（+${item.raw.f.tau} 小時）`,
          },
        },
      },
    };
    if (chart) chart.destroy();
    chart = new Chart($("shear-chart"), { type: "line", data: { datasets }, options: opts, plugins: [cursorPlugin] });
  }

  function render() {
    renderStatus();
    const list = entries();
    if (!list.some((e) => e.key === state.selected)) state.selected = list[0]?.key ?? null;
    renderTabs(list);
    const entry = list.find((e) => e.key === state.selected);
    const times = entry ? timesOf(entry) : [];

    const empty = $("maps-empty");
    empty.hidden = times.length > 0;
    if (!state.data && !state.index) empty.textContent = "資料載入失敗，稍後自動重試";
    else if (!entry) empty.textContent = "目前西北太平洋沒有活躍的熱帶氣旋";
    else empty.textContent = "模式還沒有這個颱風的天氣圖，新的起報產生後會自動出現";
    $("time-bar").hidden = !times.length;
    $("maps-grid").hidden = !times.length;
    if (!times.length) {
      $("trend").hidden = true;
      stop();
      return;
    }

    if (state.time == null || !times.includes(state.time)) state.time = nearest(times, state.time ?? Date.now());
    const i = times.indexOf(state.time);
    const range = $("time");
    range.max = String(times.length - 1);
    range.value = String(i);
    const taus = Object.entries(entry.models).map(([code, ms]) => {
      const f = ms.frames.find((x) => Date.parse(x.valid) === state.time);
      return f ? `${MODELS[code].short} +${f.tau}h` : null;
    }).filter(Boolean);
    $("time-label").innerHTML = `<b>${fmt(new Date(state.time).toISOString())}</b>（台灣時間）<span class="muted">${taus.join("　")}</span>`;
    $("prev").disabled = i === 0;
    $("next").disabled = i === times.length - 1;

    for (const code of Object.keys(MODELS)) renderPanel(code, entry);
    preload(entry);
    if (chart && chart.$entryKey === entry.key && chart.$times === times.join()) chart.draw();
    else {
      renderChart(entry, times);
      if (chart) { chart.$entryKey = entry.key; chart.$times = times.join(); }
    }
  }

  function step(d) {
    const entry = entries().find((e) => e.key === state.selected);
    if (!entry) return;
    const times = timesOf(entry);
    const i = times.indexOf(state.time);
    state.time = times[Math.max(0, Math.min(times.length - 1, i + d))];
    render();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    $("play").textContent = "▶ 播放";
    $("play").setAttribute("aria-label", "播放");
  }
  function play() {
    $("play").textContent = "❚❚ 暫停";
    $("play").setAttribute("aria-label", "暫停");
    state.timer = setInterval(() => {
      const entry = entries().find((e) => e.key === state.selected);
      if (!entry) return stop();
      const times = timesOf(entry);
      const i = times.indexOf(state.time);
      state.time = times[(i + 1) % times.length];
      render();
    }, PLAY_MS);
  }

  $("prev").addEventListener("click", () => { stop(); step(-1); });
  $("next").addEventListener("click", () => { stop(); step(1); });
  $("play").addEventListener("click", () => (state.timer ? stop() : play()));
  $("time").addEventListener("input", (e) => {
    stop();
    const entry = entries().find((x) => x.key === state.selected);
    if (!entry) return;
    state.time = timesOf(entry)[Number(e.target.value)];
    render();
  });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input, textarea, select") || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "ArrowLeft") { stop(); step(-1); e.preventDefault(); }
    if (e.key === "ArrowRight") { stop(); step(1); e.preventDefault(); }
  });

  async function getJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    const [data, index] = await Promise.allSettled([getJson(`${DATA_URL}?t=${Date.now()}`), getJson(`${MAPS_BASE}/index.json`)]);
    if (data.status === "fulfilled") state.data = data.value;
    else console.warn("讀取颱風資料失敗", data.reason);
    if (index.status === "fulfilled") state.index = index.value;
    else console.warn("讀取天氣圖索引失敗", index.reason);
    state.dataFailed = data.status !== "fulfilled";
    state.indexFailed = index.status !== "fulfilled";
    render();
  }

  if (location.hash.length > 1) state.selected = decodeURIComponent(location.hash.slice(1));
  load();
  setInterval(load, REFRESH_MS);
})();
