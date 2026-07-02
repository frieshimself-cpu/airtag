/* ============================================================
 * AIRTAG // decode.js
 * Solana transaction decoding — turns a jsonParsed getTransaction
 * payload into a normalized flow event relative to one watched
 * wallet:
 *
 *  - native SOL delta from meta.pre/postBalances at the wallet's
 *    account index (covers system transfers regardless of which
 *    program moved the lamports)
 *  - SPL stablecoin deltas from meta.pre/postTokenBalances for
 *    tracked mints (USDC / USDT), matched by token-account OWNER
 *  - counterparty = the non-program account with the largest
 *    opposite-sign delta in the same asset
 *  - bridge-touch flag when any invoked account is a known
 *    cross-chain bridge program (feeds detector D-04)
 * ============================================================ */

(function () {
  const C = AIRTAG.CONFIG;

  function keyList(tx) {
    /* jsonParsed accountKeys: [{pubkey, signer, writable, source}] */
    const msg = tx.transaction && tx.transaction.message;
    return (msg && msg.accountKeys) || [];
  }

  function tokenDeltasFor(meta, owner) {
    const out = {};
    const scan = (arr, sign) => {
      for (const b of arr || []) {
        const mint = C.ASSETS.MINTS[b.mint];
        if (!mint || b.owner !== owner) continue;
        const amt = (b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0;
        out[mint.sym] = (out[mint.sym] || 0) + sign * amt;
      }
    };
    scan(meta.preTokenBalances, -1);
    scan(meta.postTokenBalances, +1);
    return out; // {USDC: +123.4, ...}
  }

  function counterpartySol(tx, keys, watchedIdx, wantSign) {
    const meta = tx.meta;
    let best = null, bestAbs = 0;
    for (let i = 0; i < keys.length; i++) {
      if (i === watchedIdx) continue;
      const pk = keys[i].pubkey;
      if (C.PROGRAM_IDS.has(pk) || C.BRIDGE_PROGRAMS.has(pk)) continue;
      const d = (meta.postBalances[i] || 0) - (meta.preBalances[i] || 0);
      if (Math.sign(d) !== wantSign) continue;
      if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); best = pk; }
    }
    return best;
  }

  function counterpartyToken(meta, watchedOwner, sym, wantSign) {
    const byOwner = {};
    const scan = (arr, sign) => {
      for (const b of arr || []) {
        const mint = C.ASSETS.MINTS[b.mint];
        if (!mint || mint.sym !== sym || b.owner === watchedOwner) continue;
        const amt = (b.uiTokenAmount && b.uiTokenAmount.uiAmount) || 0;
        byOwner[b.owner] = (byOwner[b.owner] || 0) + sign * amt;
      }
    };
    scan(meta.preTokenBalances, -1);
    scan(meta.postTokenBalances, +1);
    let best = null, bestAbs = 0;
    for (const [owner, d] of Object.entries(byOwner)) {
      if (Math.sign(d) !== wantSign) continue;
      if (Math.abs(d) > bestAbs) { bestAbs = Math.abs(d); best = owner; }
    }
    return best;
  }

  const Decode = {
    /* → normalized event or null (vote/no-op/failed txs). */
    flowEvent(tx, watched) {
      if (!tx || !tx.meta || tx.meta.err) return null;
      const keys = keyList(tx);
      const idx = keys.findIndex((k) => k.pubkey === watched.addr);
      if (idx < 0) return null;

      const meta = tx.meta;
      const lamportDelta = (meta.postBalances[idx] || 0) - (meta.preBalances[idx] || 0);
      let solDelta = lamportDelta / 1e9;
      /* the fee payer's delta includes the fee — don't misread a
       * pure fee debit as an outflow */
      if (idx === 0) solDelta += (meta.fee || 0) / 1e9;

      const tokens = tokenDeltasFor(meta, watched.addr);
      const bridgeTouch = keys.some((k) => C.BRIDGE_PROGRAMS.has(k.pubkey));

      /* choose the dominant movement (SOL vs stablecoin) */
      const legs = [];
      if (Math.abs(solDelta) > 1e-6) legs.push({ asset: "SOL", delta: solDelta });
      for (const [sym, d] of Object.entries(tokens)) {
        if (Math.abs(d) > 1e-6) legs.push({ asset: sym, delta: d });
      }
      if (!legs.length) return null;

      const price = AIRTAG.appPrice ? AIRTAG.appPrice() : 0;
      legs.forEach((l) => { l.usd = Math.abs(l.delta) * (l.asset === "SOL" ? price : 1); });
      legs.sort((a, b) => b.usd - a.usd);
      const main = legs[0];

      const wantSign = main.delta > 0 ? -1 : 1; // counterparty moved the other way
      const counterparty = main.asset === "SOL"
        ? counterpartySol(tx, keys, idx, wantSign)
        : counterpartyToken(meta, watched.addr, main.asset, wantSign);

      return {
        sig: tx.transaction.signatures[0],
        slot: tx.slot,
        time: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
        entity: watched.entity,
        etype: watched.type,
        tag: watched.tag,
        dir: main.delta > 0 ? "IN" : "OUT",
        asset: main.asset,
        amount: Math.abs(main.delta),
        usd: main.usd,
        counterparty,
        bridgeTouch,
        legs: legs.length,
      };
    },

    /* Outgoing transfers from `addr` in a tx — for the tracer. */
    outgoing(tx, addr) {
      if (!tx || !tx.meta || tx.meta.err) return [];
      const keys = keyList(tx);
      const idx = keys.findIndex((k) => k.pubkey === addr);
      if (idx < 0) return [];
      const meta = tx.meta;
      let d = (meta.postBalances[idx] || 0) - (meta.preBalances[idx] || 0);
      if (idx === 0) d += meta.fee || 0;
      if (d >= -1e4) return []; // not a meaningful SOL debit (>0.00001 SOL)
      const out = [];
      for (let i = 0; i < keys.length; i++) {
        if (i === idx) continue;
        const pk = keys[i].pubkey;
        if (C.PROGRAM_IDS.has(pk) || C.BRIDGE_PROGRAMS.has(pk)) continue;
        const gain = (meta.postBalances[i] || 0) - (meta.preBalances[i] || 0);
        if (gain > 1e4) {
          out.push({ to: pk, sol: gain / 1e9, sig: tx.transaction.signatures[0], time: (tx.blockTime || 0) * 1000 });
        }
      }
      return out.sort((a, b) => b.sol - a.sol);
    },
  };

  AIRTAG.Decode = Decode;
})();
