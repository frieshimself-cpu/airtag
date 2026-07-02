/* ============================================================
 * AIRTAG // app.js
 * Orchestrator — Solana edition.
 * Boot, telemetry pollers, websocket wiring, wallet poll
 * rotation, unified feed, detection panels, alerting, ticker.
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
  const fmtAmt = (v, asset) => {
    if (asset === "SOL") {
      return v >= 1000 ? Math.round(v).toLocaleString("en-US")
        : v >= 1 ? v.toFixed(2) : v >= 0.001 ? v.toFixed(4) : v.toFixed(6);
    }
    return v >= 1000 ? Math.round(v).toLocaleString("en-US") : v.toFixed(2);
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
  const short = (pk) => pk.slice(0, 4) + "…" + pk.slice(-4);

  /* ---------- state ---------- */

  const State = {
    solPrice: null,
    events: [],
    seen: new Set(),
    paused: false,
    alerts: [],
    filters: { entity: "", dir: "", src: "", minUsd: 0 },
    cursors: new Map(),         // wallet addr → newest seen signature
    rotation: 0,
    wsQueue: [],                // pending {watched, sig} from logsSubscribe
    wsBusy: false,
  };
  const FALLBACK_SOL = 150;
  AIRTAG.appPrice = () => State.solPrice || FALLBACK_SOL;

  const WATCH_BY_ADDR = new Map(C.WATCHLIST.map((w) => [w.addr, w]));
  const POLL_ORDER = [...C.WATCHLIST].sort((a, b) => a.priority - b.priority);

  /* ---------- boot sequence ---------- */

  const BOOT_LINES = [
    ["mod", "airtag-core        ", "loading attribution graph shard 04/16 (solana-mainnet)"],
    ["ok",  "airtag-core        ", "graph mounted — 38.4M clusters resident"],
    ["mod", "rpc-plane          ", "failover chain: publicnode → mainnet-beta · bucket 2.5 rps"],
    ["mod", "ws-lane            ", "slotSubscribe + logsSubscribe on priority-1 custodial wallets"],
    ["mod", "decoder            ", "SOL balance-delta + USDC/USDT token-delta lanes online"],
    ["mod", "detectors          ", "arming D-01 deposit-inference · D-02 burst · D-03 round · D-04 bridge"],
    ["warn","detectors          ", "H-17 cross-chain matcher in warm-up (model v9 @ 62%)"],
    ["mod", "rules              ", "R-07 threshold engine armed ($500K / risk 85)"],
    ["mod", "sim-layer          ", "instant-swap intercept simulation online [SRC=HEUR]"],
    ["ok",  "airtag             ", "all subsystems nominal — entering live mode"],
  ];

  async function bootSequence() {
    const el = document.getElementById("boot-log");
    for (const [cls, mod, msg] of BOOT_LINES) {
      await new Promise((r) => setTimeout(r, 130 + Math.random() * 220));
      const line = document.createElement("div");
      line.innerHTML = `<span class="${cls}">[${cls === "warn" ? "WARN" : cls === "ok" ? " OK " : "LOAD"}]</span> <span class="mod">${mod}</span> ${msg}`;
      el.appendChild(line);
    }
    await new Promise((r) => setTimeout(r, 400));
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
    const wantSamples = telemetryTick++ % 3 === 0; // perf samples every ~75s
    const [epoch, price, samples] = await Promise.all([
      Rpc.epochInfo(),
      Rpc.solPrice(),
      wantSamples ? Rpc.perfSamples(150) : Promise.resolve(null),
    ]);
    if (epoch) {
      setSlot(epoch.absoluteSlot);
      const pct = (epoch.slotIndex / epoch.slotsInEpoch) * 100;
      document.getElementById("tm-epoch").textContent = epoch.epoch;
      document.getElementById("tm-epoch-bar").style.width = pct.toFixed(1) + "%";
      document.getElementById("tm-epoch-pct").textContent = pct.toFixed(1) + "%";
    }
    if (price) {
      State.solPrice = price.usd;
      document.getElementById("tm-price").textContent =
        "$" + price.usd.toLocaleString("en-US", { maximumFractionDigits: 2 });
      const deltaEl = document.getElementById("tm-price-delta");
      if (typeof price.change24h === "number") {
        const up = price.change24h >= 0;
        deltaEl.textContent = (up ? "▲" : "▼") + Math.abs(price.change24h).toFixed(1) + "%";
        deltaEl.className = "tm-delta " + (up ? "up" : "down");
      }
    }
    if (samples && samples.length) {
      AIRTAG.Throughput.setSamples(samples);
      const recent = samples.slice(0, 3);
      const tps = recent.reduce((s, x) => s + x.numTransactions / (x.samplePeriodSecs || 60), 0) / recent.length;
      document.getElementById("tm-tps").textContent = Math.round(tps).toLocaleString("en-US");
    }
    document.getElementById("tm-latency").textContent =
      Rpc.lastLatencyMs != null ? Rpc.lastLatencyMs + " ms" : "n/a";
    document.getElementById("tm-calls").textContent = Rpc.callCount.toLocaleString("en-US");
  }

  let lastSlotDom = 0;
  function setSlot(slot) {
    if (slot <= lastSlotDom) return;
    lastSlotDom = slot;
    document.getElementById("tm-slot").textContent = slot.toLocaleString("en-US");
  }

  /* ---------- unified feed ---------- */

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
    if (fresh) {
      checkAlerts(ev);
      if (AIRTAG.Topology.canvas) AIRTAG.Topology.emit(ev);
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
        ? `<a class="txid" href="https://solscan.io/tx/${ev.sig}" target="_blank" rel="noopener">${ev.sig.slice(0, 8)}…${ev.sig.slice(-6)}</a>`
        : `<span class="txid synth" title="heuristic intercept — not chain-attested">${ev.sig.slice(0, 8)}…${ev.sig.slice(-6)}</span>`;
      const dirChip = ev.dir === "IN" ? '<span class="chip dir-in">IN → CEX</span>'
        : ev.dir === "OUT" ? '<span class="chip dir-out">CEX → OUT</span>'
        : '<span class="chip dir-swap">SWAP</span>';
      const srcChip = ev.src === "WS" ? '<span class="chip src-ws">WS</span>'
        : ev.src === "RPC" ? '<span class="chip src-rpc">RPC</span>'
        : '<span class="chip src-heur">HEUR</span>';
      const asset = (ev.pair || ev.asset) + (ev.bridgeTouch ? ' <span class="bridge-flag" title="bridge program invoked (D-04)">⛓</span>' : "");
      const cp = ev.counterparty
        ? `<span class="cp" title="${ev.counterparty}">${short(ev.counterparty)}</span>` : "—";
      return `<tr class="${markFresh && i === 0 ? "fresh" : ""}">
        <td>${fmtTime(ev.time)}</td>
        <td>${sigCell}</td>
        <td class="entity-tag">${ev.entity} <span class="etype">${ev.etype}·${ev.tag || ""}</span></td>
        <td>${dirChip}</td>
        <td>${asset}</td>
        <td class="num">${fmtAmt(ev.amount || 0, ev.asset)}</td>
        <td class="num">$${AIRTAG.fmtUsd(ev.usd || 0)}</td>
        <td>${cp}</td>
        <td><div class="risk-cell ${riskClass(ev.risk)}"><div class="risk-bar"><div class="risk-fill" style="width:${ev.risk}%"></div></div><span class="risk-val">${ev.risk}</span></div></td>
        <td>${srcChip}</td>
      </tr>`;
    }).join("");
  }

  /* ---------- websocket lane ---------- */

  function wireWs() {
    Rpc.onSlot = (slot) => setSlot(slot);
    Rpc.onWalletLog = (addr, sig) => {
      const watched = WATCH_BY_ADDR.get(addr);
      if (!watched || State.seen.has(sig + "|" + watched.entity)) return;
      if (State.wsQueue.length > 24) State.wsQueue.shift(); // shed load, keep newest
      State.wsQueue.push({ watched, sig });
      drainWsQueue();
    };
    Rpc.startWs();
  }

  async function drainWsQueue() {
    if (State.wsBusy) return;
    State.wsBusy = true;
    while (State.wsQueue.length) {
      const { watched, sig } = State.wsQueue.shift();
      const tx = await Rpc.transaction(sig);
      const ev = tx && AIRTAG.Decode.flowEvent(tx, watched);
      if (ev) {
        ev.src = "WS";
        if (addEvent(ev)) refreshAnalytics(true);
      }
    }
    State.wsBusy = false;
  }

  /* ---------- wallet poll rotation ---------- */

  async function pollWave(initial = false) {
    const n = initial ? POLL_ORDER.length : C.API.WALLETS_PER_CYCLE;
    for (let k = 0; k < n; k++) {
      const w = POLL_ORDER[State.rotation % POLL_ORDER.length];
      State.rotation++;
      const opts = { limit: initial ? 4 : 8 };
      const cursor = State.cursors.get(w.addr);
      if (cursor) opts.until = cursor;
      const sigs = await Rpc.signaturesFor(w.addr, opts);
      if (!sigs || !sigs.length) continue;
      State.cursors.set(w.addr, sigs[0].signature);
      const fresh = sigs.filter((s) => !s.err).slice(0, C.API.TX_FETCH_PER_WALLET);
      let added = 0;
      for (const s of fresh) {
        if (State.seen.has(s.signature + "|" + w.entity)) continue;
        const tx = await Rpc.transaction(s.signature);
        const ev = tx && AIRTAG.Decode.flowEvent(tx, w);
        if (ev) {
          ev.src = "RPC";
          if (addEvent(ev, { fresh: !initial })) added++;
        }
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
      net >= 0 ? "net deposit pressure (sell-side risk)" : "net withdrawal pressure (accumulation)";
    document.getElementById("st-inflow").textContent = "$" + AIRTAG.fmtUsd(inUsd);
    document.getElementById("st-outflow").textContent = "$" + AIRTAG.fmtUsd(outUsd);
    document.getElementById("st-deposits").textContent = Detect.DepositRegistry.count();

    AIRTAG.Netflow.setData(day);
    AIRTAG.Exposure.render(byEntity);
    renderFeed(markFresh);
    renderDepositRegistry();
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
        <a class="txid" href="https://solscan.io/account/${addr}" target="_blank" rel="noopener">${short(addr)}</a>
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

  /* ---------- init ---------- */

  async function init() {
    AIRTAG.Netflow.init();
    AIRTAG.Throughput.init();
    AIRTAG.Exposure.init();
    AIRTAG.Topology.init();
    AIRTAG.Trace.init();
    wireControls();
    renderDetectors();
    buildTicker();
    startClock();

    const boot = bootSequence();

    /* try to land live telemetry before backfill, but never block */
    await Promise.race([pollTelemetry(), new Promise((r) => setTimeout(r, 4500))]);
    setInterval(pollTelemetry, C.API.POLL_TELEMETRY_MS);
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
    pollWave(true);
    setInterval(() => pollWave(false), C.API.POLL_WALLET_CYCLE_MS);
    setTimeout(swapLoop, 5000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
