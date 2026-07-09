/* ============================================================
 * VEDANT // decode.js
 * Robinhood Chain transaction normalization — turns a Blockscout
 * v2 transaction object into a flow event:
 *
 *  - direction relative to the watch registry (venues + whales):
 *    to∈watch → IN (into venue/custody), from∈watch → OUT
 *  - native ETH value (wei → ETH) with live USD conversion
 *  - counterparty = the opposite side of the transfer
 *  - bridge-touch flag when the tx involves the ArbSys exit
 *    precompile or an L1→L2 deposit-style method (feeds D-04)
 *  - zero-value ERC-20 interactions surface as method calls
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;
  const lower = (h) => (h || "").toLowerCase();

  const BRIDGE_METHODS = new Set([
    "withdrawEth", "sendTxToL1", "outboundTransfer", "executeTransaction",
    "finalizeInboundTransfer", "createRetryableTicket",
  ]);

  const Decode = {
    /* bsTx: Blockscout v2 tx object; watchMap: lowercased addr → watch entry.
     * Returns a normalized event or null (dust / irrelevant). */
    flowEvent(bsTx, watchMap) {
      if (!bsTx || bsTx.status === "error") return null;
      const fromH = lower(bsTx.from && bsTx.from.hash);
      const toH = lower(bsTx.to && bsTx.to.hash);
      const wFrom = watchMap.get(fromH) || null;
      const wTo = watchMap.get(toH) || null;

      const eth = parseInt(bsTx.value || "0", 10) / 1e18;
      const price = AIRTAG.appPrice ? AIRTAG.appPrice() : 0;
      const usd = eth * price;

      const types = bsTx.tx_types || bsTx.transaction_types || [];
      const isTokenOnly = eth < 1e-9 && types.includes("token_transfer");
      const bridgeTouch =
        fromH === C.ARBSYS || toH === C.ARBSYS ||
        BRIDGE_METHODS.has(bsTx.method) ||
        types.includes("rollup");

      /* attribution: prefer the watched side; unattributed large
       * transfers surface under the Unattributed entity */
      let watched = wTo || wFrom, dir, counterparty;
      if (wTo)       { dir = "IN";  counterparty = fromH; }
      else if (wFrom){ dir = "OUT"; counterparty = toH; }
      else {
        if (eth < C.API.FEED_MIN_UNATTRIB_ETH && !bridgeTouch) return null;
        watched = { entity: "Unattributed", tag: "large-transfer", type: "WHALE" };
        dir = "OUT"; counterparty = toH;
      }
      if (eth < 1e-9 && !isTokenOnly && !bridgeTouch) return null;

      const ts = bsTx.timestamp ? Date.parse(bsTx.timestamp) : Date.now();
      return {
        sig: bsTx.hash,
        time: isNaN(ts) ? Date.now() : ts,
        entity: watched.entity,
        etype: watched.type,
        tag: watched.tag,
        dir,
        asset: isTokenOnly ? "ERC-20" : "ETH",
        method: bsTx.method || null,
        amount: isTokenOnly ? null : eth,
        usd: isTokenOnly ? 0 : usd,
        counterparty: counterparty || null,
        bridgeTouch,
      };
    },

    /* Outgoing native transfers from `addr` across a list of its
     * Blockscout txs, time-gated for the tracer. */
    outgoing(items, addr, afterMs) {
      const a = lower(addr);
      const out = [];
      for (const t of items || []) {
        if (t.status === "error") continue;
        if (lower(t.from && t.from.hash) !== a) continue;
        const eth = parseInt(t.value || "0", 10) / 1e18;
        if (eth < 1e-6) continue;
        const ts = t.timestamp ? Date.parse(t.timestamp) : 0;
        if (afterMs && ts < afterMs - 60_000) continue;
        const to = lower(t.to && t.to.hash);
        if (!to) continue;
        out.push({ to, eth, hash: t.hash, time: ts });
      }
      return out.sort((x, y) => x.time - y.time);
    },
  };

  AIRTAG.Decode = Decode;
})();
