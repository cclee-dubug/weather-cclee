/* 地圖上的點陣圖層：
 * 1. NASA GIBS 的海溫與紅外線圖磚是依色標上色的 PNG。讀回像素、查色標還原成數值（°C），
 *    再用自己的色階重新上色：海溫細分高溫區，紅外線改成 Dvorak BD 強化色階。
 * 2. 系集模式的路徑密度：各成員颱風中心通過某地附近的比例。
 */
(() => {
  "use strict";

  /* ---------- 色標還原 ---------- */

  // assets/colormaps.json 由 tools/gibs_colormap.py 從 GIBS 色標檔產生：[[r, g, b, 數值], ...]
  let colormaps = null;
  function loadColormaps() {
    colormaps ??= fetch("assets/colormaps.json").then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }).then((d) => Object.fromEntries(Object.entries(d).map(([k, v]) => [k, makeDecoder(v.entries)])));
    return colormaps;
  }

  function makeDecoder(entries) {
    entries = [...entries].sort((a, b) => a[3] - b[3]);
    // GIBS 縮放圖磚時會在相鄰像素之間內插，混出色標上沒有的中間色，這些顏色落在「數值相鄰的兩個色標顏色」
    // 之間的線段上，可依位置還原數值
    const segs = entries.slice(1).map((q, k) => [entries[k], q]);
    const cache = new Map();
    // 一個顏色可能對應的所有數值。紅外線色標在 -80～-72 °C 與 -17 °C 以上都用灰階，同一個灰可能是兩種溫度
    function candidates(key) {
      let c = cache.get(key);
      if (c) return c;
      const r = key >> 16, g = (key >> 8) & 255, b = key & 255;
      c = [];
      for (const [p, q] of segs) {
        const dr = q[0] - p[0], dg = q[1] - p[1], db = q[2] - p[2];
        const len2 = dr * dr + dg * dg + db * db;
        const t = len2 ? Math.max(0, Math.min(1, ((r - p[0]) * dr + (g - p[1]) * dg + (b - p[2]) * db) / len2)) : 0;
        const er = p[0] + dr * t - r, eg = p[1] + dg * t - g, eb = p[2] + db * t - b;
        if (er * er + eg * eg + eb * eb <= 3) c.push(p[3] + (q[3] - p[3]) * t);
      }
      if (!c.length) {
        // 不在任何線段上（例如數值相差很多的兩個像素混出的顏色）：取顏色最接近的色標
        let best = Infinity;
        for (const [er, eg, eb, v] of entries) {
          const d = (er - r) ** 2 + (eg - g) ** 2 + (eb - b) ** 2;
          if (d < best) { best = d; c = [v]; }
        }
      }
      cache.set(key, c);
      return c;
    }
    const spread = (c) => Math.max(...c) - Math.min(...c);
    // data：RGBA 像素；回傳每個像素的數值，透明（無資料）為 NaN
    return function decode(data, w, h) {
      const n = w * h;
      const vals = new Float32Array(n).fill(NaN);
      const amb = new Array(n); // 有歧義的像素：候選數值
      let anyAmb = false;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        if (data[o + 3] < 128) continue;
        const c = candidates((data[o] << 16) | (data[o + 1] << 8) | data[o + 2]);
        if (c.length === 1 || spread(c) <= 8) {
          vals[i] = c[0];
        } else {
          amb[i] = c;
          anyAmb = true;
        }
      }
      if (!anyAmb) return vals;
      // 有歧義的像素依相連的區塊一起判斷：看區塊外圍無歧義像素的中位數，每個像素挑最接近的候選。
      // 冷雲核心的灰階外圍是 -64～-72 °C 的暗紅色，晴空區的灰階則連到雲邊 -20 °C 左右的青色
      const comp = new Uint8Array(n);
      const stack = new Int32Array(n);
      for (let s0 = 0; s0 < n; s0++) {
        if (!amb[s0] || comp[s0]) continue;
        let sp = 0;
        stack[sp++] = s0;
        comp[s0] = 1;
        const members = [], border = [];
        while (sp) {
          const i = stack[--sp];
          members.push(i);
          const x = i % w;
          for (const j of [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]) {
            if (j < 0 || j >= n) continue;
            if (amb[j]) {
              if (!comp[j]) { comp[j] = 1; stack[sp++] = j; }
            } else if (!Number.isNaN(vals[j])) {
              border.push(vals[j]);
            }
          }
        }
        border.sort((a, b) => a - b);
        const ref = border.length >= 4 ? border[border.length >> 1] : NaN;
        for (const i of members) {
          const c = amb[i];
          // 整塊都沒有參考時視為較暖的那個（大片晴空遠比大片冷雲常見）
          vals[i] = Number.isNaN(ref) ? Math.max(...c) : c.reduce((a, b) => (Math.abs(b - ref) < Math.abs(a - ref) ? b : a));
        }
      }
      return vals;
    };
  }

  /* ---------- 色階 ---------- */

  // 畫布像素以 Uint32 一次寫入（小端序：A B G R）
  const pack = (r, g, b, a = 255) => ((a << 24) | (b << 16) | (g << 8) | r) >>> 0;
  function makeLut(fn, min, max, step) {
    const n = Math.round((max - min) / step) + 1;
    const lut = new Uint32Array(n);
    for (let i = 0; i < n; i++) lut[i] = pack(...fn(min + i * step));
    return (v) => lut[Math.max(0, Math.min(n - 1, Math.round((v - min) / step)))];
  }
  const lerp = (a, b, t) => a.map((x, i) => Math.round(x + (b[i] - x) * t));
  function ramp(stops) {
    return (v) => {
      if (v <= stops[0][0]) return stops[0][1];
      for (let i = 1; i < stops.length; i++) {
        const [t1, c1] = stops[i];
        if (v < t1) {
          const [t0, c0] = stops[i - 1];
          return lerp(c0, c1, (v - t0) / (t1 - t0));
        }
      }
      return stops[stops.length - 1][1];
    };
  }

  // 海溫：26 °C 以上（颱風發展門檻）由黃轉橘、紅、粉紅，高溫區分得比較細
  const SST_MIN = 0, SST_MAX = 33;
  const sstRgb = ramp([
    [0, [255, 255, 255]], [10, [0, 24, 215]], [20, [116, 234, 219]], [25.99, [11, 183, 0]],
    [26, [255, 255, 0]], [30, [197, 0, 0]], [33, [240, 152, 213]],
  ]);
  const SST_TICKS = [0, 10, 20, 26, 30];

  // Dvorak BD 強化：9 °C 以下分段上灰階，越冷（雲頂越高）的對流在黑白之間交替，方便判讀颱風強度
  const BD_STEPS = [
    // [下界 °C, 灰階或 [較暖端灰階, 較冷端灰階]]
    [9, [224, 0]], // 9 °C 以上：越暖越黑（28 °C 以上全黑）
    [-30, [98, 180]],
    [-41, 56],
    [-53, 98],
    [-63, 141],
    [-69, 0],
    [-75, 225],
    [-80, 119],
    [-Infinity, [87, 250]], // -80 °C 以下：越冷越白（-90 °C 以下全白）
  ];
  function bdGray(t) {
    if (t >= 9) return Math.max(0, Math.round(224 - 11.8 * (t - 9)));
    if (t > -30) return Math.round(98 + 2.1 * (9 - t));
    for (const [lo, g] of BD_STEPS.slice(2, 8)) if (t > lo) return g;
    return Math.min(250, Math.round(87 + 16.3 * (-80 - t)));
  }
  const bdRgb = (t) => { const g = bdGray(t); return [g, g, g]; };

  /* ---------- 重新上色的圖磚圖層 ---------- */

  // options.url：{z}/{x}/{y} 樣板；options.decoder：colormaps 的名稱；options.paint：數值 → 打包的 RGBA
  const ValueTileLayer = L.GridLayer.extend({
    createTile(coords, done) {
      const size = this.getTileSize();
      const tile = document.createElement("canvas");
      tile.width = size.x;
      tile.height = size.y;
      loadColormaps().then((maps) => {
        const img = new Image();
        img.crossOrigin = "anonymous"; // GIBS 有開放跨網域，才能讀回像素
        img.onload = () => {
          try {
            const ctx = tile.getContext("2d", { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, tile.width, tile.height);
            const im = ctx.getImageData(0, 0, tile.width, tile.height);
            const vals = maps[this.options.decoder](im.data, tile.width, tile.height);
            const out = new Uint32Array(im.data.buffer);
            const paint = this.options.paint;
            for (let i = 0; i < vals.length; i++) out[i] = Number.isNaN(vals[i]) ? 0 : paint(vals[i]);
            ctx.putImageData(im, 0, 0);
            done(null, tile);
          } catch (e) {
            done(e, tile);
          }
        };
        img.onerror = () => done(new Error("圖磚載入失敗"), tile);
        img.src = L.Util.template(this.options.url, coords);
      }, (e) => done(e, tile));
      return tile;
    },
  });

  const sstPaint = makeLut(sstRgb, -1, 34, 0.05);
  const bdPaint = makeLut(bdRgb, -100, 60, 0.1);
  const sstLayer = (url, opts) => new ValueTileLayer({ ...opts, url, decoder: "sst", paint: sstPaint });
  const bdLayer = (url, opts) => new ValueTileLayer({ ...opts, url, decoder: "ir", paint: bdPaint });

  // 色標圖片：左到右依序取色
  const barCache = new Map();
  function legendBar(key, fn, from, to, width = 240) {
    if (barCache.has(key)) return barCache.get(key);
    const c = document.createElement("canvas");
    c.width = width;
    c.height = 1;
    const ctx = c.getContext("2d");
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = `rgb(${fn(from + (to - from) * (x + 0.5) / width).join(",")})`;
      ctx.fillRect(x, 0, 1, 1);
    }
    const url = c.toDataURL();
    barCache.set(key, url);
    return url;
  }
  function sstLegendHtml() {
    const bar = legendBar("sst", sstRgb, SST_MIN, SST_MAX);
    const ticks = SST_TICKS.map((t) => {
      const cls = t === SST_MIN ? ' class="start"' : t === SST_MAX ? ' class="end"' : "";
      return `<span${cls} style="left:${(t - SST_MIN) / (SST_MAX - SST_MIN) * 100}%">${t}</span>`;
    }).join("");
    return `<div class="scale"><img class="bar" src="${bar}" alt=""><div class="ticks">${ticks}</div></div>`;
  }
  // BD 色標每一段等寬（實際溫度範圍差很多，照比例畫會擠在一起），分段處標溫度
  function bdLegendHtml() {
    const seg = (fn, a, b, key) => `<img class="seg" src="${legendBar(key, fn, a, b, 24)}" alt="">`;
    const segs = [
      seg(bdRgb, 28, 9.01, "bd0"), seg(bdRgb, 9, -29.99, "bd1"),
      ...[-35, -47, -58, -66, -72, -77].map((t, i) => seg(bdRgb, t, t, `bd${i + 2}`)),
      seg(bdRgb, -80.01, -90, "bd8"),
    ].join("");
    const n = BD_STEPS.length;
    const ticks = BD_STEPS.slice(0, n - 1).map(([t], i) => `<span style="left:${(i + 1) / n * 100}%">${t}</span>`).join("");
    return `<div class="scale"><div class="bar segs">${segs}</div><div class="ticks">${ticks}</div></div>`;
  }

  /* ---------- 系集路徑密度 ---------- */

  const DENSITY_RADIUS_KM = 120;
  const DENSITY_CELL = 0.2; // 度
  // 各成員颱風中心是否通過格點 120 公里內，統計通過的成員比例（與 ECMWF 侵襲機率的定義相同）
  function trackDensity(tracks, total) {
    tracks = tracks.filter((t) => t?.length);
    if (!tracks.length) return null;
    let latMin = 90, latMax = -90, lonMin = 360, lonMax = -360;
    for (const t of tracks) {
      for (const p of t) {
        latMin = Math.min(latMin, p[1]); latMax = Math.max(latMax, p[1]);
        lonMin = Math.min(lonMin, p[2]); lonMax = Math.max(lonMax, p[2]);
      }
    }
    const kmLat = 111.2;
    const padLat = DENSITY_RADIUS_KM / kmLat + DENSITY_CELL;
    const padLon = DENSITY_RADIUS_KM / (kmLat * Math.cos(Math.min(80, Math.max(Math.abs(latMin), Math.abs(latMax)) + padLat) * Math.PI / 180)) + DENSITY_CELL;
    const lat0 = Math.floor((latMin - padLat) / DENSITY_CELL) * DENSITY_CELL;
    const lon0 = Math.floor((lonMin - padLon) / DENSITY_CELL) * DENSITY_CELL;
    const nLat = Math.ceil((latMax + padLat - lat0) / DENSITY_CELL) + 1;
    const nLon = Math.ceil((lonMax + padLon - lon0) / DENSITY_CELL) + 1;
    const count = new Uint16Array(nLat * nLon);
    const stamp = new Int32Array(nLat * nLon).fill(-1);
    const r2 = DENSITY_RADIUS_KM ** 2;

    function mark(lat, lon, m) {
      const cos = Math.cos(lat * Math.PI / 180);
      const dLat = DENSITY_RADIUS_KM / kmLat, dLon = DENSITY_RADIUS_KM / (kmLat * cos);
      const i0 = Math.max(0, Math.ceil((lat - dLat - lat0) / DENSITY_CELL));
      const i1 = Math.min(nLat - 1, Math.floor((lat + dLat - lat0) / DENSITY_CELL));
      const j0 = Math.max(0, Math.ceil((lon - dLon - lon0) / DENSITY_CELL));
      const j1 = Math.min(nLon - 1, Math.floor((lon + dLon - lon0) / DENSITY_CELL));
      for (let i = i0; i <= i1; i++) {
        const dy = (lat0 + i * DENSITY_CELL - lat) * kmLat;
        for (let j = j0; j <= j1; j++) {
          const dx = (lon0 + j * DENSITY_CELL - lon) * kmLat * cos;
          const k = i * nLon + j;
          if (dx * dx + dy * dy <= r2 && stamp[k] !== m) {
            stamp[k] = m;
            count[k]++;
          }
        }
      }
    }
    tracks.forEach((t, m) => {
      mark(t[0][1], t[0][2], m);
      for (let s = 1; s < t.length; s++) {
        const [, la0, lo0] = t[s - 1], [, la1, lo1] = t[s];
        const km = Math.hypot((la1 - la0) * kmLat, (lo1 - lo0) * kmLat * Math.cos((la0 + la1) / 2 * Math.PI / 180));
        const steps = Math.max(1, Math.ceil(km / 20)); // 每 20 公里取一點
        for (let k = 1; k <= steps; k++) mark(la0 + (la1 - la0) * k / steps, lo0 + (lo1 - lo0) * k / steps, m);
      }
    });
    const prob = new Float32Array(nLat * nLon);
    const n = Math.max(total, tracks.length);
    for (let k = 0; k < prob.length; k++) prob[k] = count[k] / n;
    return { lat0, lon0, nLat, nLon, cell: DENSITY_CELL, prob, members: n };
  }

  // 分級：5–10、10–20、20–40、40–60、60–80、80–100%
  const DENSITY_BINS = [0.05, 0.1, 0.2, 0.4, 0.6, 0.8];
  const DENSITY_ALPHA = [0.45, 0.55, 0.65, 0.72, 0.8, 0.86];
  // 單一色相由淺到深，與該模式的路徑同色系
  const DENSITY_RAMPS = {
    ncep: ["#fcd1dc", "#efa6ba", "#df7a9a", "#c94f7b", "#a72f5e", "#7f1843"],
    ecmwf: ["#d9dbfc", "#b6b7f6", "#9492ec", "#766fdb", "#5b50ba", "#41378f"],
  };
  const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

  const DensityLayer = L.GridLayer.extend({
    createTile(coords) {
      const size = this.getTileSize();
      const tile = document.createElement("canvas");
      tile.width = size.x;
      tile.height = size.y;
      const g = this.options.grid;
      const colors = DENSITY_RAMPS[this.options.family].map((h, i) => pack(...hexRgb(h), Math.round(DENSITY_ALPHA[i] * 255)));
      const world = size.x * 2 ** coords.z;
      const ctx = tile.getContext("2d");
      const im = ctx.createImageData(size.x, size.y);
      const out = new Uint32Array(im.data.buffer);
      const fj = new Float32Array(size.x);
      for (let x = 0; x < size.x; x++) {
        let lon = ((coords.x * size.x + x + 0.5) / world) * 360 - 180;
        if (lon < g.lon0 - 1) lon += 360; // 換日線以東
        fj[x] = (lon - g.lon0) / g.cell;
      }
      let any = false;
      for (let y = 0; y < size.y; y++) {
        const yy = Math.PI * (1 - 2 * (coords.y * size.y + y + 0.5) / world);
        const lat = Math.atan(Math.sinh(yy)) * 180 / Math.PI;
        const fi = (lat - g.lat0) / g.cell;
        if (fi < 0 || fi > g.nLat - 1) continue;
        const i0 = Math.min(g.nLat - 2, Math.floor(fi)), ti = fi - i0;
        for (let x = 0; x < size.x; x++) {
          const f = fj[x];
          if (f < 0 || f > g.nLon - 1) continue;
          const j0 = Math.min(g.nLon - 2, Math.floor(f)), tj = f - j0;
          const k = i0 * g.nLon + j0;
          const p = (g.prob[k] * (1 - tj) + g.prob[k + 1] * tj) * (1 - ti) +
            (g.prob[k + g.nLon] * (1 - tj) + g.prob[k + g.nLon + 1] * tj) * ti;
          if (p < DENSITY_BINS[0]) continue;
          let b = DENSITY_BINS.length - 1;
          while (p < DENSITY_BINS[b]) b--;
          out[y * size.x + x] = colors[b];
          any = true;
        }
      }
      if (any) ctx.putImageData(im, 0, 0);
      return tile;
    },
  });

  function densityLegendHtml(family) {
    const labels = ["5", "10", "20", "40", "60", "80"];
    return `<div class="density-scale">` + DENSITY_RAMPS[family].map((h, i) =>
      `<span><i style="background:${h};opacity:${DENSITY_ALPHA[i] + 0.1}"></i>${labels[i]}</span>`).join("") +
      `<span class="unit">%</span></div>`;
  }

  window.TcRaster = {
    sstLayer, bdLayer, sstLegendHtml, bdLegendHtml,
    trackDensity, DensityLayer, densityLegendHtml, DENSITY_RADIUS_KM,
    // 除錯用
    _internal: { makeDecoder, bdGray, sstRgb },
  };
})();
