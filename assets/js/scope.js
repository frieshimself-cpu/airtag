/* ============================================================
 * VEDANT // scope.js
 * Signal-scope — a rotating polar projection of live flow events.
 * Azimuth encodes the entity (stable angle per entity), radius
 * encodes notional (log-scaled), hue encodes direction, and the
 * blip's fade encodes recency. A sweep line rotates over the top.
 * Fed directly by the real event stream via push().
 * ============================================================ */

(function () {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();

  const Scope = {
    canvas: null, ctx: null, blips: [], angle: 0, w: 0, h: 0, cx: 0, cy: 0, R: 0,
    entityAngle: new Map(),

    init() {
      this.canvas = document.getElementById("scope-canvas");
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext("2d");
      const ents = AIRTAG.CONFIG.ENTITIES;
      ents.forEach((e, i) => this.entityAngle.set(e.name, (i / ents.length) * Math.PI * 2));
      this._resize();
      window.addEventListener("resize", () => this._resize());
      requestAnimationFrame(() => this._frame());
    },

    _resize() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width; this.h = rect.height;
      this.cx = this.w / 2; this.cy = this.h / 2;
      this.R = Math.min(this.w, this.h) / 2 - 10;
    },

    push(ev) {
      let a = this.entityAngle.get(ev.entity);
      if (a == null) a = Math.random() * Math.PI * 2;
      a += (Math.random() - 0.5) * 0.12;                       // jitter within the entity's arc
      const usd = ev.usd || 1000;
      const rr = Math.min(1, Math.log10(Math.max(usd, 100) / 100) / 5); // 100 → 10M maps 0→1
      const color = ev.dir === "OUT" ? col("--c-outflow")
        : ev.dir === "SWAP" ? col("--c-swap") : col("--c-inflow");
      this.blips.push({ a, r: 0.14 + rr * 0.82, born: this._now, life: 1, color, big: usd > 1_000_000 });
      if (this.blips.length > 140) this.blips.shift();
    },

    _now: 0,
    _frame() {
      this._now += 1;
      const ctx = this.ctx;
      if (!ctx) { return; }
      ctx.clearRect(0, 0, this.w, this.h);
      const cx = this.cx, cy = this.cy, R = this.R;

      /* range rings + spokes */
      ctx.strokeStyle = "rgba(57,135,229,0.14)";
      ctx.lineWidth = 1;
      [0.25, 0.5, 0.75, 1].forEach((f) => {
        ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
      });
      ctx.strokeStyle = "rgba(57,135,229,0.08)";
      for (let i = 0; i < 12; i++) {
        const ang = (i / 12) * Math.PI * 2;
        ctx.beginPath(); ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R); ctx.stroke();
      }

      /* entity azimuth labels (outer ring) */
      ctx.fillStyle = col("--ink-muted");
      ctx.font = "8px " + col("--mono");
      for (const [name, a] of this.entityAngle) {
        const x = cx + Math.cos(a) * (R + 2), y = cy + Math.sin(a) * (R + 2);
        ctx.textAlign = Math.cos(a) < -0.3 ? "right" : Math.cos(a) > 0.3 ? "left" : "center";
        ctx.fillText(name.slice(0, 7), x, y + 3);
      }

      /* rotating sweep with trailing wedge */
      this.angle = (this.angle + 0.018) % (Math.PI * 2);
      ctx.save();
      ctx.beginPath(); ctx.moveTo(cx, cy);
      for (let k = 0; k <= 24; k++) {
        const ang = this.angle - (k / 24) * 0.6;
        ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(57,135,229,0.06)";
      ctx.fill();
      ctx.restore();
      ctx.strokeStyle = "rgba(57,135,229,0.5)";
      ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(this.angle) * R, cy + Math.sin(this.angle) * R); ctx.stroke();

      /* blips */
      for (let i = this.blips.length - 1; i >= 0; i--) {
        const b = this.blips[i];
        b.life -= 0.0016;
        if (b.life <= 0) { this.blips.splice(i, 1); continue; }
        const x = cx + Math.cos(b.a) * R * b.r;
        const y = cy + Math.sin(b.a) * R * b.r;
        /* freshly-swept blips flare */
        let da = Math.abs(((b.a - this.angle) % (Math.PI * 2)));
        if (da > Math.PI) da = Math.PI * 2 - da;
        const flare = da < 0.25 ? 1.8 : 1;
        ctx.globalAlpha = Math.max(0.15, b.life);
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(x, y, (b.big ? 3.2 : 1.8) * flare, 0, Math.PI * 2);
        ctx.fill();
        if (b.big) {
          ctx.globalAlpha = Math.max(0.1, b.life * 0.5);
          ctx.strokeStyle = b.color; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.arc(x, y, 6 * flare, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }

      /* center hub */
      ctx.fillStyle = col("--c-accent");
      ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, Math.PI * 2); ctx.fill();

      requestAnimationFrame(() => this._frame());
    },
  };

  AIRTAG.Scope = Scope;
})();
