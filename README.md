# AIRTAG

**A**utonomous **I**nter-exchange **R**outing · **T**agging & **A**ttribution **G**raph — Solana edition

A dark-terminal web console for detecting and tracing funds moving through
centralized exchanges (Binance, Coinbase, Bybit, OKX, KuCoin, Gate.io, MEXC,
Crypto.com, Bitget, Kraken) and instant-swap services on Solana mainnet.

```
┌────────────────────────────────────────────────────────────────────┐
│  browser (zero-dependency static SPA)                              │
│                                                                    │
│  ┌───────────────────────────────┐  ┌───────────────────────────┐  │
│  │ rpc.js — data plane           │  │ detect.js                 │  │
│  │  · JSON-RPC failover chain    │  │  D-01 deposit-addr infer  │  │
│  │  · token-bucket rate limiter  │  │  D-02 burst detector      │  │
│  │  · websocket lane:            │  │  D-03 round-notional      │  │
│  │    slotSubscribe +            │  │  D-04 bridge exposure     │  │
│  │    logsSubscribe(mentions)    │  │  + swap-sim layer [HEUR]  │  │
│  └──────────────┬────────────────┘  └─────────────┬─────────────┘  │
│  ┌──────────────┴────────────────┐  ┌─────────────┴─────────────┐  │
│  │ decode.js — tx normalization  │  │ trace.js — temporal taint │  │
│  │  SOL balance deltas ·         │  │  walk (causality-window   │  │
│  │  USDC/USDT token deltas ·     │  │  BFS over account graph)  │  │
│  │  counterparty extraction      │  │                           │  │
│  └──────────────┬────────────────┘  └─────────────┬─────────────┘  │
│                 └───────── unified event feed ────┘                │
│      netflow chart · TPS chart · topology · alerts · exposure      │
└────────────────────────────────────────────────────────────────────┘
       │ HTTPS + WSS (public, keyless)
   solana JSON-RPC (publicnode → mainnet-beta failover) · CoinGecko
```

## What is real vs. simulated

Every feed row carries a `SRC` tag:

| SRC | Meaning |
|---|---|
| `WS` | Pushed live by `logsSubscribe` on a priority-1 custodial wallet, then hydrated with `getTransaction` and decoded. Chain-attested; signature links to Solscan. |
| `RPC` | Found by the polling rotation (`getSignaturesForAddress` with per-wallet cursors), hydrated and decoded the same way. Chain-attested. |
| `HEUR` | Output of the simulation layer. Instant-swap services rotate per-order deposit addresses and publish no wallet set, so their rows are statistically plausible synthetic intercepts — illustrative, not chain-attested. |

**Real subsystems:**

- **Data plane** (`rpc.js`) — JSON-RPC with endpoint failover (publicnode →
  mainnet-beta), a global token bucket (2.5 rps) shared by every consumer,
  429/5xx cool-down rotation, and a WebSocket lane (`slotSubscribe` for the
  live slot counter, `logsSubscribe` with `mentions` filters for push
  detection on hot wallets) with auto-reconnect. Plane state is honest:
  `WS-LIVE` → `RPC-POLL` → `REPLAY (synthetic)`.
- **Transaction decoding** (`decode.js`) — native SOL deltas from
  `pre/postBalances` (fee-corrected for the fee payer), USDC/USDT deltas from
  `pre/postTokenBalances` matched by owner, dominant-leg selection,
  counterparty extraction (largest opposite-sign delta, program accounts
  excluded), and bridge-program tagging (Wormhole, deBridge, Allbridge).
- **Trace console** (`trace.js`) — account-model chains have no UTXO graph,
  so the walk is *temporal*: from a root address (or a signature's primary
  debtor), collect outgoing SOL transfers, then examine each counterparty's
  transactions **after** the funds arrived and follow them, depth-limited and
  request-budgeted. Hops landing on watchlisted wallets are custodial hits.
- **Detector D-01** — an intermediate that forwards ≥85% of received value
  into a labeled hot wallet within 2h is attributed as that exchange's
  deposit address and registered (visible in the D-01 registry panel).
- **Detectors D-02/03/04** — burst detection (≥3 arrivals per entity in 90s),
  round-notional signatures, bridge exposure. All feed the composite risk
  score applied to real and simulated events alike.
- **Network telemetry** — SOL price (CoinGecko), epoch progress, live slot,
  and the throughput panel built from `getRecentPerformanceSamples`.

The watchlist consists of publicly documented exchange wallets (labels from
Solscan/SolanaFM and public incident reports); labels can go stale and are
disclosed as such.

## Running

No build step, no dependencies. Serve the directory (recommended) or open
`index.html` directly:

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

## Deploying to Vercel

The repo ships a `vercel.json` (static output, hardened headers, a CSP scoped
to the upstream RPC/price APIs incl. WebSocket origins, cache rules for
`assets/`). No framework, no build command, no environment variables.

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Ffrieshimself-cpu%2Fairtag)

**One-off from the CLI:**

```sh
npx vercel          # preview deployment
npx vercel --prod   # production deployment
```

**Continuous deployment:** import the repo at
[vercel.com/new](https://vercel.com/new), accept the detected settings
(Framework Preset: *Other*, no build command, output directory: root).

## Layout

- `index.html` — single-page shell
- `assets/css/main.css` — terminal theme (series palette CVD-validated against the dark surface)
- `assets/js/config.js` — RPC topology, watchlist, entity registry, detector parameters
- `assets/js/rpc.js` — rate-limited JSON-RPC client + websocket lane
- `assets/js/decode.js` — transaction → normalized flow event
- `assets/js/detect.js` — detectors D-01…D-04, risk model, simulation layer
- `assets/js/charts.js` — netflow + throughput canvases, exposure bars
- `assets/js/topology.js` — animated routing-graph canvas
- `assets/js/trace.js` — temporal taint-trace engine + graph renderer
- `assets/js/app.js` — orchestrator (boot, pollers, ws wiring, feed, alerts)

## Disclaimer

AIRTAG is a demonstration/visualization project. Wallet labels come from
public documentation and may go stale; `SRC=HEUR` rows are simulated; D-01
attributions are heuristic inferences with disclosed evidence; nothing here
is investigative-grade attribution or financial advice.
