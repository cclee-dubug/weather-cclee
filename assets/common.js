/* 主頁與模式天氣圖共用：颱風名稱、時間格式、模式裡的系統與颱風的對應。 */
window.TcCommon = (() => {
  "use strict";

  const AGENCY_ORDER = ["cwa", "jma", "jtwc"];

  const fmtTime = new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  const fmt = (iso) => (iso ? fmtTime.format(new Date(iso)) : "—");
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
  // 列表排序用：目前強度，10 分鐘平均的機構優先，沒有才用 JTWC
  function intensity(storm) {
    for (const k of ["cwa", "jma", "jtwc"]) {
      const v = storm.agencies[k]?.points?.[0]?.vmax_kt;
      if (v != null) return v;
    }
    return 0;
  }

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
  // m 是一個模式的資料 { init, storms: [{ name, track | mean | members }] }
  function matchModelStorm(m, storm) {
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

  // localStorage 在無痕模式等情況可能無法使用
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* 忽略 */ } },
  };

  return { AGENCY_ORDER, fmt, esc, stormTitle, stormIds, intensity, distKm, matchModelStorm, store };
})();
