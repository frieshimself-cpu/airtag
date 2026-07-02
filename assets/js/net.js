/* ============================================================
 * AIRTAG // net.js
 * Data-plane layer: live chain telemetry + watched-wallet scans.
 * Degrades gracefully: every consumer receives either live data
 * or null, and the link-state indicator reflects reality.
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  const Net = {
    state: "SYNCING",          // SYNCING | LIVE | DEGRADED
    lastLatencyMs: null,
    _listeners: [],

    onState(fn) { this._listeners.push(fn); },

    _setState(s) {
      if (s !== this.state) {
        this.state = s;
        this._listeners.forEach((fn) => fn(s));
      }
    },

    async _get(path, { base = C.API.MEMPOOL_BASE, raw = false, timeoutMs = 7000 } = {}) {
      const url = path.startsWith("http") ? path : base + path;
      const t0 = performance.now();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
        this.lastLatencyMs = Math.round(performance.now() - t0);
        if (!res.ok) throw new Error("HTTP " + res.status);
        this._setState("LIVE");
        return raw ? res.text() : res.json();
      } catch (err) {
        this._setState("DEGRADED");
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    /* ---- chain telemetry ---- */

    async tipHeight() {
      const t = await this._get("/blocks/tip/height", { raw: true });
      return t == null ? null : parseInt(t, 10);
    },

    async fees() {
      return this._get("/v1/fees/recommended"); // {fastestFee,...}
    },

    async mempool() {
      return this._get("/mempool"); // {count, vsize, total_fee}
    },

    async price() {
      const p = await this._get("/v1/prices"); // {time, USD, EUR, ...}
      return p && typeof p.USD === "number" ? p.USD : null;
    },

    async priceHistory24h() {
      const d = await this._get(C.API.COINGECKO_CHART);
      if (!d || !Array.isArray(d.prices)) return null;
      return d.prices.map(([t, v]) => ({ t, v })); // ~288 points
    },

    /* ---- watched-wallet scanning ----
     * Computes the watched address's balance delta per tx:
     *   +delta → deposit INTO the exchange wallet  (IN)
     *   -delta → withdrawal OUT of the wallet      (OUT)
     */
    async scanAddress(w) {
      const txs = await this._get(`/address/${w.addr}/txs`);
      if (!Array.isArray(txs)) return null;
      return txs.slice(0, 25).map((tx) => {
        let recv = 0, spent = 0;
        for (const vout of tx.vout || []) {
          if (vout.scriptpubkey_address === w.addr) recv += vout.value;
        }
        for (const vin of tx.vin || []) {
          if (vin.prevout && vin.prevout.scriptpubkey_address === w.addr) {
            spent += vin.prevout.value;
          }
        }
        const deltaSat = recv - spent;
        const confirmed = !!(tx.status && tx.status.confirmed);
        return {
          txid: tx.txid,
          deltaBtc: deltaSat / 1e8,
          dir: deltaSat >= 0 ? "IN" : "OUT",
          time: confirmed ? tx.status.block_time * 1000 : Date.now(),
          confirmed,
          entity: w.entity,
          etype: w.type,
          tag: w.tag,
          src: confirmed ? "CHAIN" : "MEMPOOL",
        };
      }).filter((r) => Math.abs(r.deltaBtc) > 1e-6);
    },

    /* ---- trace primitives (used by trace.js) ---- */

    async tx(txid)        { return this._get(`/tx/${txid}`); },
    async outspends(txid) { return this._get(`/tx/${txid}/outspends`); },
    async addressTxs(addr){ return this._get(`/address/${addr}/txs`); },
  };

  AIRTAG.Net = Net;
})();
