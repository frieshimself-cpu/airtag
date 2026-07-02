/* ============================================================
 * AIRTAG // trace.js
 * Forward taint-trace engine.
 *
 * This is REAL: given a bitcoin txid (or an address, whose most
 * recent transaction becomes the root), the engine walks the
 * UTXO graph forward via mempool.space (`/tx`, `/tx/:id/outspends`),
 * breadth-first up to the selected depth, following the largest
 * outputs at each hop. Any hop that lands on a watchlisted
 * exchange wallet is flagged as a custodial endpoint with the
 * BTC amount that reached it. Request budget + pacing keep it
 * polite to the public API. DEMO mode renders a synthetic graph.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();

  const WATCH = new Map(C.WATCHLIST.map((w) => [w.addr, w]));

  /* adaptive precision — cold-wallet dust probes are sub-0.0001 BTC */
  const fmtBtcAmt = (v) => v >= 0.01 ? v.toFixed(4) : v >= 0.0001 ? v.toFixed(6) : v.toFixed(8);

  const Trace = {
    canvas: null, logEl: null, hitsEl: null, badge: null,
    graph: null,
    running: false,

    init() {
      this.canvas = document.getElementById("trace-canvas");
      this.logEl = document.getElementById("trace-log");
      this.hitsEl = document.getElementById("trace-hits");
      this.badge = document.getElementById("trace-engine-badge");
      document.getElementById("trace-btn").addEventListener("click", () => this.start());
      document.getElementById("trace-demo-btn").addEventListener("click", () => this.demo());
      document.getElementById("trace-input").addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.start();
      });
      window.addEventListener("resize", () => this.graph && this.render());
    },

    log(msg, cls = "") {
      const div = document.createElement("div");
      div.className = "tl-line " + cls;
      div.textContent = msg;
      this.logEl.appendChild(div);
      this.logEl.scrollTop = this.logEl.scrollHeight;
      while (this.logEl.children.length > 80) this.logEl.removeChild(this.logEl.firstChild);
    },

    setBadge(txt) { this.badge.textContent = "ENGINE: " + txt; },

    _sleep(ms) { return new Promise((r) => setTimeout(r, ms)); },

    classify(input) {
      const s = input.trim();
      if (/^[0-9a-fA-F]{64}$/.test(s)) return { kind: "txid", value: s.toLowerCase() };
      if (/^(bc1[a-z0-9]{20,80}|[13][a-km-zA-HJ-NP-Z1-9]{25,40})$/.test(s)) return { kind: "address", value: s };
      return null;
    },

    async start() {
      if (this.running) return;
      const raw = document.getElementById("trace-input").value;
      const target = this.classify(raw);
      if (!target) {
        this.log("!! unrecognized target — expected 64-hex txid or base58/bech32 address", "err");
        return;
      }
      const depth = parseInt(document.getElementById("trace-depth").value, 10);
      this.running = true;
      document.getElementById("trace-btn").disabled = true;
      this.logEl.innerHTML = "";
      this.hitsEl.innerHTML = "";
      this.setBadge("RESOLVING");
      this.log(`>> target acquired [${target.kind}] ${target.value.slice(0, 24)}…`);

      try {
        let rootTxid = target.value;
        if (target.kind === "address") {
          this.log(".. resolving most recent transaction for address");
          const txs = await AIRTAG.Net.addressTxs(target.value);
          if (!txs || !txs.length) throw new Error("no transactions found for address (or API unreachable)");
          rootTxid = txs[0].txid;
          this.log(".. root tx " + rootTxid.slice(0, 16) + "…", "ok");
        }
        await this.walk(rootTxid, depth);
      } catch (err) {
        this.log("!! trace aborted: " + err.message, "err");
        this.setBadge("FAULT");
      }
      this.running = false;
      document.getElementById("trace-btn").disabled = false;
    },

    async walk(rootTxid, maxDepth) {
      const nodes = [], edges = [], hits = [];
      const seen = new Set();
      let requests = 0;
      const budget = C.API.TRACE_MAX_REQUESTS;

      const rootTx = await AIRTAG.Net.tx(rootTxid); requests++;
      if (!rootTx) throw new Error("root tx unreachable — data plane degraded");
      const rootValue = (rootTx.vout || []).reduce((s, o) => s + o.value, 0) / 1e8;
      const root = { id: rootTxid, label: rootTxid.slice(0, 8) + "…", kind: "root", depth: 0, btc: rootValue };
      nodes.push(root);
      seen.add(rootTxid);
      this.log(`.. root loaded — ${fmtBtcAmt(rootValue)} BTC across ${(rootTx.vout || []).length} outputs`);
      this.setBadge("WALKING");

      /* BFS frontier: [txObject, nodeRef, depth] */
      let frontier = [[rootTx, root, 0]];

      while (frontier.length && requests < budget) {
        const next = [];
        for (const [tx, parentNode, d] of frontier) {
          if (d >= maxDepth || requests >= budget) continue;

          /* First: flag any outputs paying directly into watchlisted wallets. */
          const vouts = (tx.vout || [])
            .map((o, i) => ({ ...o, i }))
            .sort((a, b) => b.value - a.value);

          for (const o of vouts) {
            const w = WATCH.get(o.scriptpubkey_address);
            if (w) {
              const btc = o.value / 1e8;
              const id = tx.txid + ":" + o.i + ":hit";
              nodes.push({ id, label: w.entity, kind: "cex", depth: d + 1, btc });
              edges.push({ from: parentNode.id, to: id, btc });
              hits.push({ entity: w.entity, etype: w.type, btc, depth: d + 1, tag: w.tag });
              this.log(`## CUSTODIAL ENDPOINT — ${fmtBtcAmt(btc)} BTC → ${w.entity} [${w.tag}] at hop ${d + 1}`, "hit");
            }
          }

          /* Then: follow spent outputs forward. */
          await this._sleep(C.API.TRACE_REQ_GAP_MS);
          const spends = await AIRTAG.Net.outspends(tx.txid); requests++;
          if (!spends) { this.log(".. outspends unreachable for " + tx.txid.slice(0, 8) + "…", "err"); continue; }

          const followable = vouts
            .filter((o) => !WATCH.has(o.scriptpubkey_address))
            .filter((o) => spends[o.i] && spends[o.i].spent && spends[o.i].txid)
            .slice(0, C.API.TRACE_MAX_FANOUT);

          for (const o of followable) {
            const childTxid = spends[o.i].txid;
            if (seen.has(childTxid) || requests >= budget) continue;
            seen.add(childTxid);
            await this._sleep(C.API.TRACE_REQ_GAP_MS);
            const childTx = await AIRTAG.Net.tx(childTxid); requests++;
            if (!childTx) continue;
            const btc = o.value / 1e8;
            const node = { id: childTxid, label: childTxid.slice(0, 8) + "…", kind: "unknown", depth: d + 1, btc };
            nodes.push(node);
            edges.push({ from: parentNode.id, to: childTxid, btc });
            this.log(`.. hop ${d + 1}: ${fmtBtcAmt(btc)} BTC → ${childTxid.slice(0, 12)}…`);
            next.push([childTx, node, d + 1]);
          }
          this.graph = { nodes, edges, hits };
          this.render();
        }
        frontier = next;
      }

      this.graph = { nodes, edges, hits };
      this.render();
      this.renderHits(hits, rootValue);
      this.log(`>> trace complete — ${nodes.length} nodes · ${edges.length} edges · ${hits.length} custodial hit(s) · ${requests}/${budget} api calls`, "ok");
      this.setBadge(hits.length ? hits.length + " HIT(S)" : "CLEAN");
      if (!hits.length) {
        this.log(".. no watchlisted endpoint reached within depth — widen depth or extend watchlist", "dim");
      }
    },

    demo() {
      if (this.running) return;
      const depth = parseInt(document.getElementById("trace-depth").value, 10);
      this.logEl.innerHTML = "";
      this.hitsEl.innerHTML = "";
      this.log(">> DEMO MODE — synthetic graph, illustrative only", "dim");
      this.graph = AIRTAG.Synth.demoTrace(depth);
      this.render();
      this.renderHits(this.graph.hits, 14.2);
      for (const h of this.graph.hits) {
        this.log(`## ${h.etype === "SWAP" ? "SWAP-SERVICE" : "CUSTODIAL"} ENDPOINT — ${h.btc.toFixed(3)} BTC → ${h.entity} at hop ${h.depth}`, "hit");
      }
      this.setBadge("DEMO · " + this.graph.hits.length + " HIT(S)");
    },

    renderHits(hits, rootValue) {
      if (!hits.length) { this.hitsEl.innerHTML = '<div class="empty-note">no custodial endpoints in graph</div>'; return; }
      const byEntity = {};
      for (const h of hits) {
        byEntity[h.entity] = byEntity[h.entity] || { btc: 0, etype: h.etype };
        byEntity[h.entity].btc += h.btc;
      }
      this.hitsEl.innerHTML = Object.entries(byEntity).map(([name, o]) => {
        const pct = rootValue > 0 ? (o.btc / rootValue * 100).toFixed(1) : "—";
        return `<div class="hit-row"><span class="he">▲ ${name} <span style="opacity:.6">${o.etype}</span></span>` +
               `<span class="hv">${fmtBtcAmt(o.btc)} BTC · ${pct}% exposure</span></div>`;
      }).join("");
    },

    render() {
      if (!this.graph) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = this.canvas.getBoundingClientRect();
      this.canvas.width = rect.width * dpr;
      this.canvas.height = rect.height * dpr;
      const ctx = this.canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);

      const { nodes, edges } = this.graph;
      const maxDepth = Math.max(1, ...nodes.map((n) => n.depth));
      const cols = {};
      nodes.forEach((n) => { (cols[n.depth] = cols[n.depth] || []).push(n); });

      const padX = 40, padY = 18;
      Object.entries(cols).forEach(([d, list]) => {
        const x = padX + (d / maxDepth) * (w - padX * 2);
        list.forEach((n, i) => {
          n.x = x;
          n.y = padY + ((i + 0.5) / list.length) * (h - padY * 2);
        });
      });

      const maxBtc = Math.max(1e-8, ...edges.map((e) => e.btc));
      const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

      for (const e of edges) {
        const a = nodeById[e.from], b = nodeById[e.to];
        if (!a || !b) continue;
        ctx.strokeStyle = b.kind === "cex" || b.kind === "swap"
          ? "rgba(250,178,25,0.55)" : "rgba(255,255,255,0.14)";
        ctx.lineWidth = Math.max(1, (e.btc / maxBtc) * 4);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(a.x + (b.x - a.x) * 0.5, a.y, a.x + (b.x - a.x) * 0.5, b.y, b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const r = n.kind === "root" ? 7 : 5;
        ctx.fillStyle =
          n.kind === "root" ? col("--c-net") :
          n.kind === "cex"  ? col("--c-accent") :
          n.kind === "swap" ? col("--c-swap") :
          col("--ink-muted");
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col("--surface-1");
        ctx.lineWidth = 2; ctx.stroke();
        if (n.kind === "cex" || n.kind === "swap") {
          ctx.strokeStyle = col("--st-warning");
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
        }
        ctx.fillStyle = n.kind === "unknown" ? col("--ink-muted") : col("--ink-2");
        ctx.font = "9px " + col("--mono");
        ctx.textAlign = "center";
        ctx.fillText(n.label, n.x, n.y - r - 5);
        if (n.kind !== "unknown") {
          ctx.fillStyle = col("--ink-muted");
          ctx.fillText(fmtBtcAmt(n.btc) + " BTC", n.x, n.y + r + 12);
        }
      }
    },
  };

  AIRTAG.Trace = Trace;
})();
