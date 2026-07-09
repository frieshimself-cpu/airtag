/* ============================================================
 * VEDANT // app.js
 * Orchestrator — Robinhood Chain edition.
 * Boot, telemetry pollers, websocket wiring, whale discovery,
 * Blockscout feed sweeps + venue scans, unified feed, detection
 * panels, alerting, scope, heatmap, systems strip, threat, ticker.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const Rpc = AIRTAG.Rpc;
  const Detect = AIRTAG.Detect;

  /* ---------- formatting helpers ---------- */

  AIRTAG.fmtUsd = function (v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return Math.round(v).toString();
  };
  const fmtAmt = (v) => {
    if (v == null) return "—";
    return v >= 1000 ? Math.round(v).toLocaleString("en-US")
      : v >= 1 ? v.toFixed(3) : v >= 0.001 ? v.toFixed(5) : v.toFixed(7);
  };
  const pad = (n) => String(n).padStart(2, "0");
  function fmtTime(ms) {
    const d = new Date(ms);
    const hhmmss = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    if (Date.now() - ms > 86_400_000) {
      const MON = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
      return `${MON[d.getUTCMonth()]}-${pad(d.getUTCDate())} ${hhmmss.slice(0, 5)}`;
    }
    return hhmmss;
  }
  const short = (h) => h.length > 12 ? h.slice(0, 6) + "…" + h.slice(-4) : h;

  /* ---------- state ---------- */

  const State = {
    ethPrice: null,
    events: [],
    seen: new Set(),
    paused: false,
    alerts: [],
    filters: { entity: "", dir: "", src: "", minUsd: 0 },
    rotation: 0,
    clock: 0,
    addStamps: [],
    wsSweepPending: false,
    lastWsSweep: 0,
  };
  const FALLBACK_ETH = 1700;
  AIRTAG.appPrice = () => State.ethPrice || FALLBACK_ETH;

  /* live internals surfaced to the systems strip (fx.js) */
  AIRTAG.Metrics = {
    get queueDepth()      { return State.wsSweepPending ? 1 : 0; },
    get eventCount()      { return State.events.length; },
    get throughputPerMin() {
      const cut = Date.now() - 60_000;
      while (State.addStamps.length && State.addStamps[0] < cut) State.addStamps.shift();
      return State.addStamps.length;
    },
    get detectorHits()    { const c = Detect.counters(); return c.deposits + c.bursts + c.round + c.bridge; },
    get vclock()          { return State.clock; },
  };

  /* watch registry: static venues (lowercased) + discovered whales */
  const STATIC_WATCH = new Map(C.WATCHLIST.map((w) => [w.addr.toLowerCase(), w]));
  AIRTAG.whaleMap = new Map();
  function watchMap() {
    const m = new Map(STATIC_WATCH);
    for (const [k, v] of AIRTAG.whaleMap) m.set(k, v);
    return m;
  }
  const POLL_ORDER = [...C.WATCHLIST].sort((a, b) => a.priority - b.priority);

  /* ---------- boot sequence ---------- */

  const BOOT_LINES = [
    ["mod", "vedant-core        ", "loading attribution graph shard 04/16 (robinhood-mainnet · chain-id 4663)"],
    ["ok",  "vedant-core        ", "graph mounted — 38.4M clusters resident"],
    ["mod", "data-plane         ", "JSON-RPC rpc.mainnet.chain.robinhood.com + Blockscout REST · bucket 2.5 rps"],
    ["mod", "ws-lane            ", "eth_subscribe newHeads → push-triggered feed sweeps"],
    ["mod", "venue-registry     ", "arming WETH vault · PoolManager · RH Router · ArbSys bridge-exit"],
    ["mod", "whale-discovery    ", "resolving top-balance EOAs from Blockscout top-accounts"],
    ["mod", "decoder            ", "native ETH-value + ERC-20 method decode lanes online"],
    ["mod", "detectors          ", "arming D-01 deposit-inference · D-02 burst · D-03 round · D-04 bridge"],
    ["warn","detectors          ", "H-17 cross-chain matcher in warm-up (model v9 @ 62%)"],
    ["mod", "token-module       ", "$VEDANT module in STANDBY — no contract bound (pending launch)"],
    ["mod", "rules              ", "R-07 threshold engine armed ($250K / risk 85)"],
    ["mod", "sim-layer          ", "instant-swap intercept simulation online [SRC=HEUR]"],
    ["ok",  "vedant             ", "all subsystems nominal — entering live mode"],
  ];

  async function bootSequence() {
    const el = document.getElementById("boot-log");
    for (const [cls, mod, msg] of BOOT_LINES) {
      await new Promise((r) => setTimeout(r, 120 + Math.random() * 200));
      const line = document.createElement("div");
      line.innerHTML = `<span class="${cls}">[${cls === "warn" ? "WARN" : cls === "ok" ? " OK " : "LOAD"}]</span> <span class="mod">${mod}</span> ${msg}`;
      el.appendChild(line);
    }
    await new Promise((r) => setTimeout(r, 380));
    document.body.dataset.mode = "live";
  }

  /* ---------- topbar telemetry ---------- */

  function startClock() {
    const el = document.getElementById("tm-clock");
    setInterval(() => {
      const d = new Date();
      el.textContent = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    }, 1000);
  }

  Rpc.onState((s) => {
    const dot = document.getElementById("link-dot");
    const label = document.getElementById("link-state");
    dot.className = "status-dot " +
      (s === "WS-LIVE" ? "live" : s === "RPC-POLL" ? "poll" : s === "REPLAY" ? "degraded" : "");
    label.textContent = s === "REPLAY" ? "REPLAY (synthetic)" : s;
  });

  let telemetryTick = 0;
  async function pollTelemetry() {
    const wantChart = telemetryTick++ % 3 === 0;
    const [block, stats, chart] = await Promise.all([
      Rpc.blockNumber(),
      Rpc.stats(),
      wantChart ? Rpc.dailyTxChart() : Promise.resolve(null),
    ]);
    if (block != null) setBlock(block);
    if (stats && !stats.notFound) {
      if (stats.coin_price) {
        State.ethPrice = parseFloat(stats.coin_price);
        document.getElementById("tm-price").textContent =
          "$" + State.ethPrice.toLocaleString("en-US", { maximumFractionDigits: 2 });
      }
      const chg = stats.coin_price_change_percentage;
      const deltaEl = document.getElementById("tm-price-delta");
      if (chg != null) {
        const up = chg >= 0;
        deltaEl.textContent = (up ? "▲" : "▼") + Math.abs(chg).toFixed(1) + "%";
        deltaEl.className = "tm-delta " + (up ? "up" : "down");
      } else { deltaEl.textContent = ""; }
      if (stats.gas_prices) {
        document.getElementById("tm-gas").textContent =
          (stats.gas_prices.average != null ? stats.gas_prices.average : stats.gas_prices.slow) + "";
      }
      const util = (stats.network_utilization_percentage || 0) * 100;
      document.getElementById("tm-util-bar").style.width = Math.min(100, Math.max(1, util)).toFixed(1) + "%";
      document.getElementById("tm-util-pct").textContent = util < 0.01 ? "<0.01%" : util.toFixed(2) + "%";
    }
    if (chart && chart.length) {
      AIRTAG.Throughput.setDaily(chart);
      const latest = chart[0].transactions_count;
      document.getElementById("tm-tps").textContent =
        latest >= 1e6 ? (latest / 1e6).toFixed(2) + "M" : (latest / 1e3).toFixed(0) + "K";
    }
    document.getElementById("tm-latency").textContent =
      Rpc.lastLatencyMs != null ? Rpc.lastLatencyMs + " ms" : "n/a";
    document.getElementById("tm-calls").textContent = Rpc.callCount.toLocaleString("en-US");
  }

  let lastBlockDom = 0;
  function setBlock(b) {
    if (b <= lastBlockDom) return;
    lastBlockDom = b;
    State.clock++;
    document.getElementById("tm-slot").textContent = b.toLocaleString("en-US");
  }

  /* ---------- whale discovery ---------- */

  async function discoverWhales() {
    const accts = await Rpc.topAccounts();
    if (!accts) return;
    const eoas = accts.filter((a) => !a.is_contract && a.hash).slice(0, C.WHALE_SLOTS);
    const map = new Map();
    eoas.forEach((a, i) => {
      const entity = "WHALE-" + pad(i + 1);
      const bal = (parseInt(a.coin_balance || "0", 10) / 1e18);
      map.set(a.hash.toLowerCase(), { entity, tag: bal.toFixed(0) + " ETH", type: "WHALE", addr: a.hash.toLowerCase() });
    });
    AIRTAG.whaleMap = map;
  }

  /* ---------- feed ---------- */

  function riskClass(r) {
    return r >= 85 ? "r-crit" : r >= 60 ? "r-high" : r >= 35 ? "r-med" : "r-low";
  }

  function addEvent(ev, { fresh = true } = {}) {
    const key = ev.sig + "|" + ev.entity;
    if (State.seen.has(key)) return false;
    State.seen.add(key);
    if (ev.risk == null) {
      const burstSize = Detect.Burst.push(ev.entity, ev.time);
      ev.risk = Detect.riskScore(ev, { burstSize });
    }
    State.events.push(ev);
    if (State.events.length > 700) {
      const drop = State.events.splice(0, State.events.length - 700);
      drop.forEach((d) => State.seen.delete(d.sig + "|" + d.entity));
    }
    State.clock++;
    if (fresh) {
      State.addStamps.push(Date.now());
      checkAlerts(ev);
      if (AIRTAG.Topology.canvas) AIRTAG.Topology.emit(ev);
      if (AIRTAG.Scope) AIRTAG.Scope.push(ev);
    }
    return true;
  }

  function passesFilters(ev) {
    const f = State.filters;
    if (f.entity && ev.entity !== f.entity) return false;
    if (f.dir && ev.dir !== f.dir) return false;
    if (f.src === "HEUR" && ev.src !== "HEUR") return false;
    if (f.src === "CHAIN" && ev.src === "HEUR") return false; // CHAIN = WS + RPC
    if (f.minUsd && (ev.usd || 0) < f.minUsd) return false;
    return true;
  }

  function renderFeed(markFresh) {
    if (State.paused) return;
    const body = document.getElementById("feed-body");
    const rows = State.events
      .filter(passesFilters)
      .sort((a, b) => b.time - a.time)
      .slice(0, 90);
    body.innerHTML = rows.map((ev, i) => {
      const real = ev.src !== "HEUR";
      const sigCell = real
        ? `<a class="txid" href="${C.CHAIN.EXPLORER_TX}${ev.sig}" target="_blank" rel="noopener">${ev.sig.slice(0, 8)}…${ev.sig.slice(-6)}</a>`
        : `<span class="txid synth" title="heuristic intercept — not chain-attested">${ev.sig.slice(0, 8)}…${ev.sig.slice(-6)}</span>`;
      const dirChip = ev.dir === "IN" ? '<span class="chip dir-in">IN → VENUE</span>'
        : ev.dir === "OUT" ? '<span class="chip dir-out">VENUE → OUT</span>'
        : '<span class="chip dir-swap">SWAP</span>';
      const srcChip = ev.src === "WS" ? '<span class="chip src-ws">WS</span>'
        : ev.src === "RPC" ? '<span class="chip src-rpc">RPC</span>'
        : '<span class="chip src-heur">HEUR</span>';
      const assetLabel = ev.asset === "ERC-20" && ev.method ? ev.method : (ev.pair || ev.asset);
      const asset = assetLabel + (ev.bridgeTouch ? ' <span class="bridge-flag" title="bridge exit / ArbSys (D-04)">⛓</span>' : "");
      const cp = ev.counterparty
        ? (real
            ? `<a class="cp" href="${C.CHAIN.EXPLORER_ADDR}${ev.counterparty}" target="_blank" rel="noopener" title="${ev.counterparty}">${short(ev.counterparty)}</a>`
            : `<span class="cp" title="${ev.counterparty}">${short(ev.counterparty)}</span>`)
        : "—";
      return `<tr class="${markFresh && i === 0 ? "fresh" : ""}">
        <td>${fmtTime(ev.time)}</td>
        <td>${sigCell}</td>
        <td class="entity-tag">${ev.entity} <span class="etype">${ev.etype}·${ev.tag || ""}</span></td>
        <td>${dirChip}</td>
        <td>${asset}</td>
        <td class="num">${ev.amount != null ? fmtAmt(ev.amount) : "—"}</td>
        <td class="num">$${AIRTAG.fmtUsd(ev.usd || 0)}</td>
        <td>${cp}</td>
        <td><div class="risk-cell ${riskClass(ev.risk)}"><div class="risk-bar"><div class="risk-fill" style="width:${ev.risk}%"></div></div><span class="risk-val">${ev.risk}</span></div></td>
        <td>${srcChip}</td>
      </tr>`;
    }).join("");
  }

  /* ---------- websocket lane ---------- */

  function wireWs() {
    Rpc.onBlock = (block) => {
      setBlock(block);
      /* push-triggered sweep, debounced to ≤ 1 / 8s */
      const now = Date.now();
      if (now - State.lastWsSweep < 8000) return;
      State.lastWsSweep = now;
      State.wsSweepPending = true;
      feedSweep("WS").finally(() => { State.wsSweepPending = false; });
    };
    Rpc.startWs();
  }

  /* ---------- global latest-tx sweep (Blockscout) ---------- */

  async function feedSweep(src) {
    const txs = await Rpc.latestTxs();
    if (!txs) return;
    const wm = watchMap();
    let added = 0;
    for (const t of txs) {
      const ev = AIRTAG.Decode.flowEvent(t, wm);
      if (!ev) continue;
      ev.src = src;
      if (addEvent(ev)) added++;
    }
    if (added) refreshAnalytics(true);
  }

  /* ---------- per-venue history scan ---------- */

  async function venueScan(initial = false) {
    const n = initial ? POLL_ORDER.length : C.API.VENUES_PER_CYCLE;
    const wm = watchMap();
    for (let k = 0; k < n; k++) {
      const w = POLL_ORDER[State.rotation % POLL_ORDER.length];
      State.rotation++;
      const items = await Rpc.addressTxs(w.addr);
      if (!items) continue;
      let added = 0;
      for (const t of items.slice(0, 6)) {
        const ev = AIRTAG.Decode.flowEvent(t, wm);
        if (!ev) continue;
        ev.src = "RPC";
        if (addEvent(ev, { fresh: !initial })) added++;
      }
      if (added) refreshAnalytics(!initial);
    }
  }

  /* ---------- swap-service simulation loop (SRC=HEUR) ---------- */

  function swapLoop() {
    addEvent(Detect.swapEvent(AIRTAG.appPrice()));
    refreshAnalytics(true);
    setTimeout(swapLoop, Detect.swapGapMs());
  }

  /* ---------- analytics ---------- */

  function refreshAnalytics(markFresh = false) {
    const now = Date.now();
    const day = State.events.filter((e) => now - e.time < 86_400_000);

    let inUsd = 0, outUsd = 0;
    const byEntity = {};
    for (const e of day) {
      const usd = e.usd || 0;
      if (e.dir === "IN") inUsd += usd;
      else if (e.dir === "OUT") outUsd += usd;
      byEntity[e.entity] = byEntity[e.entity] || { usd: 0, etype: e.etype };
      byEntity[e.entity].usd += usd;
    }
    const net = inUsd - outUsd;
    const elNet = document.getElementById("st-netflow");
    elNet.textContent = (net >= 0 ? "+$" : "−$") + AIRTAG.fmtUsd(Math.abs(net));
    elNet.className = "st-value " + (net >= 0 ? "in" : "out");
    document.getElementById("st-netflow-foot").textContent =
      net >= 0 ? "net inflow to venues (sell-side risk)" : "net outflow from venues (accumulation)";
    document.getElementById("st-inflow").textContent = "$" + AIRTAG.fmtUsd(inUsd);
    document.getElementById("st-outflow").textContent = "$" + AIRTAG.fmtUsd(outUsd);
    document.getElementById("st-deposits").textContent = Detect.DepositRegistry.count();
    document.getElementById("st-bridge").textContent = Detect.counters().bridge;

    AIRTAG.Netflow.setData(day);
    AIRTAG.Exposure.render(byEntity);
    if (AIRTAG.Heatmap) AIRTAG.Heatmap.render(State.events);
    renderFeed(markFresh);
    renderDepositRegistry();
    updateThreat(day);
  }

  function updateThreat(day) {
    if (!AIRTAG.Fx) return;
    const now = Date.now();
    const recent = day.filter((e) => now - e.time < 15 * 60_000);
    const avgRisk = recent.length ? recent.reduce((s, e) => s + (e.risk || 0), 0) / recent.length : 0;
    const alertBoost = Math.min(28, State.alerts.length * 6);
    const whale = recent.some((e) => (e.usd || 0) >= C.THRESHOLDS.WHALE_USD) ? 12 : 0;
    const bridge = recent.some((e) => e.bridgeTouch) ? 8 : 0;
    AIRTAG.Fx.Threat.set(avgRisk * 0.72 + alertBoost + whale + bridge);
  }

  /* ---------- alerts ---------- */

  function checkAlerts(ev) {
    const t = C.THRESHOLDS;
    if ((ev.usd || 0) < t.ALERT_USD && (ev.risk || 0) < t.ALERT_RISK) return;
    const sev = (ev.usd >= t.WHALE_USD || ev.risk >= 92) ? "critical"
      : ev.risk >= t.ALERT_RISK ? "serious" : "warning";
    State.alerts.unshift({ ev, sev });
    State.alerts = State.alerts.slice(0, 30);
    renderAlerts();
  }

  function renderAlerts() {
    const list = document.getElementById("alert-list");
    document.getElementById("st-alerts").textContent = State.alerts.length;
    if (!State.alerts.length) {
      list.innerHTML = '<div class="empty-note">no active alerts — thresholds armed</div>';
      return;
    }
    list.innerHTML = State.alerts.map(({ ev, sev }) => `
      <div class="alert-card ${sev}">
        <div class="ac-head"><span>${ev.entity} · ${ev.dir}</span><span class="ac-sev">${sev.toUpperCase()}</span></div>
        <div class="ac-body">$${AIRTAG.fmtUsd(ev.usd || 0)} ${ev.pair || ev.asset} · risk ${ev.risk} · ${fmtTime(ev.time)} · ${ev.src}${ev.bridgeTouch ? " · ⛓ bridge" : ""}</div>
      </div>`).join("");
  }

  /* ---------- detection stack panel ---------- */

  function renderDetectors() {
    const ul = document.getElementById("heur-list");
    const c = Detect.counters();
    const liveVals = { "D-01": c.deposits, "D-02": c.bursts, "D-03": c.round, "D-04": c.bridge };
    ul.innerHTML = C.DETECTORS.map((d) => {
      if (d.kind === "live") {
        return `<li class="heur-item">
          <span class="heur-name"><span class="heur-id">[${d.id}]</span> ${d.name}</span>
          <span class="heur-state on">LIVE · <b>${liveVals[d.id] ?? 0}</b> hits</span>
        </li>`;
      }
      const conf = Math.max(0.02, Math.min(0.998, d.base + (Math.random() * 0.04 - 0.02)));
      const warm = d.base < 0.7;
      return `<li class="heur-item">
        <span class="heur-name"><span class="heur-id">[${d.id}]</span> ${d.name}</span>
        <span class="heur-state ${warm ? "warm" : "on"}">${warm ? "WARM-UP" : "MODEL"}</span>
        <span class="heur-conf"><span class="heur-track"><span class="heur-fill" style="width:${(conf * 100).toFixed(1)}%; display:block"></span></span><span class="heur-pct">${(conf * 100).toFixed(1)}%</span></span>
      </li>`;
    }).join("");
  }

  function renderDepositRegistry() {
    const el = document.getElementById("dep-list");
    const rows = Detect.DepositRegistry.rows();
    if (!rows.length) {
      el.innerHTML = '<div class="empty-note">none inferred yet — run a trace through an intermediate wallet</div>';
      return;
    }
    el.innerHTML = rows.map(([addr, m]) => `
      <div class="dep-row">
        <a class="txid" href="${C.CHAIN.EXPLORER_ADDR}${addr}" target="_blank" rel="noopener">${short(addr)}</a>
        <span class="dep-ent">⤳ ${m.entity}</span>
        <span class="dep-ev">fwd ${(m.ratio * 100).toFixed(0)}% in ${Math.round(m.dtSec)}s</span>
      </div>`).join("");
  }

  /* ---------- ticker ---------- */

  function buildTicker() {
    const track = document.getElementById("ticker-track");
    track.innerHTML = C.TICKER_LINES.map((l, i) =>
      `<span>${i % 3 === 0 ? '<span class="t-hl">◈</span> ' : ""}${l}</span>`).join("") +
      `<span class="t-warn">⚠ SRC=HEUR rows are simulation-layer output — chain-attested rows carry SRC=WS/RPC and link to the explorer</span>`;
  }

  /* ---------- controls ---------- */

  function wireControls() {
    const entSel = document.getElementById("feed-filter-entity");
    C.ENTITIES.forEach((e) => {
      const o = document.createElement("option");
      o.value = e.name; o.textContent = e.name.toUpperCase() + " · " + e.type;
      entSel.appendChild(o);
    });
    entSel.addEventListener("change", () => { State.filters.entity = entSel.value; renderFeed(); });
    document.getElementById("feed-filter-dir").addEventListener("change", (e) => {
      State.filters.dir = e.target.value; renderFeed();
    });
    document.getElementById("feed-filter-src").addEventListener("change", (e) => {
      State.filters.src = e.target.value; renderFeed();
    });
    document.getElementById("feed-min-usd").addEventListener("input", (e) => {
      State.filters.minUsd = parseFloat(e.target.value) || 0; renderFeed();
    });
    const pauseBtn = document.getElementById("feed-pause");
    pauseBtn.addEventListener("click", () => {
      State.paused = !State.paused;
      pauseBtn.textContent = State.paused ? "RESUME" : "PAUSE";
      if (!State.paused) renderFeed();
    });
    document.getElementById("alerts-ack").addEventListener("click", () => {
      State.alerts = []; renderAlerts();
    });
  }

  /* mission-bar token identity — driven by CONFIG.TOKEN.ca so that
   * re-arming the token is a single config edit (empty → CA PENDING) */
  function renderTokenIdentity() {
    const code = document.getElementById("mca-code");
    const copy = document.getElementById("mca-copy");
    if (C.TOKEN.ca) {
      if (code) code.textContent = C.TOKEN.ca;
      if (copy) {
        copy.hidden = false;
        copy.onclick = () => {
          const done = () => { copy.textContent = "COPIED ✓"; setTimeout(() => (copy.textContent = "COPY"), 1400); };
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(C.TOKEN.ca).then(done).catch(() => {});
        };
      }
    } else {
      if (code) code.textContent = "CA PENDING";
      if (copy) copy.hidden = true;
    }
  }

  /* ---------- init ---------- */

  async function init() {
    AIRTAG.Fx.init();
    AIRTAG.Netflow.init();
    AIRTAG.Throughput.init();
    AIRTAG.Exposure.init();
    AIRTAG.Heatmap.init();
    AIRTAG.Scope.init();
    AIRTAG.Topology.init();
    AIRTAG.Token.init();
    AIRTAG.Trace.init();
    wireControls();
    renderTokenIdentity();
    renderDetectors();
    buildTicker();
    startClock();

    const boot = bootSequence();

    /* try to land live telemetry + whales before backfill, but never block */
    await Promise.race([
      Promise.all([pollTelemetry(), discoverWhales()]),
      new Promise((r) => setTimeout(r, 5000)),
    ]);
    setInterval(pollTelemetry, C.API.POLL_TELEMETRY_MS);
    setInterval(discoverWhales, 120_000);
    setInterval(renderDetectors, 5000);

    /* HEUR backfill so the 24h analytics open populated */
    Detect.backfill(AIRTAG.appPrice()).forEach((ev) => addEvent(ev, { fresh: false }));
    State.events
      .filter((e) => (e.usd || 0) >= C.THRESHOLDS.ALERT_USD || (e.risk || 0) >= C.THRESHOLDS.ALERT_RISK)
      .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      .slice(0, 4)
      .forEach(checkAlerts);
    refreshAnalytics();

    await boot;

    /* live lanes */
    wireWs();
    feedSweep("RPC");
    venueScan(true);
    setInterval(() => feedSweep("RPC"), C.API.POLL_FEED_MS);
    setInterval(() => venueScan(false), C.API.POLL_VENUE_CYCLE_MS);
    setTimeout(swapLoop, 5000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
