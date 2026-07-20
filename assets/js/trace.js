/* ============================================================
 * AIRTAG // trace.js
 * Solana forward taint-trace engine.
 *
 * Account-model chains have no UTXO graph, so the walk is
 * TEMPORAL: from a root address (or the primary debtor of a tx
 * signature), collect its outgoing SOL transfers, then for each
 * counterparty examine only transactions AFTER the funds arrived
 * (causality window) and follow where they went. Hops are scored
 * against the custodial watchlist; a counterparty that forwards
 * ≥85% of what it received into a labeled hot wallet within 2h
 * is attributed as an exchange deposit address (detector D-01)
 * and registered globally.
 *
 * All chain data comes from public JSON-RPC through the shared
 * rate-limited client; the walk is request-budgeted. DEMO mode
 * renders a synthetic graph (tagged as such).
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const CSS = getComputedStyle(document.documentElement);
  const col = (n) => CSS.getPropertyValue(n).trim();

  const WATCH = new Map(C.WATCHLIST.map((w) => [w.addr, w]));
  const short = (pk) => pk.slice(0, 4) + "…" + pk.slice(-4);
  const fmtSol = (v) => v >= 1000 ? (v / 1000).toFixed(2) + "k"
    : v >= 1 ? v.toFixed(2) : v >= 0.001 ? v.toFixed(4) : v.toFixed(6);

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
      if (/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s)) return { kind: "signature", value: s };
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s)) return { kind: "address", value: s };
      return null;
    },

    async _tx(sig) {
      if (this.requests >= C.API.TRACE_MAX_REQUESTS) return null;
      this.requests++;
      return AIRTAG.Rpc.transaction(sig);
    },

    async _sigs(addr, limit) {
      if (this.requests >= C.API.TRACE_MAX_REQUESTS) return null;
      this.requests++;
      return AIRTAG.Rpc.signaturesFor(addr, { limit });
    },

    async start() {
      if (this.running) return;
      const target = this.classify(document.getElementById("trace-input").value);
      if (!target) {
        this.log("!! unrecognized target — expected base58 address (32-44) or tx signature (~88)", "err");
        return;
      }
      const depth = parseInt(document.getElementById("trace-depth").value, 10);
      this.running = true;
      this.requests = 0;
      document.getElementById("trace-btn").disabled = true;
      this.logEl.innerHTML = "";
      this.hitsEl.innerHTML = "";
      this.setBadge("RESOLVING");
      this.log(`>> target acquired [${target.kind}] ${target.value.slice(0, 20)}…`);

      try {
        await this.walk(target, depth);
      } catch (err) {
        this.log("!! trace aborted: " + err.message, "err");
        this.setBadge("FAULT");
      }
      this.running = false;
      document.getElementById("trace-btn").disabled = false;
    },

    /* Outgoing SOL transfers from `addr`, aggregated per
     * destination, across up to `txCap` transactions confined to
     * blockTime ≥ afterMs (temporal causality). */
    async _outflows(addr, afterMs, txCap) {
      const sigs = await this._sigs(addr, 12);
      if (!sigs) return { flows: [], lastTime: 0 };
      const eligible = sigs
        .filter((s) => !s.err && s.blockTime && s.blockTime * 1000 >= afterMs - 60_000)
        .sort((a, b) => a.blockTime - b.blockTime)   // earliest post-receipt first
        .slice(0, txCap);
      const perDest = new Map();
      let lastTime = 0;
      for (const s of eligible) {
        const tx = await this._tx(s.signature);
        if (!tx) continue;
        for (const o of AIRTAG.Decode.outgoing(tx, addr)) {
          const cur = perDest.get(o.to) || { sol: 0, sig: o.sig, time: o.time };
          cur.sol += o.sol;
          perDest.set(o.to, cur);
          lastTime = Math.max(lastTime, o.time);
        }
      }
      const flows = [...perDest.entries()]
        .map(([to, v]) => ({ to, ...v }))
        .sort((a, b) => b.sol - a.sol);
      return { flows, lastTime };
    },

    async walk(target, maxDepth) {
      const nodes = [], edges = [], hits = [];
      const seen = new Set();
      let rootAddr, rootLabel;

      if (target.kind === "signature") {
        this.log(".. hydrating root transaction");
        const tx = await this._tx(target.value);
        if (!tx) throw new Error("transaction unreachable or unknown");
        /* primary debtor = account with the largest SOL debit */
        const keys = (tx.transaction.message.accountKeys || []);
        let best = -1, bestDebit = 0;
        keys.forEach((k, i) => {
          if (C.PROGRAM_IDS.has(k.pubkey)) return;
          const d = (tx.meta.postBalances[i] || 0) - (tx.meta.preBalances[i] || 0);
          if (d < bestDebit) { bestDebit = d; best = i; }
        });
        if (best < 0) throw new Error("no SOL debit found in transaction");
        rootAddr = keys[best].pubkey;
        this.log(`.. primary debtor ${short(rootAddr)} (−${fmtSol(-bestDebit / 1e9)} SOL)`, "ok");
      } else {
        rootAddr = target.value;
      }
      rootLabel = WATCH.has(rootAddr)
        ? WATCH.get(rootAddr).entity + " (watched)" : short(rootAddr);

      const root = { id: rootAddr, label: rootLabel, kind: "root", depth: 0, sol: 0 };
      nodes.push(root);
      seen.add(rootAddr);
      this.setBadge("WALKING");
      this.log(".. collecting recent outbound transfers (temporal window opens at receipt)");

      /* frontier entries: {addr, node, afterMs, depth, inheritedSol} */
      let frontier = [{ addr: rootAddr, node: root, afterMs: 0, depth: 0, inheritedSol: null }];

      while (frontier.length && this.requests < C.API.TRACE_MAX_REQUESTS) {
        const next = [];
        for (const f of frontier) {
          if (f.depth >= maxDepth) continue;
          const { flows } = await this._outflows(f.addr, f.afterMs, C.API.TRACE_TX_PER_HOP + (f.depth === 0 ? 2 : 0));
          if (!flows.length) {
            if (f.depth === 0) this.log(".. no outbound SOL transfers found in window", "dim");
            continue;
          }
          const totalOut = flows.reduce((s, x) => s + x.sol, 0);
          if (f.depth === 0) root.sol = totalOut;

          for (const flow of flows.slice(0, C.API.TRACE_MAX_FANOUT)) {
            const w = WATCH.get(flow.to);
            if (w) {
              /* direct custodial endpoint */
              const id = flow.to + ":" + f.depth;
              nodes.push({ id, label: w.entity, kind: "cex", depth: f.depth + 1, sol: flow.sol });
              edges.push({ from: f.node.id, to: id, sol: flow.sol });
              hits.push({ entity: w.entity, etype: w.type, sol: flow.sol, depth: f.depth + 1, tag: w.tag });
              this.log(`## CUSTODIAL ENDPOINT — ${fmtSol(flow.sol)} SOL → ${w.entity} [${w.tag}] at hop ${f.depth + 1}`, "hit");

              /* D-01: if the forwarding node was an intermediate,
               * register it as an inferred deposit address */
              if (f.inheritedSol) {
                const ratio = flow.sol / f.inheritedSol;
                const dtSec = Math.max(0, (flow.time - f.afterMs) / 1000);
                if (AIRTAG.Detect.DepositRegistry.note(f.addr, w.entity, ratio, dtSec, flow.sig)) {
                  f.node.kind = "deposit";
                  f.node.label = short(f.addr) + " ⤳" + w.entity;
                  this.log(`## D-01 INFERENCE — ${short(f.addr)} attributed as ${w.entity} deposit address (fwd ${(ratio * 100).toFixed(0)}% in ${Math.round(dtSec)}s)`, "hit");
                }
              }
              continue;
            }
            if (seen.has(flow.to)) continue;
            seen.add(flow.to);
            const node = { id: flow.to, label: short(flow.to), kind: "unknown", depth: f.depth + 1, sol: flow.sol };
            nodes.push(node);
            edges.push({ from: f.node.id, to: flow.to, sol: flow.sol });
            this.log(`.. hop ${f.depth + 1}: ${fmtSol(flow.sol)} SOL → ${short(flow.to)}`);
            next.push({ addr: flow.to, node, afterMs: flow.time || Date.now(), depth: f.depth + 1, inheritedSol: flow.sol });
          }
          this.graph = { nodes, edges, hits };
          this.render();
        }
        frontier = next;
      }

      this.graph = { nodes, edges, hits };
      this.render();
      this.renderHits(hits, root.sol);
      this.log(`>> trace complete — ${nodes.length} nodes · ${edges.length} edges · ${hits.length} custodial hit(s) · ${this.requests}/${C.API.TRACE_MAX_REQUESTS} rpc calls`, "ok");
      this.setBadge(hits.length ? hits.length + " HIT(S)" : "CLEAN");
      if (!hits.length) {
        this.log(".. no watchlisted endpoint reached in window — widen depth, or the funds are still at rest", "dim");
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
      this.renderHits(this.graph.hits, this.graph.nodes[0].sol);
      for (const h of this.graph.hits) {
        this.log(`## CUSTODIAL ENDPOINT — ${fmtSol(h.sol)} SOL → ${h.entity} at hop ${h.depth}`, "hit");
      }
      this.setBadge("DEMO · " + this.graph.hits.length + " HIT(S)");
    },

    renderHits(hits, rootSol) {
      if (!hits.length) {
        this.hitsEl.innerHTML = '<div class="empty-note">no custodial endpoints in graph</div>';
        return;
      }
      const byEntity = {};
      for (const h of hits) {
        byEntity[h.entity] = byEntity[h.entity] || { sol: 0, etype: h.etype };
        byEntity[h.entity].sol += h.sol;
      }
      this.hitsEl.innerHTML = Object.entries(byEntity).map(([name, o]) => {
        const pct = rootSol > 0 ? Math.min(100, o.sol / rootSol * 100).toFixed(1) : "—";
        return `<div class="hit-row"><span class="he">▲ ${name} <span style="opacity:.6">${o.etype}</span></span>` +
               `<span class="hv">${fmtSol(o.sol)} SOL · ${pct}% exposure</span></div>`;
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

      const maxSol = Math.max(1e-9, ...edges.map((e) => e.sol));
      const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));

      for (const e of edges) {
        const a = nodeById[e.from], b = nodeById[e.to];
        if (!a || !b) continue;
        ctx.strokeStyle = b.kind === "cex" ? "rgba(250,178,25,0.55)"
          : b.kind === "deposit" ? "rgba(25,158,112,0.5)"
          : "rgba(255,255,255,0.14)";
        ctx.lineWidth = Math.max(1, (e.sol / maxSol) * 4);
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
        if (n.kind !== "unknown" && n.sol > 0) {
          ctx.fillStyle = col("--ink-muted");
          ctx.fillText(fmtSol(n.sol) + " SOL", n.x, n.y + r + 12);
        }
      }
    },
  };

  AIRTAG.Trace = Trace;
})();
