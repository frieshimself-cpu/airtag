/* ============================================================
 * AIRTAG // charts.js
 * Custom canvas renderers — no external chart libs.
 *  - Netflow: diverging hourly bars (inflow up / outflow down)
 *    in USD notional with a cumulative net line; crosshair +
 *    tooltip.
 *  - Throughput: real network TPS line from
 *    getRecentPerformanceSamples (100% chain telemetry).
 *  - Exposure: horizontal magnitude bars (DOM, single hue).
 * ============================================================ */

(function () {
  const CSS = getComputedStyle(document.documentElement);
  const col = (name) => CSS.getPropertyValue(name).trim();

  function setupHiDPI(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w: rect.width, h: rect.height };
  }

  const fmtUsdShort = (v) => {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(1) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(0) + "K";
    return Math.round(v).toString();
  };

  function roundedBarUp(ctx, x, yBase, w, h) {
    const r = Math.min(4, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, yBase);
    ctx.lineTo(x, yBase - h + r);
    ctx.arcTo(x, yBase - h, x + r, yBase - h, r);
    ctx.lineTo(x + w - r, yBase - h);
    ctx.arcTo(x + w, yBase - h, x + w, yBase - h + r, r);
    ctx.lineTo(x + w, yBase);
    ctx.closePath(); ctx.fill();
  }
  function roundedBarDown(ctx, x, yBase, w, h) {
    const r = Math.min(4, w / 2, h);
    ctx.beginPath();
    ctx.moveTo(x, yBase);
    ctx.lineTo(x, yBase + h - r);
    ctx.arcTo(x, yBase + h, x + r, yBase + h, r);
    ctx.lineTo(x + w - r, yBase + h);
    ctx.arcTo(x + w, yBase + h, x + w, yBase + h - r, r);
    ctx.lineTo(x + w, yBase);
    ctx.closePath(); ctx.fill();
  }

  /* ---------------- NETFLOW (USD notional) ---------------- */

  const Netflow = {
    canvas: null, tip: null,
    buckets: [],       // [{t, inflow, outflow}] hourly USD, oldest→newest
    _hoverIdx: -1,

    init() {
      this.canvas = document.getElementById("netflow-canvas");
      this.tip = document.getElementById("netflow-tip");
      this.canvas.addEventListener("mousemove", (e) => this._onMove(e));
      this.canvas.addEventListener("mouseleave", () => { this._hoverIdx = -1; this.tip.hidden = true; this.draw(); });
      window.addEventListener("resize", () => this.draw());
    },

    setData(events) {
      const now = Date.now();
      const H = 3600_000;
      const buckets = [];
      for (let i = 23; i >= 0; i--) buckets.push({ t: now - i * H, inflow: 0, outflow: 0 });
      for (const ev of events) {
        const age = now - ev.time;
        if (age < 0 || age >= 24 * H) continue;
        const b = buckets[23 - Math.floor(age / H)];
        if (!b) continue;
        const usd = ev.usd || 0;
        if (ev.dir === "IN") b.inflow += usd;
        else if (ev.dir === "OUT") b.outflow += usd;
        else { b.inflow += usd * 0.5; b.outflow += usd * 0.5; } // SWAP pass-through
      }
      this.buckets = buckets;
      this.draw();
    },

    _geom() {
      const rect = this.canvas.getBoundingClientRect();
      const padL = 50, padR = 10, padT = 10, padB = 20;
      return { rect, padL, padR, padT, padB, plotW: rect.width - padL - padR, plotH: rect.height - padT - padB };
    },

    draw() {
      if (!this.canvas) return;
      const { ctx, w, h } = setupHiDPI(this.canvas);
      const { padL, padT, plotW, plotH } = this._geom();
      const B = this.buckets;
      ctx.clearRect(0, 0, w, h);
      if (!B.length) return;

      const maxV = Math.max(1, ...B.map((b) => Math.max(b.inflow, b.outflow)));
      const midY = padT + plotH / 2;
      const scale = (plotH / 2 - 6) / maxV;
      const step = plotW / B.length;
      const barW = Math.max(3, step * 0.52);

      ctx.strokeStyle = col("--grid-line") || "rgba(255,255,255,0.05)";
      ctx.fillStyle = col("--ink-muted");
      ctx.font = "9px " + col("--mono");
      ctx.lineWidth = 1;
      [-1, -0.5, 0.5, 1].forEach((f) => {
        const y = midY - f * maxV * scale;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText((f > 0 ? "+$" : "−$") + fmtUsdShort(Math.abs(f) * maxV), padL - 6, y + 3);
      });

      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath(); ctx.moveTo(padL, midY); ctx.lineTo(padL + plotW, midY); ctx.stroke();

      const cIn = col("--c-inflow"), cOut = col("--c-outflow");
      B.forEach((b, i) => {
        const x = padL + i * step + (step - barW) / 2;
        const dim = this._hoverIdx >= 0 && this._hoverIdx !== i;
        ctx.globalAlpha = dim ? 0.35 : 1;
        if (b.inflow > 0) { ctx.fillStyle = cIn; roundedBarUp(ctx, x, midY - 1, barW, Math.max(2, b.inflow * scale)); }
        if (b.outflow > 0) { ctx.fillStyle = cOut; roundedBarDown(ctx, x, midY + 1, barW, Math.max(2, b.outflow * scale)); }
        ctx.globalAlpha = 1;
      });

      /* cumulative net line */
      ctx.strokeStyle = col("--c-net");
      ctx.lineWidth = 2;
      ctx.beginPath();
      let cum = 0;
      const cums = B.map((b) => (cum += b.inflow - b.outflow));
      const maxCum = Math.max(1, ...cums.map(Math.abs));
      cums.forEach((v, i) => {
        const x = padL + i * step + step / 2;
        const y = midY - (v / maxCum) * (plotH / 2 - 10);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      ctx.fillStyle = col("--ink-muted");
      ctx.textAlign = "center";
      B.forEach((b, i) => {
        if (i % 4 !== 0) return;
        const d = new Date(b.t);
        ctx.fillText(String(d.getUTCHours()).padStart(2, "0") + ":00",
          padL + i * step + step / 2, padT + plotH + 14);
      });

      if (this._hoverIdx >= 0) {
        const x = padL + this._hoverIdx * step + step / 2;
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        ctx.setLineDash([]);
      }
    },

    _onMove(e) {
      const { rect, padL, plotW } = this._geom();
      const x = e.clientX - rect.left;
      const idx = Math.floor(((x - padL) / plotW) * this.buckets.length);
      if (idx < 0 || idx >= this.buckets.length) { this._hoverIdx = -1; this.tip.hidden = true; this.draw(); return; }
      if (idx !== this._hoverIdx) {
        this._hoverIdx = idx;
        this.draw();
        const b = this.buckets[idx];
        const hh = String(new Date(b.t).getUTCHours()).padStart(2, "0");
        const net = b.inflow - b.outflow;
        this.tip.innerHTML =
          `<b>${hh}:00 UTC</b><br>` +
          `inflow&nbsp;&nbsp;<b>$${fmtUsdShort(b.inflow)}</b><br>` +
          `outflow&nbsp;<b>$${fmtUsdShort(b.outflow)}</b><br>` +
          `net&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>${net >= 0 ? "+$" : "−$"}${fmtUsdShort(Math.abs(net))}</b>`;
        this.tip.hidden = false;
      }
      const wrap = this.canvas.parentElement.getBoundingClientRect();
      let tx = e.clientX - wrap.left + 14;
      if (tx + 150 > wrap.width) tx -= 170;
      this.tip.style.left = tx + "px";
      this.tip.style.top = (e.clientY - wrap.top - 10) + "px";
    },
  };

  /* ---------------- THROUGHPUT (real daily tx counts) ---------------- */

  const Throughput = {
    canvas: null, tip: null,
    points: [],       // [{t, tps}] oldest→newest (tps = tx count that day)
    _hoverIdx: -1,

    init() {
      this.canvas = document.getElementById("tps-canvas");
      this.tip = document.getElementById("tps-tip");
      this.canvas.addEventListener("mousemove", (e) => this._onMove(e));
      this.canvas.addEventListener("mouseleave", () => { this._hoverIdx = -1; this.tip.hidden = true; this.draw(); });
      window.addEventListener("resize", () => this.draw());
    },

    /* Blockscout chart_data arrives newest-first: [{date, transactions_count}] */
    setDaily(chartData) {
      this.points = chartData
        .filter((d) => d.transactions_count != null)
        .map((d) => ({ t: Date.parse(d.date), tps: d.transactions_count }))
        .reverse();
      this.draw();
      const label = document.getElementById("tps-now");
      if (label && this.points.length) {
        const last = this.points[this.points.length - 1].tps;
        label.textContent = (last >= 1e6 ? (last / 1e6).toFixed(2) + "M" : (last / 1e3).toFixed(0) + "K") + " tx/d";
      }
    },

    _geom() {
      const rect = this.canvas.getBoundingClientRect();
      const padL = 42, padR = 8, padT = 8, padB = 16;
      return { rect, padL, padR, padT, padB, plotW: rect.width - padL - padR, plotH: rect.height - padT - padB };
    },

    draw() {
      if (!this.canvas) return;
      const { ctx, w, h } = setupHiDPI(this.canvas);
      const { padL, padT, plotW, plotH } = this._geom();
      const P = this.points;
      ctx.clearRect(0, 0, w, h);
      if (P.length < 2) {
        ctx.fillStyle = col("--ink-muted");
        ctx.font = "10px " + col("--mono");
        ctx.textAlign = "center";
        ctx.fillText("awaiting performance samples…", w / 2, h / 2);
        return;
      }

      const maxT = Math.max(...P.map((p) => p.tps)) * 1.1;
      const minT = Math.min(...P.map((p) => p.tps)) * 0.9;
      const xy = (p, i) => ({
        x: padL + (i / (P.length - 1)) * plotW,
        y: padT + plotH - ((p.tps - minT) / (maxT - minT)) * plotH,
      });

      ctx.strokeStyle = col("--grid-line");
      ctx.fillStyle = col("--ink-muted");
      ctx.font = "9px " + col("--mono");
      ctx.lineWidth = 1;
      [0.25, 0.5, 0.75].forEach((f) => {
        const y = padT + plotH * (1 - f);
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.textAlign = "right";
        const v = minT + (maxT - minT) * f;
        ctx.fillText(v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : (v / 1e3).toFixed(0) + "k", padL - 5, y + 3);
      });

      /* area fill + line */
      const accent = col("--c-accent");
      ctx.beginPath();
      P.forEach((p, i) => { const { x, y } = xy(p, i); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1.6;
      ctx.stroke();
      ctx.lineTo(padL + plotW, padT + plotH);
      ctx.lineTo(padL, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = "rgba(57,135,229,0.12)";
      ctx.fill();

      if (this._hoverIdx >= 0 && this._hoverIdx < P.length) {
        const { x, y } = xy(P[this._hoverIdx], this._hoverIdx);
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = accent;
        ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col("--surface-1"); ctx.lineWidth = 2; ctx.stroke();
      }
    },

    _onMove(e) {
      const { rect, padL, plotW } = this._geom();
      const idx = Math.round(((e.clientX - rect.left - padL) / plotW) * (this.points.length - 1));
      if (idx < 0 || idx >= this.points.length) { this._hoverIdx = -1; this.tip.hidden = true; this.draw(); return; }
      if (idx !== this._hoverIdx) {
        this._hoverIdx = idx;
        this.draw();
        const p = this.points[idx];
        const d = new Date(p.t);
        const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
        this.tip.innerHTML = `<b>${MON[d.getUTCMonth()]}-${String(d.getUTCDate()).padStart(2, "0")}</b><br>transactions <b>${Math.round(p.tps).toLocaleString("en-US")}</b>`;
        this.tip.hidden = false;
      }
      const wrap = this.canvas.parentElement.getBoundingClientRect();
      let tx = e.clientX - wrap.left + 12;
      if (tx + 130 > wrap.width) tx -= 150;
      this.tip.style.left = tx + "px";
      this.tip.style.top = (e.clientY - wrap.top - 8) + "px";
    },
  };

  /* ---------------- EXPOSURE BARS (DOM) ---------------- */

  const Exposure = {
    el: null,
    init() { this.el = document.getElementById("exposure-bars"); },
    render(totalsByEntity) {
      const rows = Object.entries(totalsByEntity)
        .map(([name, o]) => ({ name, ...o }))
        .sort((a, b) => b.usd - a.usd)
        .slice(0, 9);
      const max = Math.max(1, ...rows.map((r) => r.usd));
      this.el.innerHTML = rows.map((r) => `
        <div class="exp-row">
          <span class="exp-name" title="${r.name}">${r.name}</span>
          <div class="exp-track"><div class="exp-fill ${r.etype === "SWAP" ? "swap" : ""}" style="width:${(r.usd / max * 100).toFixed(1)}%"></div></div>
          <span class="exp-val">$${AIRTAG.fmtUsd(r.usd)}</span>
        </div>`).join("");
    },
  };

  AIRTAG.Netflow = Netflow;
  AIRTAG.Throughput = Throughput;
  AIRTAG.Exposure = Exposure;
})();
