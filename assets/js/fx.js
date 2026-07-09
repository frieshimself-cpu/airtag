/* ============================================================
 * VEDANT // fx.js
 * Ambient HUD layer — everything here is presentation, but the
 * SYSTEMS strip and THREAT meter are wired to real runtime
 * internals (rpc token bucket, ws subscription count, ingest
 * queue depth, event-store size, detector hit totals), so they
 * move with the actual state of the machine, not a timer.
 * ============================================================ */

(function () {
  const css = getComputedStyle(document.documentElement);
  const col = (n) => css.getPropertyValue(n).trim();

  /* ---------- background lattice + particle drift ---------- */
  const Bg = {
    canvas: null, ctx: null, nodes: [], w: 0, h: 0,
    init() {
      this.canvas = document.getElementById("bg-canvas");
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext("2d");
      this._resize();
      window.addEventListener("resize", () => this._resize());
      requestAnimationFrame((t) => this._frame(t));
    },
    _resize() {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.w = window.innerWidth; this.h = window.innerHeight;
      this.canvas.width = this.w * dpr; this.canvas.height = this.h * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const count = Math.min(64, Math.floor((this.w * this.h) / 26000));
      this.nodes = [];
      for (let i = 0; i < count; i++) {
        this.nodes.push({
          x: Math.random() * this.w, y: Math.random() * this.h,
          vx: (Math.random() - 0.5) * 0.12, vy: (Math.random() - 0.5) * 0.12,
          r: 0.6 + Math.random() * 1.2,
        });
      }
    },
    _frame() {
      const ctx = this.ctx;
      if (!ctx) return;
      ctx.clearRect(0, 0, this.w, this.h);
      const N = this.nodes;
      for (const n of N) {
        n.x += n.vx; n.y += n.vy;
        if (n.x < 0 || n.x > this.w) n.vx *= -1;
        if (n.y < 0 || n.y > this.h) n.vy *= -1;
      }
      /* proximity links */
      ctx.lineWidth = 1;
      for (let i = 0; i < N.length; i++) {
        for (let j = i + 1; j < N.length; j++) {
          const dx = N[i].x - N[j].x, dy = N[i].y - N[j].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < 20000) {
            ctx.strokeStyle = `rgba(57,135,229,${(0.05 * (1 - d2 / 20000)).toFixed(3)})`;
            ctx.beginPath(); ctx.moveTo(N[i].x, N[i].y); ctx.lineTo(N[j].x, N[j].y); ctx.stroke();
          }
        }
      }
      ctx.fillStyle = "rgba(57,135,229,0.18)";
      for (const n of N) { ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2); ctx.fill(); }
      requestAnimationFrame(() => this._frame());
    },
  };

  /* ---------- live systems strip ---------- */
  const Systems = {
    cells: [],
    init() {
      const strip = document.getElementById("sys-strip");
      if (!strip) return;
      const defs = [
        { id: "rpc-bucket", label: "RPC TOKEN BUCKET", gauge: true },
        { id: "ingest-q",   label: "INGEST QUEUE",     gauge: true },
        { id: "ws-subs",    label: "WS SUBSCRIPTIONS",  gauge: true },
        { id: "evt-store",  label: "EVENT STORE",       gauge: true },
        { id: "throughput", label: "EVENT THROUGHPUT",  gauge: true },
        { id: "detect",     label: "DETECTOR HITS",     gauge: false },
        { id: "endpoint",   label: "ACTIVE ENDPOINT",   gauge: false },
        { id: "vclock",     label: "VECTOR CLOCK",      gauge: false },
      ];
      strip.innerHTML = defs.map((d) => `
        <div class="sys-cell">
          <div class="sys-label">${d.label}</div>
          <div class="sys-value" id="sys-${d.id}">—</div>
          ${d.gauge ? `<div class="sys-gauge"><span class="sys-gauge-fill" id="sysg-${d.id}"></span></div>` : `<div class="sys-spacer"></div>`}
        </div>`).join("");
      setInterval(() => this.tick(), 1000);
    },
    _set(id, val, pct, cls) {
      const v = document.getElementById("sys-" + id);
      if (v) { v.textContent = val; if (cls) v.className = "sys-value " + cls; }
      const g = document.getElementById("sysg-" + id);
      if (g && pct != null) g.style.width = Math.max(2, Math.min(100, pct)) + "%";
    },
    tick() {
      const R = AIRTAG.Rpc, M = AIRTAG.Metrics || {};
      const bucket = R ? R.bucketLevel() : 0;
      this._set("rpc-bucket", (bucket * (AIRTAG.CONFIG.CHAIN.BUCKET_CAPACITY)).toFixed(1) + " tok", bucket * 100, bucket < 0.2 ? "warn" : "");
      const q = M.queueDepth || 0;
      this._set("ingest-q", q + " tx", Math.min(100, q / 24 * 100), q > 16 ? "warn" : "");
      const subs = R ? R.wsSubCount() : 0;
      this._set("ws-subs", subs + "/9", subs / 9 * 100, subs === 0 ? "warn" : "");
      const store = M.eventCount || 0;
      this._set("evt-store", store.toLocaleString("en-US"), store / 700 * 100);
      const tp = (M.throughputPerMin || 0);
      this._set("throughput", tp.toFixed(0) + "/min", Math.min(100, tp / 40 * 100));
      const det = M.detectorHits || 0;
      this._set("detect", det.toLocaleString("en-US"));
      this._set("endpoint", (R ? R.endpointLabel() : "—") + (R && R.lastLatencyMs ? " · " + R.lastLatencyMs + "ms" : ""));
      this._set("vclock", (M.vclock || 0).toString().padStart(8, "0"));
    },
  };

  /* ---------- threat meter (composite of live risk signals) ---------- */
  const Threat = {
    init() { this.el = document.getElementById("threat-fill"); this.lab = document.getElementById("threat-label"); },
    set(score) {
      if (!this.el) return;
      const s = Math.max(0, Math.min(100, score));
      this.el.style.width = s + "%";
      let level, cls;
      if (s >= 80) { level = "CRITICAL"; cls = "critical"; }
      else if (s >= 60) { level = "ELEVATED"; cls = "serious"; }
      else if (s >= 35) { level = "GUARDED"; cls = "warning"; }
      else { level = "NOMINAL"; cls = "good"; }
      this.el.className = "threat-fill " + cls;
      if (this.lab) { this.lab.textContent = level + " · " + Math.round(s); this.lab.className = "threat-label " + cls; }
    },
  };

  AIRTAG.Fx = { init() { Bg.init(); Systems.init(); Threat.init(); }, Threat };
})();
