/* ============================================================
 * AIRTAG // rpc.js
 * Solana data plane.
 *
 *  - JSON-RPC over HTTPS with endpoint failover: a request that
 *    times out, 429s, or 5xxs rotates the chain to the next
 *    endpoint with exponential cool-down on the failed one.
 *  - Global token-bucket rate limiter so the console stays well
 *    inside public endpoint quotas no matter how many consumers
 *    (feed poller, trace engine, websocket tx hydration) fire.
 *  - WebSocket lane: slotSubscribe for the live slot counter and
 *    logsSubscribe(mentions=[wallet]) on priority-1 custodial
 *    wallets for push detection; auto-reconnect with backoff.
 *
 * Plane states: SYNCING → WS-LIVE (push + poll) / RPC-POLL
 * (http only) / REPLAY (all upstreams unreachable).
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  /* ---------- token bucket ---------- */
  const bucket = {
    tokens: C.RPC.BUCKET_CAPACITY,
    last: performance.now(),
    async take() {
      for (;;) {
        const now = performance.now();
        this.tokens = Math.min(
          C.RPC.BUCKET_CAPACITY,
          this.tokens + ((now - this.last) / 1000) * C.RPC.BUCKET_REFILL_PER_SEC
        );
        this.last = now;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await new Promise((r) => setTimeout(r, (1 - this.tokens) / C.RPC.BUCKET_REFILL_PER_SEC * 1000 + 15));
      }
    },
  };

  const Rpc = {
    state: "SYNCING",            // SYNCING | WS-LIVE | RPC-POLL | REPLAY
    lastLatencyMs: null,
    callCount: 0,
    _epIdx: 0,
    _cooldown: new Map(),        // endpoint idx → not-before timestamp
    _httpAlive: false,
    _wsAlive: false,
    _listeners: [],
    _id: 0,

    onState(fn) { this._listeners.push(fn); },

    _recompute() {
      const s = this._wsAlive ? "WS-LIVE" : this._httpAlive ? "RPC-POLL" : "REPLAY";
      if (s !== this.state) {
        this.state = s;
        this._listeners.forEach((fn) => fn(s));
      }
    },

    _pickEndpoint() {
      const n = C.RPC.ENDPOINTS.length;
      for (let k = 0; k < n; k++) {
        const idx = (this._epIdx + k) % n;
        if ((this._cooldown.get(idx) || 0) <= Date.now()) return idx;
      }
      return this._epIdx; // all cooling — use current anyway
    },

    async call(method, params = []) {
      await bucket.take();
      const idx = this._pickEndpoint();
      const ep = C.RPC.ENDPOINTS[idx];
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), C.RPC.TIMEOUT_MS);
      const t0 = performance.now();
      try {
        const res = await fetch(ep.http, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this._id, method, params }),
          signal: ctl.signal,
        });
        this.lastLatencyMs = Math.round(performance.now() - t0);
        if (res.status === 429 || res.status >= 500) throw new Error("HTTP " + res.status);
        const body = await res.json();
        if (body.error) {
          /* node-side error (e.g. tx not found) — endpoint is healthy */
          this.callCount++;
          this._httpAlive = true; this._epIdx = idx; this._recompute();
          return { error: body.error };
        }
        this.callCount++;
        this._httpAlive = true; this._epIdx = idx; this._recompute();
        return { result: body.result };
      } catch (err) {
        /* rotate: cool the failed endpoint down, try the next */
        this._cooldown.set(idx, Date.now() + 20_000);
        const nextIdx = this._pickEndpoint();
        if (nextIdx !== idx) {
          this._epIdx = nextIdx;
          clearTimeout(timer);
          return this.call(method, params);
        }
        this._httpAlive = false; this._recompute();
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    /* ---------- typed helpers ---------- */

    async epochInfo() {
      const r = await this.call("getEpochInfo");
      return r && r.result ? r.result : null;
    },

    async perfSamples(n = 180) {
      const r = await this.call("getRecentPerformanceSamples", [n]);
      return r && Array.isArray(r.result) ? r.result : null;
    },

    async signaturesFor(addr, opts = {}) {
      const r = await this.call("getSignaturesForAddress", [addr, { commitment: "confirmed", ...opts }]);
      return r && Array.isArray(r.result) ? r.result : null;
    },

    async transaction(sig) {
      const r = await this.call("getTransaction", [sig, {
        encoding: "jsonParsed",
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      }]);
      return r ? r.result || null : null;
    },

    async solPrice() {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 7000);
      try {
        const res = await fetch(C.API.COINGECKO_PRICE, { cache: "no-store", signal: ctl.signal });
        if (!res.ok) return null;
        const j = await res.json();
        return j && j.solana ? { usd: j.solana.usd, change24h: j.solana.usd_24h_change } : null;
      } catch { return null; }
      finally { clearTimeout(timer); }
    },

    /* ---------- websocket lane ---------- */

    ws: null,
    _wsSubs: new Map(),          // server sub id → handler
    _wsPending: new Map(),       // request id → handler (awaiting sub confirmation)
    _wsBackoff: 0,
    onSlot: null,                // (slot) => void
    onWalletLog: null,           // (walletAddr, signature) => void

    startWs() {
      const ep = C.RPC.ENDPOINTS[this._epIdx];
      let sock;
      try { sock = new WebSocket(ep.ws); }
      catch { return this._scheduleWsRetry(); }
      this.ws = sock;

      sock.onopen = () => {
        this._wsBackoff = 0;
        this._wsAlive = true; this._recompute();
        this._wsSend("slotSubscribe", [], (slot) => {
          if (this.onSlot && slot && typeof slot.slot === "number") this.onSlot(slot.slot);
        });
        const prio = C.WATCHLIST.filter((w) => w.priority === 1).slice(0, C.RPC.WS_MAX_LOG_SUBS);
        for (const w of prio) {
          this._wsSend("logsSubscribe", [{ mentions: [w.addr] }, { commitment: "confirmed" }], (v) => {
            if (this.onWalletLog && v && v.value && !v.value.err) this.onWalletLog(w.addr, v.value.signature);
          });
        }
      };

      sock.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.id != null && this._wsPending.has(msg.id)) {
          /* subscription confirmed: result = server sub id */
          this._wsSubs.set(msg.result, this._wsPending.get(msg.id));
          this._wsPending.delete(msg.id);
        } else if (msg.method && msg.params && this._wsSubs.has(msg.params.subscription)) {
          this._wsSubs.get(msg.params.subscription)(msg.params.result);
        }
      };

      sock.onclose = () => { this._wsAlive = false; this._recompute(); this._scheduleWsRetry(); };
      sock.onerror = () => { try { sock.close(); } catch {} };
    },

    _wsSend(method, params, handler) {
      const id = ++this._id;
      this._wsPending.set(id, handler);
      try { this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
      catch { this._wsPending.delete(id); }
    },

    _scheduleWsRetry() {
      this._wsSubs.clear(); this._wsPending.clear();
      const delay = Math.min(60_000, C.RPC.WS_RECONNECT_BASE_MS * Math.pow(2, this._wsBackoff++));
      setTimeout(() => this.startWs(), delay);
    },
  };

  AIRTAG.Rpc = Rpc;
})();
