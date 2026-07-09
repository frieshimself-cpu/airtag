/* ============================================================
 * VEDANT // rpc.js
 * Robinhood Chain data plane (EVM L2, chain-id 4663).
 *
 *  - JSON-RPC over HTTPS against rpc.mainnet.chain.robinhood.com
 *    (eth_blockNumber, eth_gasPrice, …).
 *  - Blockscout REST v2 for rich data: stats, latest txs,
 *    per-address histories, top accounts, tokens, daily charts.
 *  - One global token bucket shared by BOTH lanes so the console
 *    stays polite to public infrastructure no matter how many
 *    consumers fire (feed sweeps, venue scans, tracer, token
 *    module).
 *  - WebSocket lane: eth_subscribe("newHeads") for push block
 *    notifications, with auto-reconnect + exponential backoff.
 *
 * Plane states: SYNCING → WS-LIVE (push + poll) / RPC-POLL
 * (http only) / REPLAY (all upstreams unreachable).
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  /* ---------- token bucket ---------- */
  const bucket = {
    tokens: C.CHAIN.BUCKET_CAPACITY,
    last: performance.now(),
    async take() {
      for (;;) {
        const now = performance.now();
        this.tokens = Math.min(
          C.CHAIN.BUCKET_CAPACITY,
          this.tokens + ((now - this.last) / 1000) * C.CHAIN.BUCKET_REFILL_PER_SEC
        );
        this.last = now;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await new Promise((r) => setTimeout(r, (1 - this.tokens) / C.CHAIN.BUCKET_REFILL_PER_SEC * 1000 + 15));
      }
    },
  };

  const Rpc = {
    state: "SYNCING",            // SYNCING | WS-LIVE | RPC-POLL | REPLAY
    lastLatencyMs: null,
    callCount: 0,
    _httpAlive: false,
    _wsAlive: false,
    _listeners: [],
    _id: 0,

    /* live internals surfaced to the systems strip */
    bucketLevel() { return Math.max(0, Math.min(1, bucket.tokens / C.CHAIN.BUCKET_CAPACITY)); },
    wsSubCount() { return this._wsSubs.size; },
    endpointLabel() {
      try { return new URL(C.CHAIN.RPC_HTTP).host.split(".").slice(-3, -1).join("."); }
      catch { return "—"; }
    },

    onState(fn) { this._listeners.push(fn); },

    _recompute() {
      const s = this._wsAlive ? "WS-LIVE" : this._httpAlive ? "RPC-POLL" : "REPLAY";
      if (s !== this.state) {
        this.state = s;
        this._listeners.forEach((fn) => fn(s));
      }
    },

    /* ---------- JSON-RPC lane ---------- */

    async call(method, params = []) {
      await bucket.take();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), C.CHAIN.TIMEOUT_MS);
      const t0 = performance.now();
      try {
        const res = await fetch(C.CHAIN.RPC_HTTP, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++this._id, method, params }),
          signal: ctl.signal,
        });
        this.lastLatencyMs = Math.round(performance.now() - t0);
        if (!res.ok) throw new Error("HTTP " + res.status);
        const body = await res.json();
        this.callCount++;
        this._httpAlive = true; this._recompute();
        return body.error ? { error: body.error } : { result: body.result };
      } catch {
        this._httpAlive = false; this._recompute();
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    /* ---------- Blockscout REST lane (same bucket) ---------- */

    async rest(path) {
      await bucket.take();
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), C.CHAIN.TIMEOUT_MS);
      const t0 = performance.now();
      try {
        const res = await fetch(C.CHAIN.BLOCKSCOUT + path, { cache: "no-store", signal: ctl.signal });
        this.lastLatencyMs = Math.round(performance.now() - t0);
        if (res.status === 404) { this.callCount++; this._httpAlive = true; this._recompute(); return { notFound: true }; }
        if (!res.ok) throw new Error("HTTP " + res.status);
        const body = await res.json();
        this.callCount++;
        this._httpAlive = true; this._recompute();
        return body;
      } catch {
        this._httpAlive = false; this._recompute();
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    /* ---------- typed helpers ---------- */

    async blockNumber() {
      const r = await this.call("eth_blockNumber");
      return r && r.result ? parseInt(r.result, 16) : null;
    },

    async gasPriceGwei() {
      const r = await this.call("eth_gasPrice");
      return r && r.result ? parseInt(r.result, 16) / 1e9 : null;
    },

    async stats()        { return this.rest("/stats"); },              // coin_price, gas_prices, utilization…
    async latestTxs()    { const r = await this.rest("/main-page/transactions"); return Array.isArray(r) ? r : (r && r.items) || null; },
    async addressTxs(a)  { const r = await this.rest(`/addresses/${a}/transactions`); return r && r.items ? r.items : null; },
    async txDetail(h)    { return this.rest(`/transactions/${h}`); },
    async topAccounts()  { const r = await this.rest("/addresses"); return r && r.items ? r.items : null; },
    async dailyTxChart() { const r = await this.rest("/stats/charts/transactions"); return r && r.chart_data ? r.chart_data : null; },

    /* ---------- websocket lane (eth_subscribe newHeads) ---------- */

    ws: null,
    _wsSubs: new Map(),          // server sub id → handler
    _wsPending: new Map(),       // request id → handler
    _wsBackoff: 0,
    onBlock: null,               // (blockNumber) => void

    startWs() {
      let sock;
      try { sock = new WebSocket(C.CHAIN.RPC_WS); }
      catch { return this._scheduleWsRetry(); }
      this.ws = sock;

      sock.onopen = () => {
        this._wsBackoff = 0;
        this._wsAlive = true; this._recompute();
        this._wsSend("eth_subscribe", ["newHeads"], (head) => {
          if (this.onBlock && head && head.number) this.onBlock(parseInt(head.number, 16));
        });
      };

      sock.onmessage = (m) => {
        let msg; try { msg = JSON.parse(m.data); } catch { return; }
        if (msg.id != null && this._wsPending.has(msg.id)) {
          this._wsSubs.set(msg.result, this._wsPending.get(msg.id));
          this._wsPending.delete(msg.id);
        } else if (msg.method === "eth_subscription" && msg.params && this._wsSubs.has(msg.params.subscription)) {
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
      const delay = Math.min(60_000, C.CHAIN.WS_RECONNECT_BASE_MS * Math.pow(2, this._wsBackoff++));
      setTimeout(() => this.startWs(), delay);
    },
  };

  AIRTAG.Rpc = Rpc;
})();
