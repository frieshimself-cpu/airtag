/* ============================================================
 * AIRTAG // charts.js
 * Custom canvas renderers — no external chart libs.
 *  - Netflow: diverging hourly bars (inflow up / outflow down)
 *    with a cumulative net line, crosshair hover + tooltip.
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

  const fmtBtc = (v) =>
    Math.abs(v) >= 1000 ? (v / 1000).toFixed(2) + "k" : v.toFixed(v < 10 ? 2 : 1);

  /* ---------------- NETFLOW ---------------- */

  const Netflow = {
    canvas: null,
    tip: null,
    buckets: [],       // [{t, inflow, outflow}] hourly, oldest→newest
    _hoverIdx: -1,

    init() {
      this.canvas = document.getElementById("netflow-canvas");
      this.tip = document.getElementById("netflow-tip");
      this.canvas.addEventListener("mousemove", (e) => this._onMove(e));
      this.canvas.addEventListener("mouseleave", () => { this._hoverIdx = -1; this.tip.hidden = true; this.draw(); });
      window.addEventListener("resize", () => this.draw());
    },

    /* Rebuild hourly buckets from the feed event list. */
    setData(events) {
      const now = Date.now();
      const H = 3600_000;
      const buckets = [];
      for (let i = 23; i >= 0; i--) {
        buckets.push({ t: now - i * H, inflow: 0, outflow: 0 });
      }
      for (const ev of events) {
        const age = now - ev.time;
        if (age < 0 || age >= 24 * H) continue;
        const idx = 23 - Math.floor(age / H);
        const b = buckets[idx];
        if (!b) continue;
        const btc = Math.abs(ev.amountBtc || 0);
        if (ev.dir === "IN") b.inflow += btc;
        else if (ev.dir === "OUT") b.outflow += btc;
        else { b.inflow += btc * 0.5; b.outflow += btc * 0.5; } // SWAP: pass-through
      }
      this.buckets = buckets;
      this.draw();
    },

    _geom() {
      const rect = this.canvas.getBoundingClientRect();
      const padL = 46, padR = 10, padT = 10, padB = 20;
      return { rect, padL, padR, padT, padB, plotW: rect.width - padL - padR, plotH: rect.height - padT - padB };
    },

    draw() {
      if (!this.canvas) return;
      const { ctx, w, h } = setupHiDPI(this.canvas);
      const { padL, padT, padB, plotW, plotH } = this._geom();
      const B = this.buckets;
      ctx.clearRect(0, 0, w, h);
      if (!B.length) return;

      const maxV = Math.max(1e-6, ...B.map((b) => Math.max(b.inflow, b.outflow)));
      const midY = padT + plotH / 2;
      const scale = (plotH / 2 - 6) / maxV;
      const step = plotW / B.length;
      const barW = Math.max(3, step * 0.52);

      /* gridlines + y labels */
      ctx.strokeStyle = col("--grid-line") || "rgba(255,255,255,0.05)";
      ctx.fillStyle = col("--ink-muted");
      ctx.font = "9px " + col("--mono");
      ctx.lineWidth = 1;
      [-1, -0.5, 0.5, 1].forEach((f) => {
        const y = midY - f * maxV * scale;
        ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
        ctx.textAlign = "right";
        ctx.fillText((f > 0 ? "+" : "−") + fmtBtc(Math.abs(f) * maxV), padL - 6, y + 3);
      });

      /* baseline */
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath(); ctx.moveTo(padL, midY); ctx.lineTo(padL + plotW, midY); ctx.stroke();

      /* bars — 4px rounded data-ends, anchored to baseline */
      const cIn = col("--c-inflow"), cOut = col("--c-outflow");
      B.forEach((b, i) => {
        const x = padL + i * step + (step - barW) / 2;
        const dim = this._hoverIdx >= 0 && this._hoverIdx !== i;
        ctx.globalAlpha = dim ? 0.35 : 1;
        if (b.inflow > 0) {
          const bh = Math.max(2, b.inflow * scale);
          ctx.fillStyle = cIn;
          roundedBarUp(ctx, x, midY - 1, barW, bh);
        }
        if (b.outflow > 0) {
          const bh = Math.max(2, b.outflow * scale);
          ctx.fillStyle = cOut;
          roundedBarDown(ctx, x, midY + 1, barW, bh);
        }
        ctx.globalAlpha = 1;
      });

      /* cumulative net line */
      ctx.strokeStyle = col("--c-net");
      ctx.lineWidth = 2;
      ctx.beginPath();
      let cum = 0;
      const cums = B.map((b) => (cum += b.inflow - b.outflow));
      const maxCum = Math.max(1e-6, ...cums.map(Math.abs));
      cums.forEach((v, i) => {
        const x = padL + i * step + step / 2;
        const y = midY - (v / maxCum) * (plotH / 2 - 10);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();

      /* x labels — every 4h */
      ctx.fillStyle = col("--ink-muted");
      ctx.textAlign = "center";
      B.forEach((b, i) => {
        if (i % 4 !== 0) return;
        const d = new Date(b.t);
        ctx.fillText(String(d.getUTCHours()).padStart(2, "0") + ":00",
          padL + i * step + step / 2, padT + plotH + 14);
      });

      /* crosshair */
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
        const d = new Date(b.t);
        const hh = String(d.getUTCHours()).padStart(2, "0");
        this.tip.innerHTML =
          `<b>${hh}:00 UTC</b><br>` +
          `inflow&nbsp;&nbsp;<b>${fmtBtc(b.inflow)} BTC</b><br>` +
          `outflow&nbsp;<b>${fmtBtc(b.outflow)} BTC</b><br>` +
          `net&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;<b>${(b.inflow - b.outflow >= 0 ? "+" : "−")}${fmtBtc(Math.abs(b.inflow - b.outflow))} BTC</b>`;
        this.tip.hidden = false;
      }
      const wrap = this.canvas.parentElement.getBoundingClientRect();
      let tx = e.clientX - wrap.left + 14;
      if (tx + 150 > wrap.width) tx -= 170;
      this.tip.style.left = tx + "px";
      this.tip.style.top = (e.clientY - wrap.top - 10) + "px";
    },
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
  AIRTAG.Exposure = Exposure;
})();
