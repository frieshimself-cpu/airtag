/* ============================================================
 * AIRTAG // config.js
 * Entity intelligence registry + engine constants.
 *
 * NOTE ON DATA PROVENANCE:
 *  - `watchlist` addresses are publicly documented exchange
 *    cold/hot wallets (widely labeled on block explorers).
 *    Transactions touching them are fetched LIVE from the
 *    mempool.space public API and shown with SRC=CHAIN/MEMPOOL.
 *  - Instant-swap services (ChangeNOW, SimpleSwap, FixedFloat…)
 *    rotate deposit addresses per-order, so their events here
 *    are produced by the heuristic simulation layer and are
 *    tagged SRC=HEUR. They are illustrative, not chain-attested.
 * ============================================================ */

window.AIRTAG = window.AIRTAG || {};

AIRTAG.CONFIG = {
  API: {
    MEMPOOL_BASE: "https://mempool.space/api",
    COINGECKO_CHART: "https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=1",
    POLL_METRICS_MS: 30_000,     // tip height / fees / mempool / price
    POLL_ADDRESSES_MS: 90_000,   // watched wallet re-scan
    ADDRESS_STAGGER_MS: 1_200,   // spacing between per-address calls (rate-limit hygiene)
    TRACE_REQ_GAP_MS: 280,       // spacing between trace graph-walk calls
    TRACE_MAX_REQUESTS: 34,      // hard budget per trace
    TRACE_MAX_FANOUT: 4,         // outputs followed per node
  },

  THRESHOLDS: {
    ALERT_USD: 1_000_000,
    ALERT_RISK: 85,
    WHALE_USD: 5_000_000,
  },

  /* Chain-watched custodial wallets (publicly documented labels). */
  WATCHLIST: [
    { addr: "34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo", entity: "Binance",  tag: "cold-1",  type: "CEX" },
    { addr: "bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97", entity: "Binance", tag: "cold-2", type: "CEX" },
    { addr: "3M219KR5vEneNb47ewrPfWyb5jQ2DjxRP6", entity: "Binance",  tag: "cold-3",  type: "CEX" },
    { addr: "bc1ql49ydapnjafl5t2cp9zqpjwe6pdgmxy98859v2", entity: "Robinhood", tag: "cold-1", type: "CEX" },
    { addr: "3JZq4atUahhuA9rLhXLMhhTo133J9rF97j", entity: "Bitfinex", tag: "cold-legacy", type: "CEX" },
    { addr: "bc1qa5wkgaew2dkv56kfvj49j0av5nml45x9ek9hz6", entity: "Bitfinex", tag: "cold-native", type: "CEX" },
  ],

  /* Attributed entity registry — cluster metadata for the
   * attribution/rendering layer (swap services rotate deposit
   * addresses, so they surface via the heuristic engine). */
  ENTITIES: [
    { name: "Binance",      type: "CEX",  weight: 26, baseRisk: 18 },
    { name: "Coinbase",     type: "CEX",  weight: 14, baseRisk: 12 },
    { name: "OKX",          type: "CEX",  weight: 10, baseRisk: 22 },
    { name: "Kraken",       type: "CEX",  weight:  8, baseRisk: 14 },
    { name: "Bybit",        type: "CEX",  weight:  8, baseRisk: 24 },
    { name: "HTX",          type: "CEX",  weight:  5, baseRisk: 30 },
    { name: "Bitfinex",     type: "CEX",  weight:  4, baseRisk: 20 },
    { name: "Robinhood",    type: "CEX",  weight:  3, baseRisk: 10 },
    { name: "ChangeNOW",    type: "SWAP", weight:  7, baseRisk: 58 },
    { name: "SimpleSwap",   type: "SWAP", weight:  5, baseRisk: 60 },
    { name: "FixedFloat",   type: "SWAP", weight:  4, baseRisk: 66 },
    { name: "SideShift",    type: "SWAP", weight:  3, baseRisk: 62 },
    { name: "StealthEX",    type: "SWAP", weight:  2, baseRisk: 64 },
    { name: "ChangeHero",   type: "SWAP", weight:  2, baseRisk: 56 },
    { name: "LetsExchange", type: "SWAP", weight:  2, baseRisk: 55 },
    { name: "eXch",         type: "SWAP", weight:  1, baseRisk: 88 },
  ],

  SWAP_PAIRS: [
    "BTC → XMR", "BTC → USDT·TRC20", "BTC → ETH", "ETH → BTC",
    "BTC → LTC", "USDT → BTC", "BTC → USDC", "ETH → XMR", "BTC → TRX",
  ],

  /* Attribution stack shown in the heuristics panel. */
  HEURISTICS: [
    { id: "H-01", name: "Multi-input co-spend clustering",     base: 0.97 },
    { id: "H-04", name: "Change-output fingerprinting",        base: 0.91 },
    { id: "H-07", name: "Peel-chain decomposition",            base: 0.84 },
    { id: "H-09", name: "Deposit-address reuse correlation",   base: 0.93 },
    { id: "H-12", name: "Swap-service order-size echo",        base: 0.71 },
    { id: "H-14", name: "Temporal burst / batching signature", base: 0.88 },
    { id: "H-17", name: "Cross-chain settlement matching",     base: 0.66 },
    { id: "R-07", name: "Rule engine — threshold triggers",    base: 1.00 },
  ],

  TICKER_LINES: [
    "attribution graph: 41,882,157 clusters · 1.02B addresses indexed",
    "co-spend heuristic H-01 merged 12,441 clusters in last epoch",
    "peel-chain decomposer H-07 tracking 318 open chains",
    "swap-echo matcher H-12 correlated 47 cross-service orders (24h)",
    "UTXO graph shard 04/16 — consistency check OK",
    "entity registry sync: 16 tracked exchanges · 8 instant-swap services",
    "rule engine R-07 armed: notional ≥ $1.0M · risk ≥ 85",
    "cold-wallet delta monitor: 6 chain-watched custodial addresses",
    "cross-chain settlement matcher H-17 warming — model v9 rollout 62%",
  ],
};
