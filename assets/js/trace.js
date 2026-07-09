/* ============================================================
 * VEDANT // trace.js
 * Robinhood Chain forward taint-trace engine.
 *
 * The walk is TEMPORAL over the account graph: from a root
 * address (or a tx hash's sender), collect its outgoing native
 * transfers via the Blockscout address-history API, then for
 * each counterparty examine only transactions AFTER the funds
 * arrived (causality window) and follow where they went. Hops
 * landing on watched venues (WETH vault, PoolManager, router,
 * ArbSys bridge exit) or discovered whales are flagged; a
 * counterparty that forwards ≥85% of what it received into a
 * watched endpoint within 2h is attributed as a hot-path/deposit
 * address (detector D-01) and registered globally.
 *
 * All chain data flows through the shared rate-limited client;
 * the walk is request-budgeted. DEMO renders a synthetic graph.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();

  const STATIC_WATCH = new Map(C.WATCHLIST.map((w) => [w.addr.toLowerCase(), w]));
  const watchLookup = (addr) => {
    const a = (addr || "").toLowerCase();
    return STATIC_WATCH.get(a) || (AIRTAG.whaleMap && AIRTAG.whaleMap.get(a)) || null;
  };

  const short = (h) => h.slice(0, 6) + "…" + h.slice(-4);
  const fmtEth = (v) => v >= 1000 ? (v / 1000).toFixed(2) + "k"
    : v >= 1 ? v.toFixed(3) : v >= 0.001 ? v.toFixed(5) : v.toFixed(7);

  const Trace = {
    canvas: null, logEl: null, hitsEl: null, badge: null,
    graph: null,
    running: false,
    requests: 0,

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
      while (this.logEl.children.length > 90) this.logEl.removeChild(this.logEl.firstChild);
    },

    setBadge(txt) { this.badge.textContent = "ENGINE: " + txt; },

    classify(input) {
      const s = input.trim();
      if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { kind: "txhash", value: s.toLowerCase() };
      if (/^0x[0-9a-fA-F]{40}$/.test(s)) return { kind: "address", value: s.toLowerCase() };
      return null;
    },

    async _addressTxs(addr) {
      if (this.requests >= C.API.TRACE_MAX_REQUESTS) return null;
      this.requests++;
      return AIRTAG.Rpc.addressTxs(addr);
    },

    async start() {
      if (this.running) return;
      const target = this.classify(document.getElementById("trace-input").value);
      if (!target) {
        this.log("!! unrecognized target — expected 0x address (40 hex) or tx hash (64 hex)", "err");
        return;
      }
      const depth = parseInt(document.getElementById("trace-depth").value, 10);
      this.running = true;
      this.requests = 0;
      document.getElementById("trace-btn").disabled = true;
      this.logEl.innerHTML = "";
      this.hitsEl.innerHTML = "";
      this.setBadge("RESOLVING");
      this.log(`>> target acquired [${target.kind}] ${target.value.slice(0, 18)}…`);

      try {
        let rootAddr = target.value;
        if (target.kind === "txhash") {
          this.log(".. hydrating root transaction");
          this.requests++;
          const tx = await AIRTAG.Rpc.txDetail(target.value);
          if (!tx || tx.notFound || !tx.from) throw new Error("transaction unreachable or unknown");
          rootAddr = (tx.from.hash || "").toLowerCase();
          this.log(`.. sender resolved ${short(rootAddr)} (${parseInt(tx.value || "0", 10) / 1e18} ETH moved)`, "ok");
        }
        await this.walk(rootAddr, depth);
      } catch (err) {
        this.log("!! trace aborted: " + err.message, "err");
        this.setBadge("FAULT");
      }
      this.running = false;
      document.getElementById("trace-btn").disabled = false;
    },

    async walk(rootAddr, maxDepth) {
      const nodes = [], edges = [], hits = [];
      const seen = new Set();

      const rootWatch = watchLookup(rootAddr);
      const root = {
        id: rootAddr,
        label: rootWatch ? rootWatch.entity + " (watched)" : short(rootAddr),
        kind: "root", depth: 0, amt: 0,
      };
      nodes.push(root);
      seen.add(rootAddr);
      this.setBadge("WALKING");
      this.log(".. collecting outbound native transfers (temporal window opens at receipt)");

      /* frontier entries: {addr, node, afterMs, depth, inheritedEth} */
      let frontier = [{ addr: rootAddr, node: root, afterMs: 0, depth: 0, inheritedEth: null }];

      while (frontier.length && this.requests < C.API.TRACE_MAX_REQUESTS) {
        const next = [];
        for (const f of frontier) {
          if (f.depth >= maxDepth) continue;
          const items = await this._addressTxs(f.addr);
          if (!items) { this.log(".. history unreachable for " + short(f.addr), "err"); continue; }
          const outs = AIRTAG.Decode.outgoing(items, f.addr, f.afterMs)
            .slice(0, C.API.TRACE_TX_PER_HOP * 3);

          /* aggregate per destination */
          const perDest = new Map();
          for (const o of outs) {
            const cur = perDest.get(o.to) || { eth: 0, hash: o.hash, time: o.time };
            cur.eth += o.eth;
            cur.time = Math.max(cur.time, o.time);
            perDest.set(o.to, cur);
          }
          const flows = [...perDest.entries()]
            .map(([to, v]) => ({ to, ...v }))
            .sort((a, b) => b.eth - a.eth);

          if (!flows.length) {
            if (f.depth === 0) this.log(".. no outbound native transfers found in window", "dim");
            continue;
          }
          const totalOut = flows.reduce((s, x) => s + x.eth, 0);
          if (f.depth === 0) root.amt = totalOut;

          for (const flow of flows.slice(0, C.API.TRACE_MAX_FANOUT)) {
            const w = watchLookup(flow.to);
            if (w) {
              const id = flow.to + ":" + f.depth;
              nodes.push({ id, label: w.entity, kind: "cex", depth: f.depth + 1, amt: flow.eth });
              edges.push({ from: f.node.id, to: id, amt: flow.eth });
              hits.push({ entity: w.entity, etype: w.type, amt: flow.eth, depth: f.depth + 1, tag: w.tag });
              this.log(`## WATCHED ENDPOINT — ${fmtEth(flow.eth)} ETH → ${w.entity} [${w.tag}] at hop ${f.depth + 1}`, "hit");

              if (f.inheritedEth) {
                const ratio = flow.eth / f.inheritedEth;
                const dtSec = Math.max(0, (flow.time - f.afterMs) / 1000);
                if (AIRTAG.Detect.DepositRegistry.note(f.addr, w.entity, ratio, dtSec, flow.hash)) {
                  f.node.kind = "deposit";
                  f.node.label = short(f.addr) + " ⤳" + w.entity;
                  this.log(`## D-01 INFERENCE — ${short(f.addr)} attributed as ${w.entity} hot-path address (fwd ${(ratio * 100).toFixed(0)}% in ${Math.round(dtSec)}s)`, "hit");
                }
              }
              continue;
            }
            if (seen.has(flow.to)) continue;
            seen.add(flow.to);
            const node = { id: flow.to, label: short(flow.to), kind: "unknown", depth: f.depth + 1, amt: flow.eth };
            nodes.push(node);
            edges.push({ from: f.node.id, to: flow.to, amt: flow.eth });
            this.log(`.. hop ${f.depth + 1}: ${fmtEth(flow.eth)} ETH → ${short(flow.to)}`);
            next.push({ addr: flow.to, node, afterMs: flow.time || Date.now(), depth: f.depth + 1, inheritedEth: flow.eth });
          }
          this.graph = { nodes, edges, hits };
          this.render();
        }
        frontier = next;
      }

      this.graph = { nodes, edges, hits };
      this.render();
      this.renderHits(hits, root.amt);
      this.log(`>> trace complete — ${nodes.length} nodes · ${edges.length} edges · ${hits.length} watched hit(s) · ${this.requests}/${C.API.TRACE_MAX_REQUESTS} api calls`, "ok");
      this.setBadge(hits.length ? hits.length + " HIT(S)" : "CLEAN");
      if (!hits.length) {
        this.log(".. no watched endpoint reached in window — widen depth, or the funds are still at rest", "dim");
      }
    },

    demo() {
      if (this.running) return;
      const depth = parseInt(document.getElementById("trace-depth").value, 10);
      this.logEl.innerHTML = "";
      this.hitsEl.innerHTML = "";
      this.log(">> DEMO MODE — synthetic graph, illustrative only", "dim");
      this.graph = AIRTAG.Detect.demoTrace(depth);
      this.render();
      this.renderHits(this.graph.hits, this.graph.nodes[0].amt);
      for (const h of this.graph.hits) {
        this.log(`## WATCHED ENDPOINT — ${fmtEth(h.amt)} ETH → ${h.entity} at hop ${h.depth}`, "hit");
      }
      this.setBadge("DEMO · " + this.graph.hits.length + " HIT(S)");
    },

    renderHits(hits, rootAmt) {
      if (!hits.length) {
        this.hitsEl.innerHTML = '<div class="empty-note">no watched endpoints in graph</div>';
        return;
      }
      const byEntity = {};
      for (const h of hits) {
        byEntity[h.entity] = byEntity[h.entity] || { amt: 0, etype: h.etype };
        byEntity[h.entity].amt += h.amt;
      }
      this.hitsEl.innerHTML = Object.entries(byEntity).map(([name, o]) => {
        const pct = rootAmt > 0 ? Math.min(100, o.amt / rootAmt * 100).toFixed(1) : "—";
        return `<div class="hit-row"><span class="he">▲ ${name} <span style="opacity:.6">${o.etype}</span></span>` +
               `<span class="hv">${fmtEth(o.amt)} ETH · ${pct}% exposure</span></div>`;
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

      const padX = 46, padY = 18;
      Object.entries(cols).forEach(([d, list]) => {
        const x = padX + (d / maxDepth) * (w - padX * 2);
        list.forEach((n, i) => {
          n.x = x;
          n.y = padY + ((i + 0.5) / list.length) * (h - padY * 2);
        });
      });

      const maxAmt = Math.max(1e-9, ...edges.map((e) => e.amt));
      const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

      for (const e of edges) {
        const a = nodeById[e.from], b = nodeById[e.to];
        if (!a || !b) continue;
        ctx.strokeStyle = b.kind === "cex" ? "rgba(250,178,25,0.55)"
          : b.kind === "deposit" ? "rgba(25,158,112,0.5)"
          : "rgba(255,255,255,0.14)";
        ctx.lineWidth = Math.max(1, (e.amt / maxAmt) * 4);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.bezierCurveTo(a.x + (b.x - a.x) * 0.5, a.y, a.x + (b.x - a.x) * 0.5, b.y, b.x, b.y);
        ctx.stroke();
      }

      for (const n of nodes) {
        const r = n.kind === "root" ? 7 : 5;
        ctx.fillStyle =
          n.kind === "root"    ? col("--c-net") :
          n.kind === "cex"     ? col("--c-accent") :
          n.kind === "deposit" ? col("--c-outflow") :
          col("--ink-muted");
        ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = col("--surface-1");
        ctx.lineWidth = 2; ctx.stroke();
        if (n.kind === "cex") {
          ctx.strokeStyle = col("--st-warning");
          ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
        } else if (n.kind === "deposit") {
          ctx.strokeStyle = col("--c-outflow");
          ctx.setLineDash([3, 2]);
          ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
        ctx.fillStyle = n.kind === "unknown" ? col("--ink-muted") : col("--ink-2");
        ctx.font = "9px " + col("--mono");
        ctx.textAlign = "center";
        ctx.fillText(n.label, n.x, n.y - r - 5);
        if (n.kind !== "unknown" && n.amt > 0) {
          ctx.fillStyle = col("--ink-muted");
          ctx.fillText(fmtEth(n.amt) + " ETH", n.x, n.y + r + 12);
        }
      }
    },
  };

  AIRTAG.Trace = Trace;
})();
