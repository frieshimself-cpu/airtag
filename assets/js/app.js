/* ============================================================
 * AIRTAG // app.js
 * Orchestrator: boot sequence, telemetry pollers, feed store,
 * filters, alerting, heuristic panel, ticker.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const Net = AIRTAG.Net;
  const Synth = AIRTAG.Synth;

  /* ---------- formatting helpers ---------- */

  AIRTAG.fmtUsd = function (v) {
    const a = Math.abs(v);
    if (a >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return Math.round(v).toString();
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

  /* ---------- state ---------- */

  const State = {
    price: null,
    priceHist: [],       // [{t, v}]
    events: [],          // unified feed (real + heuristic)
    seen: new Set(),     // txid|entity dedupe
    paused: false,
    alerts: [],
    filters: { entity: "", dir: "", src: "", minUsd: 0 },
  };
  const FALLBACK_PRICE = 100_000; // used only until first live quote lands
  const priceOr = () => State.price || FALLBACK_PRICE;

  /* ---------- boot sequence ---------- */

  const BOOT_LINES = [
    ["mod", "airtag-core        ", "loading attribution graph shard 04/16"],
    ["ok",  "airtag-core        ", "graph mounted — 41.8M clusters resident"],
    ["mod", "ingest/chain       ", "binding data plane → mempool.space public API"],
    ["mod", "ingest/watchlist   ", "arming 6 chain-watched custodial wallets"],
    ["mod", "heuristics         ", "spinning attribution stack H-01…H-17"],
    ["warn","heuristics         ", "H-17 cross-chain matcher in warm-up (model v9 @ 62%)"],
    ["mod", "rules              ", "R-07 threshold engine armed ($1.0M / risk 85)"],
    ["mod", "synth-layer        ", "swap-service intercept simulation online [SRC=HEUR]"],
    ["ok",  "airtag             ", "all subsystems nominal — entering live mode"],
  ];

  async function bootSequence() {
    const el = document.getElementById("boot-log");
    for (const [cls, mod, msg] of BOOT_LINES) {
      await new Promise((r) => setTimeout(r, 140 + Math.random() * 240));
      const line = document.createElement("div");
      line.innerHTML = `<span class="${cls}">[${cls === "warn" ? "WARN" : cls === "ok" ? " OK " : "LOAD"}]</span> <span class="mod">${mod}</span> ${msg}`;
      el.appendChild(line);
    }
    await new Promise((r) => setTimeout(r, 450));
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

  Net.onState((s) => {
    const dot = document.getElementById("link-dot");
    const label = document.getElementById("link-state");
    dot.className = "status-dot " + (s === "LIVE" ? "live" : s === "DEGRADED" ? "degraded" : "");
    label.textContent = s === "LIVE" ? "LIVE" : s === "DEGRADED" ? "REPLAY (synthetic)" : "SYNCING";
  });

  async function pollMetrics() {
    const [height, fees, mp, price] = await Promise.all([
      Net.tipHeight(), Net.fees(), Net.mempool(), Net.price(),
    ]);
    if (height != null) document.getElementById("tm-height").textContent = height.toLocaleString("en-US");
    if (fees && fees.fastestFee != null) document.getElementById("tm-fee").textContent = fees.fastestFee;
    if (mp && mp.count != null) {
      document.getElementById("tm-mempool").textContent =
        (mp.vsize / 1e6).toFixed(1) + " MvB · " + (mp.count / 1000).toFixed(1) + "k tx";
    }
    if (price != null) {
      const prev = State.price;
      State.price = price;
      document.getElementById("tm-price").textContent = "$" + price.toLocaleString("en-US");
      const deltaEl = document.getElementById("tm-price-delta");
      if (prev != null && prev !== price) {
        const up = price > prev;
        deltaEl.textContent = (up ? "▲" : "▼") + Math.abs(price - prev).toFixed(0);
        deltaEl.className = "tm-delta " + (up ? "up" : "down");
      }
      State.priceHist.push({ t: Date.now(), v: price });
      if (State.priceHist.length > 600) State.priceHist.shift();
    }
    document.getElementById("tm-latency").textContent =
      Net.lastLatencyMs != null ? Net.lastLatencyMs + " ms" : "n/a";
  }

  /* ---------- feed ---------- */

  function riskClass(r) {
    return r >= 85 ? "r-crit" : r >= 60 ? "r-high" : r >= 35 ? "r-med" : "r-low";
  }

  function addEvent(ev, { fresh = true, animate = true } = {}) {
    const key = ev.txid + "|" + ev.entity + "|" + ev.dir;
    if (State.seen.has(key)) return false;
    State.seen.add(key);
    State.events.push(ev);
    if (State.events.length > 600) {
      const drop = State.events.splice(0, State.events.length - 600);
      drop.forEach((d) => State.seen.delete(d.txid + "|" + d.entity + "|" + d.dir));
    }
    if (fresh) {
      checkAlerts(ev);
      if (animate && AIRTAG.Topology.canvas) AIRTAG.Topology.emit(ev);
    }
    return true;
  }

  function passesFilters(ev) {
    const f = State.filters;
    if (f.entity && ev.entity !== f.entity) return false;
    if (f.dir && ev.dir !== f.dir) return false;
    if (f.src === "HEUR" && ev.src !== "HEUR") return false;
    if (f.src === "CHAIN" && ev.src === "HEUR") return false; // CHAIN view includes MEMPOOL
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
      const txCell = real
        ? `<a class="txid" href="https://mempool.space/tx/${ev.txid}" target="_blank" rel="noopener">${ev.txid.slice(0, 10)}…${ev.txid.slice(-6)}</a>`
        : `<span class="txid synth" title="heuristic intercept — not chain-attested">${ev.txid.slice(0, 10)}…${ev.txid.slice(-6)}</span>`;
      const dirChip = ev.dir === "IN" ? '<span class="chip dir-in">IN → CEX</span>'
        : ev.dir === "OUT" ? '<span class="chip dir-out">CEX → OUT</span>'
        : '<span class="chip dir-swap">SWAP</span>';
      const srcChip = ev.src === "CHAIN" ? '<span class="chip src-chain">CHAIN</span>'
        : ev.src === "MEMPOOL" ? '<span class="chip src-mempool">MEMPOOL</span>'
        : '<span class="chip src-heur">HEUR</span>';
      const amt = ev.amountBtc != null ? ev.amountBtc.toFixed(4) : "—";
      return `<tr class="${markFresh && i === 0 ? "fresh" : ""}">
        <td>${fmtTime(ev.time)}</td>
        <td>${txCell}</td>
        <td class="entity-tag">${ev.entity} <span class="etype">${ev.etype}·${ev.tag || ""}</span></td>
        <td>${dirChip}</td>
        <td>${ev.pair || "BTC"}</td>
        <td class="num">${amt}</td>
        <td class="num">$${AIRTAG.fmtUsd(ev.usd || 0)}</td>
        <td><div class="risk-cell ${riskClass(ev.risk)}"><div class="risk-bar"><div class="risk-fill" style="width:${ev.risk}%"></div></div><span class="risk-val">${ev.risk}</span></div></td>
        <td>${srcChip}</td>
      </tr>`;
    }).join("");
  }

  /* ---------- real wallet scans ---------- */

  async function scanWatchlist(initial = false) {
    for (const w of C.WATCHLIST) {
      const rows = await Net.scanAddress(w);
      if (rows) {
        const entMeta = C.ENTITIES.find((e) => e.name === w.entity) || { baseRisk: 20 };
        let added = 0;
        for (const r of rows) {
          const usd = Math.abs(r.deltaBtc) * priceOr();
          const ev = {
            ...r,
            amountBtc: Math.abs(r.deltaBtc),
            usd,
            pair: "BTC",
            risk: Synth.riskScore(entMeta, usd, "BTC"),
          };
          if (addEvent(ev, { fresh: !initial })) added++;
        }
        if (added) refreshAnalytics(!initial);
      }
      await new Promise((r) => setTimeout(r, C.API.ADDRESS_STAGGER_MS));
    }
  }

  /* ---------- synthetic intercept loop ---------- */

  function synthLoop() {
    const ev = Synth.event(priceOr());
    addEvent(ev);
    refreshAnalytics(true);
    setTimeout(synthLoop, Synth.nextGapMs());
  }

  /* ---------- analytics: tiles, netflow, exposure ---------- */

  function refreshAnalytics(markFresh = false) {
    const now = Date.now();
    const day = State.events.filter((e) => now - e.time < 86_400_000);

    let inUsd = 0, outUsd = 0, swapUsd = 0;
    const byEntity = {};
    for (const e of day) {
      const usd = e.usd || 0;
      if (e.dir === "IN") inUsd += usd;
      else if (e.dir === "OUT") outUsd += usd;
      else swapUsd += usd;
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
    document.getElementById("st-swap").textContent = "$" + AIRTAG.fmtUsd(swapUsd);

    AIRTAG.Netflow.setData(day);
    AIRTAG.Exposure.render(byEntity);
    renderFeed(markFresh);
  }

  /* ---------- alerts ---------- */

  function checkAlerts(ev) {
    const t = C.THRESHOLDS;
    if ((ev.usd || 0) < t.ALERT_USD && (ev.risk || 0) < t.ALERT_RISK) return;
    const sev = (ev.usd >= t.WHALE_USD || ev.risk >= 92) ? "critical"
      : ev.risk >= t.ALERT_RISK ? "serious" : "warning";
    State.alerts.unshift({ ev, sev, time: Date.now() });
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
        <div class="ac-body">$${AIRTAG.fmtUsd(ev.usd || 0)} ${ev.pair || "BTC"} · risk ${ev.risk} · ${fmtTime(ev.time)} · ${ev.src}</div>
      </div>`).join("");
  }

  /* ---------- heuristics panel ---------- */

  function renderHeuristics() {
    const ul = document.getElementById("heur-list");
    ul.innerHTML = C.HEURISTICS.map((h) => {
      const conf = Math.max(0.02, Math.min(0.998, h.base + (Math.random() * 0.04 - 0.02)));
      const warm = h.base < 0.7;
      return `<li class="heur-item">
        <span class="heur-name"><span class="heur-id">[${h.id}]</span> ${h.name}</span>
        <span class="heur-state ${warm ? "warm" : "on"}">${warm ? "WARM-UP" : "ONLINE"}</span>
        <span class="heur-conf"><span class="heur-track"><span class="heur-fill" style="width:${(conf * 100).toFixed(1)}%; display:block"></span></span><span class="heur-pct">${(conf * 100).toFixed(1)}%</span></span>
      </li>`;
    }).join("");
  }

  /* ---------- ticker ---------- */

  function buildTicker() {
    const track = document.getElementById("ticker-track");
    const lines = [...C.TICKER_LINES];
    track.innerHTML = lines.map((l, i) =>
      `<span>${i % 3 === 0 ? '<span class="t-hl">◈</span> ' : ""}${l}</span>`).join("") +
      `<span class="t-warn">⚠ SRC=HEUR events are simulation-layer output — chain-attested rows carry SRC=CHAIN/MEMPOOL</span>`;
  }

  /* ---------- filter / control wiring ---------- */

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
    AIRTAG.Exposure.init();
    AIRTAG.Topology.init();
    AIRTAG.Trace.init();
    wireControls();
    renderHeuristics();
    buildTicker();
    startClock();

    const boot = bootSequence();

    /* try to land a live quote before backfill so USD figures are sane,
     * but never block the console on a slow/unreachable data plane */
    await Promise.race([pollMetrics(), new Promise((r) => setTimeout(r, 4500))]);
    setInterval(pollMetrics, C.API.POLL_METRICS_MS);
    setInterval(renderHeuristics, 6500);

    /* seed 24h of heuristic history so analytics open populated */
    Synth.backfill(priceOr()).forEach((ev) => addEvent(ev, { fresh: false }));
    /* arm the alert panel with the largest historical triggers */
    State.events
      .filter((e) => (e.usd || 0) >= C.THRESHOLDS.ALERT_USD || (e.risk || 0) >= C.THRESHOLDS.ALERT_RISK)
      .sort((a, b) => (b.usd || 0) - (a.usd || 0))
      .slice(0, 4)
      .forEach(checkAlerts);
    refreshAnalytics();

    await boot;

    /* live layers */
    scanWatchlist(true);
    setInterval(() => scanWatchlist(false), C.API.POLL_ADDRESSES_MS);
    setTimeout(synthLoop, 1800);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
