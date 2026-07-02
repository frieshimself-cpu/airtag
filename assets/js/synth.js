/* ============================================================
 * AIRTAG // synth.js
 * Heuristic simulation layer.
 *
 * Instant-swap services rotate deposit addresses per order and
 * publish no wallet set, so no public API can attest their flow.
 * This layer generates statistically plausible intercept events
 * (log-normal notionals, Poisson arrivals, entity-weighted
 * routing) so the analytic surfaces stay populated. Everything
 * it emits is tagged SRC=HEUR and is illustrative only.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  const HEX = "0123456789abcdef";
  function fakeTxid() {
    let s = "";
    for (let i = 0; i < 64; i++) s += HEX[(Math.random() * 16) | 0];
    return s;
  }

  /* log-normal notional, clamped to a believable band */
  function logNormalUsd(mu, sigma) {
    const u1 = Math.random(), u2 = Math.random();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.exp(mu + sigma * z);
  }

  function pickWeighted(list) {
    const total = list.reduce((s, e) => s + e.weight, 0);
    let r = Math.random() * total;
    for (const e of list) { r -= e.weight; if (r <= 0) return e; }
    return list[list.length - 1];
  }

  /* Composite risk model (the scoring itself is real logic —
   * only the underlying event may be synthetic):
   *  base(entity) + size component + automation signature
   *  + privacy-asset destination premium. */
  function riskScore(entity, usd, pair) {
    let r = entity.baseRisk;
    if (usd > 250_000)   r += 8;
    if (usd > 1_000_000) r += 10;
    if (usd > 5_000_000) r += 12;
    const btc = usd; // proxy: round-notional detection on USD figure
    if (Math.abs(btc / 10_000 - Math.round(btc / 10_000)) < 0.004) r += 6; // suspiciously round
    if (pair && pair.includes("XMR")) r += 18;
    if (pair && pair.includes("TRC20")) r += 5;
    r += (Math.random() * 8 - 4); // heuristic ensemble jitter
    return Math.max(3, Math.min(99, Math.round(r)));
  }

  const Synth = {
    riskScore,
    fakeTxid,

    /* One synthetic intercept event. */
    event(btcUsd) {
      const entity = pickWeighted(C.ENTITIES);
      const isSwap = entity.type === "SWAP";
      const usd = Math.min(
        logNormalUsd(isSwap ? 10.4 : 11.6, 1.25),
        48_000_000
      );
      const pair = isSwap
        ? C.SWAP_PAIRS[(Math.random() * C.SWAP_PAIRS.length) | 0]
        : "BTC";
      const dir = isSwap ? "SWAP" : (Math.random() < 0.53 ? "IN" : "OUT");
      return {
        txid: fakeTxid(),
        time: Date.now(),
        entity: entity.name,
        etype: entity.type,
        tag: isSwap ? "order-intercept" : "hot-cluster",
        dir,
        pair,
        amountBtc: btcUsd ? usd / btcUsd : null,
        usd,
        risk: riskScore(entity, usd, pair),
        src: "HEUR",
        confirmed: false,
      };
    },

    /* Poisson-ish next arrival gap (ms). */
    nextGapMs() {
      return 2500 + Math.random() * 9500;
    },

    /* Backfill: seed the last 24h so charts open populated. */
    backfill(btcUsd, hours = 24) {
      const out = [];
      const now = Date.now();
      const n = 90 + ((Math.random() * 40) | 0);
      for (let i = 0; i < n; i++) {
        const e = this.event(btcUsd);
        e.time = now - Math.random() * hours * 3600_000;
        e.confirmed = true;
        out.push(e);
      }
      return out.sort((a, b) => a.time - b.time);
    },

    /* Synthetic demo trace graph for the console's DEMO mode. */
    demoTrace(depth = 3) {
      const nodes = [{ id: "root", label: "SOURCE", kind: "root", depth: 0, btc: 14.2 }];
      const edges = [];
      const hits = [];
      let counter = 0;
      const swapEntities = C.ENTITIES.filter((e) => e.type === "SWAP");
      const walk = (parent, d, btc) => {
        if (d > depth) return;
        const fan = 1 + ((Math.random() * 2.4) | 0);
        for (let i = 0; i < fan; i++) {
          const share = btc * (0.25 + Math.random() * 0.6);
          const id = "n" + (++counter);
          const isHit = d >= 2 && Math.random() < 0.34;
          let node;
          if (isHit) {
            const ent = Math.random() < 0.6
              ? swapEntities[(Math.random() * swapEntities.length) | 0]
              : C.ENTITIES[(Math.random() * 8) | 0];
            node = { id, label: ent.name, kind: ent.type === "SWAP" ? "swap" : "cex", depth: d, btc: share };
            hits.push({ entity: ent.name, etype: ent.type, btc: share, depth: d });
          } else {
            node = { id, label: fakeTxid().slice(0, 8) + "…", kind: "unknown", depth: d, btc: share };
          }
          nodes.push(node);
          edges.push({ from: parent.id, to: id, btc: share });
          if (!isHit) walk(node, d + 1, share);
        }
      };
      walk(nodes[0], 1, nodes[0].btc);
      return { nodes, edges, hits, synthetic: true };
    },
  };

  AIRTAG.Synth = Synth;
})();
