/* ============================================================
 * VEDANT // detect.js
 * Detection engines — Robinhood Chain edition. D-01…D-04 are
 * REAL: they compute over observed chain events and expose live
 * counters. The swap-service simulation layer lives here too
 * (SRC=HEUR, illustrative).
 *
 *  D-01 deposit-address inference: an address that receives funds
 *       and forwards ≥85% into a watched venue within 2h is
 *       attributed as a hot-path/deposit address for that venue.
 *  D-02 burst detector: ≥3 arrivals for one entity inside 90s —
 *       the signature of batched/automated movement.
 *  D-03 round-notional signature: transfers in round ETH units
 *       (10/50/100/500/1k) indicate scripted treasury ops.
 *  D-04 bridge exposure: tx routed via the ArbSys exit precompile
 *       or L1-deposit machinery.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  /* ---------- D-01: inferred deposit-address registry ---------- */
  const DepositRegistry = {
    map: new Map(), // addr → {entity, ratio, dtSec, firstSeen, viaSig}
    note(addr, entity, ratio, dtSec, viaSig) {
      if (this.map.has(addr)) return false;
      if (ratio < C.DETECT.FORWARD_MIN_RATIO || dtSec > C.DETECT.FORWARD_WINDOW_S) return false;
      this.map.set(addr, { entity, ratio, dtSec, firstSeen: Date.now(), viaSig });
      return true;
    },
    lookup(addr) { return this.map.get(addr) || null; },
    count() { return this.map.size; },
    rows() {
      return [...this.map.entries()]
        .sort((a, b) => b[1].firstSeen - a[1].firstSeen)
        .slice(0, 12);
    },
  };

  /* ---------- D-02: burst detector ---------- */
  const Burst = {
    times: new Map(),   // entity → [timestamps]
    total: 0,
    push(entity, t) {
      const arr = this.times.get(entity) || [];
      arr.push(t);
      const cutoff = t - C.DETECT.BURST_WINDOW_MS;
      while (arr.length && arr[0] < cutoff) arr.shift();
      this.times.set(entity, arr);
      if (arr.length >= C.DETECT.BURST_MIN) { this.total++; return arr.length; }
      return 0;
    },
  };

  /* ---------- D-03: round-notional ---------- */
  let roundHits = 0;
  function isRoundEth(amount) {
    for (const u of C.DETECT.ROUND_ETH_UNITS) {
      if (amount >= u && Math.abs(amount / u - Math.round(amount / u)) < 0.002) { roundHits++; return true; }
    }
    return false;
  }

  /* ---------- D-04 counter ---------- */
  let bridgeHits = 0;
  function noteBridge() { bridgeHits++; }

  /* ---------- composite risk over real features ---------- */
  function riskScore(ev, { burstSize = 0, inferredHop = false } = {}) {
    const ent = C.ENTITIES.find((e) => e.name === ev.entity);
    let r = ent ? ent.baseRisk : 25;
    const usd = ev.usd || 0;
    if (usd > 50_000)    r += 6;
    if (usd > 250_000)   r += 10;
    if (usd > 1_000_000) r += 12;
    if (ev.asset === "ETH" && ev.amount && isRoundEth(ev.amount)) r += 8;   // D-03
    if (burstSize >= C.DETECT.BURST_MIN) r += 6 + Math.min(8, burstSize);   // D-02
    if (ev.bridgeTouch) { r += 15; noteBridge(); }                          // D-04
    if (inferredHop) r += 12;                                               // D-01 hop
    if (ev.pair && ev.pair.includes("XMR")) r += 18;                        // privacy-asset leg (sim)
    if (ev.pair && ev.pair.includes("TRC20")) r += 5;
    return Math.max(3, Math.min(99, Math.round(r)));
  }

  /* ---------- simulation layer (SRC=HEUR) ---------- */
  const HEXC = "0123456789abcdef";
  function fakeHash(len = 64) {
    let s = "0x";
    for (let i = 0; i < len; i++) s += HEXC[(Math.random() * 16) | 0];
    return s;
  }

  function logNormalUsd(mu, sigma) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(mu + sigma * z);
  }

  function swapEvent(ethUsd) {
    const swaps = C.ENTITIES.filter((e) => e.type === "SWAP");
    const total = swaps.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total, entity = swaps[swaps.length - 1];
    for (const e of swaps) { r -= e.weight; if (r <= 0) { entity = e; break; } }
    const usd = Math.min(logNormalUsd(9.6, 1.2), 5_000_000);
    const pair = C.SWAP_PAIRS[(Math.random() * C.SWAP_PAIRS.length) | 0];
    const ev = {
      sig: fakeHash(),
      time: Date.now(),
      entity: entity.name,
      etype: "SWAP",
      tag: "order-intercept",
      dir: "SWAP",
      asset: pair.split(" ")[0],
      pair,
      amount: ethUsd ? usd / ethUsd : 0,
      usd,
      src: "HEUR",
      bridgeTouch: false,
    };
    ev.risk = riskScore(ev);
    return ev;
  }

  function backfill(ethUsd, hours = 24) {
    const out = [];
    const now = Date.now();
    const n = 60 + ((Math.random() * 30) | 0);
    for (let i = 0; i < n; i++) {
      const ev = swapEvent(ethUsd);
      ev.time = now - Math.random() * hours * 3600_000;
      out.push(ev);
    }
    /* plausible venue history so the netflow chart has 24h of
     * shape before live observation catches up — tagged HEUR */
    const venues = C.ENTITIES.filter((e) => e.type === "VENUE" || e.type === "WHALE");
    for (let i = 0; i < 110; i++) {
      const e = venues[(Math.random() * venues.length) | 0];
      const usd = Math.min(logNormalUsd(10.6, 1.3), 12_000_000);
      const ev = {
        sig: fakeHash(), time: now - Math.random() * hours * 3600_000,
        entity: e.name, etype: e.type, tag: "replay", dir: Math.random() < 0.52 ? "IN" : "OUT",
        asset: "ETH",
        usd, src: "HEUR", bridgeTouch: false,
      };
      ev.amount = usd / (ethUsd || 1);
      ev.risk = riskScore(ev);
      out.push(ev);
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function swapGapMs() { return 15_000 + Math.random() * 30_000; }

  /* Synthetic demo graph for the trace console's DEMO mode. */
  function demoTrace(depth = 3) {
    const nodes = [{ id: "root", label: "SOURCE", kind: "root", depth: 0, amt: 420 }];
    const edges = [], hits = [];
    let counter = 0;
    const walk = (parent, d, amt) => {
      if (d > depth) return;
      const fan = 1 + ((Math.random() * 2.4) | 0);
      for (let i = 0; i < fan; i++) {
        const share = amt * (0.25 + Math.random() * 0.6);
        const id = "n" + (++counter);
        const isHit = d >= 2 && Math.random() < 0.35;
        const isDep = !isHit && d >= 1 && Math.random() < 0.22;
        if (isHit) {
          const venues = C.ENTITIES.filter((e) => e.type === "VENUE");
          const ent = venues[(Math.random() * venues.length) | 0];
          nodes.push({ id, label: ent.name, kind: "cex", depth: d, amt: share });
          hits.push({ entity: ent.name, etype: "VENUE", amt: share, depth: d });
        } else {
          const node = {
            id, label: fakeHash(8).slice(0, 8) + "…",
            kind: isDep ? "deposit" : "unknown", depth: d, amt: share,
          };
          nodes.push(node);
          walk(node, d + 1, share);
        }
        edges.push({ from: parent.id, to: id, amt: share });
      }
    };
    walk(nodes[0], 1, nodes[0].amt);
    return { nodes, edges, hits, synthetic: true };
  }

  AIRTAG.Detect = {
    DepositRegistry, Burst, riskScore, isRoundEth,
    counters: () => ({
      deposits: DepositRegistry.count(),
      bursts: Burst.total,
      round: roundHits,
      bridge: bridgeHits,
    }),
    swapEvent, backfill, swapGapMs, demoTrace, fakeHash,
  };
})();
