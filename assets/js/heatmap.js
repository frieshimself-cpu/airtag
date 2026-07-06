/* ============================================================
 * VEDANT // heatmap.js
 * Entity × hour activity matrix. Rows = top entities by 24h
 * notional, columns = the last 24 hourly buckets, cell intensity
 * = USD notional in that bucket (sequential single-hue ramp,
 * light→dark on the dark surface). Hover reads out the cell.
 * Pure DOM grid so it stays crisp and accessible.
 * ============================================================ */

(function () {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();

  /* one-hue sequential ramp keyed 0..1 (blue, near-surface → bright) */
  function ramp(t) {
    const stops = [
      [0.00, [16, 22, 34]],
      [0.20, [26, 60, 110]],
      [0.45, [30, 92, 171]],
      [0.70, [57, 135, 229]],
      [1.00, [134, 182, 239]],
    ];
    let a = stops[0], b = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
    }
    const f = (t - a[0]) / (b[0] - a[0] || 1);
    const c = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * f));
    return `rgb(${c[0]},${c[1]},${c[2]})`;
  }

  const Heatmap = {
    el: null, tip: null,
    init() {
      this.el = document.getElementById("heatmap-grid");
      this.tip = document.getElementById("heatmap-tip");
    },

    render(events) {
      if (!this.el) return;
      const now = Date.now(), H = 3600_000;
      const totals = {};
      for (const e of events) {
        if (now - e.time >= 24 * H) continue;
        totals[e.entity] = (totals[e.entity] || 0) + (e.usd || 0);
      }
      const entities = Object.entries(totals).sort((a, b) => b[1] - a[1]).slice(0, 8).map((x) => x[0]);
      if (!entities.length) { this.el.innerHTML = '<div class="empty-note" style="padding:10px">no activity in window</div>'; return; }

      /* build matrix */
      const idx = Object.fromEntries(entities.map((e, i) => [e, i]));
      const M = entities.map(() => new Array(24).fill(0));
      for (const e of events) {
        const age = now - e.time;
        if (age < 0 || age >= 24 * H) continue;
        if (!(e.entity in idx)) continue;
        M[idx[e.entity]][23 - Math.floor(age / H)] += (e.usd || 0);
      }
      const max = Math.max(1, ...M.flat());

      let html = '<div class="hm-corner"></div>';
      for (let h = 0; h < 24; h++) {
        html += `<div class="hm-col-label">${h % 3 === 0 ? String(new Date(now - (23 - h) * H).getUTCHours()).padStart(2, "0") : ""}</div>`;
      }
      entities.forEach((ent, r) => {
        html += `<div class="hm-row-label" title="${ent}">${ent}</div>`;
        for (let c = 0; c < 24; c++) {
          const v = M[r][c];
          const t = v <= 0 ? 0 : 0.12 + 0.88 * Math.pow(v / max, 0.55);
          const hh = String(new Date(now - (23 - c) * H).getUTCHours()).padStart(2, "0");
          html += `<div class="hm-cell" style="background:${v > 0 ? ramp(t) : "var(--surface-2)"}" data-v="${Math.round(v)}" data-e="${ent}" data-h="${hh}"></div>`;
        }
      });
      this.el.innerHTML = html;

      this.el.onmousemove = (e) => {
        const cell = e.target.closest(".hm-cell");
        if (!cell) { this.tip.hidden = true; return; }
        const usd = +cell.dataset.v;
        this.tip.innerHTML = `<b>${cell.dataset.e}</b> · ${cell.dataset.h}:00 UTC<br>notional <b>$${(usd >= 1e6 ? (usd / 1e6).toFixed(2) + "M" : usd >= 1e3 ? (usd / 1e3).toFixed(1) + "K" : usd)}</b>`;
        const wrap = this.el.getBoundingClientRect();
        let x = e.clientX - wrap.left + 12;
        if (x + 150 > wrap.width) x -= 165;
        this.tip.style.left = x + "px";
        this.tip.style.top = (e.clientY - wrap.top - 8) + "px";
        this.tip.hidden = false;
      };
      this.el.onmouseleave = () => { this.tip.hidden = true; };
    },
  };

  AIRTAG.Heatmap = Heatmap;
})();
