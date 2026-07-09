/* ============================================================
 * VEDANT // config.js
 * Verifiable Exchange-flow Detection, Attribution & Network
 * Tracing — Robinhood Chain edition (EVM L2, chain-id 4663).
 *
 * DATA PROVENANCE:
 *  - WATCHLIST entries are on-chain venue/system contracts that
 *    are publicly visible on the chain's Blockscout explorer
 *    (WETH vault, PoolManager DEX, router, ArbSys bridge-exit
 *    precompile). Their traffic is fetched live from public
 *    JSON-RPC + the Blockscout REST API. Tx hashes link to the
 *    explorer.
 *  - WHALE-xx entities are discovered dynamically at boot from
 *    the live top-accounts API (largest EOAs by balance).
 *  - Instant-swap services rotate per-order deposit addresses and
 *    publish no wallet set; their rows come from the simulation
 *    layer and are tagged SRC=HEUR (illustrative only).
 *  - Deposit-address attributions (kind=deposit) are INFERRED by
 *    the forwarding heuristic D-01 and carry their evidence.
 * ============================================================ */

window.AIRTAG = window.AIRTAG || {};

AIRTAG.CONFIG = {
  BRAND: {
    name: "VEDANT",
    expansion: "VERIFIABLE EXCHANGE-FLOW DETECTION · ATTRIBUTION & NETWORK TRACING",
    version: "v7.0.0",
    build: "a3f92e1",
    cluster: "robinhood-mainnet",
    chainId: 4663,
    shard: "04/16",
  },

  /* The $VEDANT token (Robinhood Chain, ERC-20). Telemetry comes
   * from two live sources: the chain's Blockscout token API
   * (deployment, holders, supply) and DexScreener (pool price /
   * liquidity / volume once a pair is indexed). The panel walks
   * PRE-DEPLOY → DEPLOYED·AWAITING LIQUIDITY → LIVE honestly. */
  TOKEN: {
    symbol: "VEDANT",
    ca: "0xdb3995467291870629e6f8f838b8e901196eb4bb",
    chain: "robinhood-chain",
    blockscoutToken: "https://robinhoodchain.blockscout.com/api/v2/tokens/0xdb3995467291870629e6f8f838b8e901196eb4bb",
    dexscreenerPairs: "https://api.dexscreener.com/latest/dex/tokens/0xdb3995467291870629e6f8f838b8e901196eb4bb",
    links: {
      explorer: "https://robinhoodchain.blockscout.com/token/0xdb3995467291870629e6f8f838b8e901196eb4bb",
      dexscreener: "https://dexscreener.com/search?q=0xdb3995467291870629e6f8f838b8e901196eb4bb",
    },
    pollMs: 30_000,
  },

  CHAIN: {
    RPC_HTTP: "https://rpc.mainnet.chain.robinhood.com",
    RPC_WS: "wss://rpc.mainnet.chain.robinhood.com",
    BLOCKSCOUT: "https://robinhoodchain.blockscout.com/api/v2",
    EXPLORER_TX: "https://robinhoodchain.blockscout.com/tx/",
    EXPLORER_ADDR: "https://robinhoodchain.blockscout.com/address/",
    TIMEOUT_MS: 9000,
    /* token bucket shared by RPC + REST — polite to public infra */
    BUCKET_CAPACITY: 6,
    BUCKET_REFILL_PER_SEC: 2.5,
    WS_RECONNECT_BASE_MS: 3000,
  },

  API: {
    POLL_TELEMETRY_MS: 25_000,    // stats / gas / price / block
    POLL_FEED_MS: 15_000,         // global latest-tx sweep
    POLL_VENUE_CYCLE_MS: 30_000,  // one venue-scan wave
    VENUES_PER_CYCLE: 2,
    TRACE_MAX_REQUESTS: 40,
    TRACE_MAX_FANOUT: 3,
    TRACE_TX_PER_HOP: 3,
    FEED_MIN_UNATTRIB_ETH: 0.1,   // unattributed txs below this stay out of the feed
  },

  /* ArbSys precompile — L2→L1 exits route through it */
  ARBSYS: "0x0000000000000000000000000000000000000064",

  /* Chain-watched venue/system endpoints (visible on Blockscout). */
  WATCHLIST: [
    { addr: "0x0bd7d308f8e1639fab988df18a8011f41eacad73", entity: "WETH Vault",  tag: "wrap/unwrap", type: "VENUE", priority: 1 },
    { addr: "0x8366a39cc670b4001a1121b8f6a443a643e40951", entity: "PoolManager", tag: "dex-core",    type: "VENUE", priority: 1 },
    { addr: "0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc", entity: "RH Router",   tag: "entrypoint",  type: "VENUE", priority: 1 },
    { addr: "0x0000000000000000000000000000000000000064", entity: "RH Bridge",   tag: "arbsys-exit", type: "VENUE", priority: 1 },
  ],

  /* dynamic whale slots — filled at boot from live top accounts */
  WHALE_SLOTS: 5,

  /* entity registry for exposure/scope/topology; swap services
   * rotate deposit addresses → simulation layer (SRC=HEUR) */
  ENTITIES: [
    { name: "WETH Vault",   type: "VENUE", weight: 20, baseRisk: 10 },
    { name: "PoolManager",  type: "VENUE", weight: 16, baseRisk: 18 },
    { name: "RH Router",    type: "VENUE", weight: 14, baseRisk: 14 },
    { name: "RH Bridge",    type: "VENUE", weight: 10, baseRisk: 30 },
    { name: "WHALE-01",     type: "WHALE", weight:  6, baseRisk: 34 },
    { name: "WHALE-02",     type: "WHALE", weight:  5, baseRisk: 34 },
    { name: "WHALE-03",     type: "WHALE", weight:  4, baseRisk: 34 },
    { name: "WHALE-04",     type: "WHALE", weight:  3, baseRisk: 34 },
    { name: "WHALE-05",     type: "WHALE", weight:  3, baseRisk: 34 },
    { name: "Unattributed", type: "WHALE", weight:  2, baseRisk: 40 },
    { name: "ChangeNOW",    type: "SWAP", weight:  5, baseRisk: 58 },
    { name: "SimpleSwap",   type: "SWAP", weight:  4, baseRisk: 60 },
    { name: "FixedFloat",   type: "SWAP", weight:  3, baseRisk: 66 },
    { name: "SideShift",    type: "SWAP", weight:  2, baseRisk: 62 },
    { name: "StealthEX",    type: "SWAP", weight:  2, baseRisk: 64 },
    { name: "eXch",         type: "SWAP", weight:  1, baseRisk: 88 },
  ],

  SWAP_PAIRS: [
    "ETH → XMR", "ETH → USDT·TRC20", "ETH → BTC", "ETH → SOL",
    "USDG → ETH", "ETH → LTC", "USDE → ETH", "ETH → TRX",
  ],

  DETECT: {
    BURST_WINDOW_MS: 90_000,       // D-02: arrivals per entity within window
    BURST_MIN: 3,
    FORWARD_WINDOW_S: 7_200,       // D-01: deposit-addr inference — forward within 2h
    FORWARD_MIN_RATIO: 0.85,       //        …of ≥85% of received value
    ROUND_ETH_UNITS: [1000, 500, 100, 50, 10], // D-03 round-notional (ETH)
  },

  THRESHOLDS: {
    ALERT_USD: 250_000,
    ALERT_RISK: 85,
    WHALE_USD: 1_000_000,
  },

  /* Detection stack. `live` engines expose real counters wired by
   * detect.js; `model` engines are simulation-layer confidence. */
  DETECTORS: [
    { id: "D-01", name: "Deposit-address forwarding inference", kind: "live" },
    { id: "D-02", name: "Temporal burst / batching detector",   kind: "live" },
    { id: "D-03", name: "Round-notional automation signature",  kind: "live" },
    { id: "D-04", name: "Bridge exit / ArbSys tagging",         kind: "live" },
    { id: "H-12", name: "Swap-service order-size echo",         kind: "model", base: 0.71 },
    { id: "H-17", name: "Cross-chain settlement matching",      kind: "model", base: 0.66 },
    { id: "R-07", name: "Rule engine — threshold triggers",     kind: "model", base: 1.00 },
  ],

  TICKER_LINES: [
    "VEDANT attribution graph bound to robinhood-mainnet · chain-id 4663 (HOOD)",
    "venue registry: WETH vault · PoolManager · RH Router · ArbSys bridge-exit",
    "whale discovery: top-balance EOAs resolved live from Blockscout at boot",
    "deposit-address inference D-01 armed — forwarding ratio ≥0.85 within 7200s",
    "burst detector D-02 window 90s · min cardinality 3",
    "bridge tagger D-04 watching ArbSys exits (0x…0064) and L1 deposits",
    "data plane: JSON-RPC (rpc.mainnet.chain.robinhood.com) + Blockscout REST · bucket 2.5 rps",
    "websocket lane: eth_subscribe newHeads · push-triggered feed sweeps",
    "rule engine R-07 armed: notional ≥ $250K · risk ≥ 85",
    "$VEDANT token module: live DexScreener pool telemetry bound to CA FsTedV…cpump (solana)",
    "signal-scope: polar risk projection · entity azimuth × notional radius",
  ],
};
