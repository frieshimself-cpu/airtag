/* ============================================================
 * AIRTAG // topology.js
 * Live routing graph: unknown clusters (left) route value into
 * custodial / instant-swap endpoints (right). Feed events spawn
 * particles that travel their edge; endpoint nodes pulse on
 * arrival. Pure canvas, no dependencies.
 * ============================================================ */

(function () {
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();

  const Topology = {
    canvas: null, ctx: null,
    nodes: [],       // {id,label,kind,x,y,r,pulse}
    sources: [],     // unknown cluster nodes
    particles: [],   // {from,to,t,speed,size,color}
    edgeCount: 0,

    init() {
      this.canvas = document.getElementById("topology-canvas");
      this.ctx = this.canvas.getContext("2d");
      this._layout();
      window.addEventListener("resize", () => this._layout());
      requestAnimationFrame((ts) => this._frame(ts));
    },

    _layout() {
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.w = rect.width; this.h = rect.height;

      const ents = AIRTAG.CONFIG.ENTITIES;
      const n = ents.length;
      this.nodes = ents.map((e, i) => {
        const fy = (i + 0.5) / n;
        return {
          id: e.name, label: e.name, kind: e.type,
          x: this.w * (e.type === "SWAP" ? 0.88 : e.type === "WHALE" ? 0.70 : 0.52),
          y: 18 + fy * (this.h - 36),
          r: 4 + Math.sqrt(e.weight) * 1.3,
          pulse: 0,
        };
      });
      this.sources = [];
      for (let i = 0; i < 7; i++) {
        this.sources.push({
          id: "u" + i,
          label: "0x" + (0x3f00 + ((Math.random() * 0xff) | 0)).toString(16) + "…",
          kind: "UNKNOWN",
          x: this.w * (0.05 + Math.random() * 0.12),
          y: 22 + ((i + 0.5) / 7) * (this.h - 44),
          r: 3.5 + Math.random() * 2.5,
          pulse: 0,
        });
      }
    },

    /* Called by app.js when a feed event lands. */
    emit(ev) {
      const to = this.nodes.find((nd) => nd.id === ev.entity);
      if (!to) return;
      const from = this.sources[(Math.random() * this.sources.length) | 0];
      const [a, b] = ev.dir === "OUT" ? [to, from] : [from, to];
      const usd = ev.usd || 100_000;
      this.particles.push({
        from: a, to: b, t: 0,
        speed: 0.004 + Math.random() * 0.004,
        size: Math.min(4.5, 1.2 + Math.log10(Math.max(usd, 1)) * 0.45),
        color: ev.dir === "OUT" ? col("--c-outflow")
             : ev.etype === "SWAP" ? col("--c-swap")
             : col("--c-inflow"),
      });
      this.edgeCount++;
      const badge = document.getElementById("topo-stats");
      if (badge) badge.textContent = `${this.edgeCount} edges · ${this.particles.length} in-flight`;
    },

    _edgePoint(a, b, t) {
      /* quadratic bezier with a mild vertical bow */
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2 - 26;
      const u = 1 - t;
      return {
        x: u * u * a.x + 2 * u * t * mx + t * t * b.x,
        y: u * u * a.y + 2 * u * t * my + t * t * b.y,
      };
    },

    _frame(ts) {
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      /* lane separators + captions */
      ctx.fillStyle = col("--ink-muted");
      ctx.font = "8.5px " + col("--mono");
      ctx.textAlign = "left";
      ctx.globalAlpha = 0.8;
      ctx.fillText("UNATTRIBUTED ADDRESSES", this.w * 0.04, 12);
      ctx.fillText("VENUES", this.w * 0.46, 12);
      ctx.fillText("WHALES", this.w * 0.66, 12);
      ctx.fillText("INSTANT-SWAP", this.w * 0.84, 12);
      ctx.globalAlpha = 1;

      /* dormant edges (faint) from each source to a few endpoints */
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (const s of this.sources) {
        for (let i = 0; i < this.nodes.length; i += 3) {
          const n = this.nodes[i];
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.quadraticCurveTo((s.x + n.x) / 2, (s.y + n.y) / 2 - 26, n.x, n.y);
          ctx.stroke();
        }
      }

      /* particles */
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.t += p.speed;
        if (p.t >= 1) {
          p.to.pulse = 1;
          this.particles.splice(i, 1);
          continue;
        }
        const pos = this._edgePoint(p.from, p.to, p.t);
        /* trail */
        const tail = this._edgePoint(p.from, p.to, Math.max(0, p.t - 0.06));
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 0.35;
        ctx.lineWidth = p.size * 0.8;
        ctx.beginPath(); ctx.moveTo(tail.x, tail.y); ctx.lineTo(pos.x, pos.y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(pos.x, pos.y, p.size, 0, Math.PI * 2); ctx.fill();
      }

      /* nodes */
      const drawNode = (nd) => {
        if (nd.pulse > 0) {
          ctx.strokeStyle = "rgba(255,255,255," + (nd.pulse * 0.5).toFixed(2) + ")";
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(nd.x, nd.y, nd.r + (1 - nd.pulse) * 14, 0, Math.PI * 2);
          ctx.stroke();
          nd.pulse = Math.max(0, nd.pulse - 0.02);
        }
        ctx.fillStyle =
          nd.kind === "SWAP"  ? col("--c-swap") :
          nd.kind === "WHALE" ? col("--c-net") :
          nd.kind === "VENUE" ? col("--c-accent") :
          col("--ink-muted");
        ctx.beginPath(); ctx.arc(nd.x, nd.y, nd.r, 0, Math.PI * 2); ctx.fill();
        /* 2px surface ring so overlapping marks separate */
        ctx.strokeStyle = col("--surface-1");
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.fillStyle = col("--ink-2");
        ctx.font = "9px " + col("--mono");
        ctx.textAlign = nd.kind === "UNKNOWN" ? "right" : "left";
        const lx = nd.kind === "UNKNOWN" ? nd.x - nd.r - 5 : nd.x + nd.r + 5;
        ctx.fillText(nd.label, lx, nd.y + 3);
      };
      this.sources.forEach(drawNode);
      this.nodes.forEach(drawNode);

      requestAnimationFrame((t2) => this._frame(t2));
    },
  };

  AIRTAG.Topology = Topology;
})();
