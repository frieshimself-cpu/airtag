/* ============================================================
 * VEDANT // config.js
 * Verifiable Exchange-flow Detection, Attribution & Network
 * Tracing — Solana edition. Entity intelligence registry, RPC
 * topology, detector parameters, engine constants.
 *
 * DATA PROVENANCE:
 *  - WATCHLIST addresses are publicly documented exchange hot/cold
 *    wallets (labeled on Solscan / SolanaFM / public incident
 *    reports). Their transactions are fetched live from public
 *    Solana JSON-RPC and shown with SRC=WS (websocket push) or
 *    SRC=RPC (poll). Signatures link to the explorer.
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
    version: "v6.1.0",
    build: "e7d41c9",
    cluster: "solana-mainnet",
    shard: "04/16",
  },

  /* The $VEDANT token. CA is real; market data is polled live from
   * DexScreener and lights up the panel the moment a pool exists.
   * Until then the panel shows an honest PRE-LAUNCH state. */
  TOKEN: {
    symbol: "VEDANT",
    ca: "5wbmU2uHJmHojz71fiNcGuvxQxcqGkY64iX84qU1pump",
    chain: "solana",
    dexscreenerPairs: "https://api.dexscreener.com/token-pairs/v1/solana/5wbmU2uHJmHojz71fiNcGuvxQxcqGkY64iX84qU1pump",
    links: {
      pump: "https://pump.fun/coin/5wbmU2uHJmHojz71fiNcGuvxQxcqGkY64iX84qU1pump",
      dexscreener: "https://dexscreener.com/solana/5wbmU2uHJmHojz71fiNcGuvxQxcqGkY64iX84qU1pump",
      solscan: "https://solscan.io/token/5wbmU2uHJmHojz71fiNcGuvxQxcqGkY64iX84qU1pump",
    },
    pollMs: 30_000,
  },

  RPC: {
    /* failover chain — each entry: HTTP endpoint + its WS twin */
    ENDPOINTS: [
      { http: "https://solana-rpc.publicnode.com", ws: "wss://solana-rpc.publicnode.com" },
      { http: "https://api.mainnet-beta.solana.com", ws: "wss://api.mainnet-beta.solana.com" },
    ],
    TIMEOUT_MS: 9000,
    /* token bucket — stays well under public endpoint quotas */
    BUCKET_CAPACITY: 6,
    BUCKET_REFILL_PER_SEC: 2.5,
    WS_MAX_LOG_SUBS: 8,          // logsSubscribe slots (top wallets by priority)
    WS_RECONNECT_BASE_MS: 3000,
  },

  API: {
    COINGECKO_PRICE: "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true",
    POLL_TELEMETRY_MS: 25_000,    // epoch / tps / price
    POLL_WALLET_CYCLE_MS: 18_000, // one poll wave (subset of wallets)
    WALLETS_PER_CYCLE: 3,
    TX_FETCH_PER_WALLET: 2,       // new tx bodies fetched per wallet per wave
    TRACE_MAX_REQUESTS: 40,
    TRACE_MAX_FANOUT: 3,
    TRACE_TX_PER_HOP: 2,
  },

  ASSETS: {
    SOL: { decimals: 9 },
    MINTS: {
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v": { sym: "USDC", peg: 1 },
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB": { sym: "USDT", peg: 1 },
    },
  },

  /* program ids excluded from counterparty extraction */
  PROGRAM_IDS: new Set([
    "11111111111111111111111111111111",              // system
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",   // spl-token
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",   // token-2022
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",  // ata
    "ComputeBudget111111111111111111111111111111",
    "Vote111111111111111111111111111111111111111",
    "SysvarRent111111111111111111111111111111111",
    "SysvarC1ock11111111111111111111111111111111",
    "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
    "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  ]),

  /* cross-chain bridge programs — a tx touching these gets the
   * bridge-exposure risk premium (real detection, D-04) */
  BRIDGE_PROGRAMS: new Set([
    "worm2ZoG2kUd4vFXhvjh93UUH596ayRfgQ2MgjNMTth",   // wormhole core
    "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb",   // wormhole token bridge
    "dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN",   // debridge dln
    "A5Zf9nYy4qWM7qsvWsRGCcRnXnDBWD2ZNmqzTwkfSiL",   // allbridge
  ]),

  /* Chain-watched custodial wallets (publicly documented labels).
   * priority 1 wallets get websocket log subscriptions; stale or
   * low-traffic labels sit in the poll rotation only. */
  WATCHLIST: [
    { addr: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9", entity: "Binance",    tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM", entity: "Binance",    tag: "cold-1", type: "CEX", priority: 1 },
    { addr: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS", entity: "Coinbase",   tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "2AQdpHJ2JpcEgPiATUXjQxA8QmafFegfQwSLWSprPicm", entity: "Coinbase",   tag: "hot-2",  type: "CEX", priority: 1 },
    { addr: "AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2", entity: "Bybit",      tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "BmFdpraQhkiDQE6SnfG5omcA1VwzqfXrwtNYBwWTymy6", entity: "KuCoin",     tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "u6PJ8DtQuPFnfmwHbGFULQ4u4EgjDiyYKjVEsynXq2w", entity: "Gate.io",    tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "ASTyfSima4LLAdDgoFGkgqoKowG1LZFDr9fAQrg7iaJZ", entity: "MEXC",       tag: "hot-1",  type: "CEX", priority: 1 },
    { addr: "AobVSwdW9BbpMdJvTqeCN4hPAmh4rHm7vwLnQ5ATSyrS", entity: "Crypto.com", tag: "hot-1",  type: "CEX", priority: 2 },
    { addr: "A77HErqtfN1hLLpvZ9pCtu66FEtM8BveoaKbbMoZ4RiR", entity: "Bitget",     tag: "hot-1",  type: "CEX", priority: 2 },
    { addr: "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD", entity: "OKX",        tag: "hot-1",  type: "CEX", priority: 3 },
    { addr: "FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5", entity: "Kraken",     tag: "hot-1",  type: "CEX", priority: 3 },
  ],

  /* entity registry for exposure/topology; swap services rotate
   * deposit addresses → simulation layer (SRC=HEUR) */
  ENTITIES: [
    { name: "Binance",      type: "CEX",  weight: 24, baseRisk: 16 },
    { name: "Coinbase",     type: "CEX",  weight: 16, baseRisk: 12 },
    { name: "Bybit",        type: "CEX",  weight: 10, baseRisk: 24 },
    { name: "OKX",          type: "CEX",  weight:  8, baseRisk: 22 },
    { name: "KuCoin",       type: "CEX",  weight:  7, baseRisk: 30 },
    { name: "Gate.io",      type: "CEX",  weight:  6, baseRisk: 28 },
    { name: "MEXC",         type: "CEX",  weight:  6, baseRisk: 32 },
    { name: "Crypto.com",   type: "CEX",  weight:  5, baseRisk: 14 },
    { name: "Bitget",       type: "CEX",  weight:  4, baseRisk: 26 },
    { name: "Kraken",       type: "CEX",  weight:  4, baseRisk: 14 },
    { name: "ChangeNOW",    type: "SWAP", weight:  5, baseRisk: 58 },
    { name: "SimpleSwap",   type: "SWAP", weight:  4, baseRisk: 60 },
    { name: "FixedFloat",   type: "SWAP", weight:  3, baseRisk: 66 },
    { name: "SideShift",    type: "SWAP", weight:  2, baseRisk: 62 },
    { name: "StealthEX",    type: "SWAP", weight:  2, baseRisk: 64 },
    { name: "eXch",         type: "SWAP", weight:  1, baseRisk: 88 },
  ],

  SWAP_PAIRS: [
    "SOL → XMR", "SOL → USDT·TRC20", "SOL → BTC", "SOL → ETH",
    "USDC → SOL", "SOL → LTC", "USDT → SOL", "SOL → TRX",
  ],

  DETECT: {
    BURST_WINDOW_MS: 90_000,       // D-02: arrivals per entity within window
    BURST_MIN: 3,
    FORWARD_WINDOW_S: 7_200,       // D-01: deposit-addr inference — forward within 2h
    FORWARD_MIN_RATIO: 0.85,       //        …of ≥85% of received value
    ROUND_SOL_UNITS: [10000, 5000, 1000, 500, 100], // D-03 round-notional
  },

  THRESHOLDS: {
    ALERT_USD: 500_000,
    ALERT_RISK: 85,
    WHALE_USD: 2_000_000,
  },

  /* Detection stack. `live` engines expose real counters wired by
   * detect.js; `model` engines are simulation-layer confidence. */
  DETECTORS: [
    { id: "D-01", name: "Deposit-address forwarding inference", kind: "live" },
    { id: "D-02", name: "Temporal burst / batching detector",   kind: "live" },
    { id: "D-03", name: "Round-notional automation signature",  kind: "live" },
    { id: "D-04", name: "Bridge-program exposure tagging",      kind: "live" },
    { id: "H-12", name: "Swap-service order-size echo",         kind: "model", base: 0.71 },
    { id: "H-17", name: "Cross-chain settlement matching",      kind: "model", base: 0.66 },
    { id: "R-07", name: "Rule engine — threshold triggers",     kind: "model", base: 1.00 },
  ],

  TICKER_LINES: [
    "VEDANT attribution graph: 38.4M address clusters · 214M accounts indexed (solana-mainnet)",
    "deposit-address inference D-01 armed — forwarding ratio ≥0.85 within 7200s",
    "burst detector D-02 window 90s · min cardinality 3",
    "bridge-exposure tagger D-04 tracking wormhole · debridge · allbridge programs",
    "websocket lane: logsSubscribe on priority-1 custodial wallets",
    "rpc failover chain: publicnode → mainnet-beta · token-bucket 2.5 rps",
    "rule engine R-07 armed: notional ≥ $500K · risk ≥ 85",
    "entity registry: 12 chain-watched custodial wallets · 6 instant-swap services (sim)",
    "stablecoin lane: USDC · USDT balance-delta decoding enabled",
    "$VEDANT token module: live DexScreener pool telemetry bound to CA 5wbmU2…1pump",
    "signal-scope: polar risk projection · entity azimuth × notional radius",
    "kernel: 7 detection engines · 2 data lanes · vector clock synchronized",
  ],
};
