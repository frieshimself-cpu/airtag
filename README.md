# VEDANT

**V**erifiable **E**xchange-flow **D**etection, **A**ttribution & **N**etwork **T**racing — Robinhood Chain edition

A dark-terminal HUD console for detecting and tracing funds moving through
on-chain venues (WETH vault, PoolManager DEX, the Robinhood router, and the
ArbSys L2→L1 bridge exit), tracked whales, and instant-swap services on
**Robinhood Chain** — an EVM L2 (Arbitrum Orbit), chain-id **4663** ("HOOD").

## $VEDANT token

The console carries a token module (`MOD·00`) for the project's ERC-20 on
Robinhood Chain. **The contract address is currently unset** — it has been
removed from the site pending launch, so the module sits in a **STANDBY** state
(no address shown, no network calls) and the mission-bar chip reads
`CA PENDING`.

**To re-arm:** set `ca` in `CONFIG.TOKEN` (`assets/js/config.js`) to the
contract address. Every endpoint and link is derived from `ca` at runtime, so
that single edit brings the whole module back online. Once bound, the panel
polls two live sources every 30 s and walks three honest states:

- **PRE-DEPLOY** — the contract is not found on-chain yet (Blockscout 404, no
  DEX pair). Module armed, polling.
- **DEPLOYED** — Blockscout returns token metadata → real on-chain **holders /
  total supply / decimals** are shown while market data is still pending.
- **LIVE** — DexScreener indexes a pair → **price / 24h change / market cap /
  liquidity / 24h volume / buy-sell pressure** and a live price trace.

```
┌────────────────────────────────────────────────────────────────────┐
│  browser (zero-dependency static SPA)                              │
│                                                                    │
│  ┌───────────────────────────────┐  ┌───────────────────────────┐  │
│  │ rpc.js — data plane           │  │ detect.js                 │  │
│  │  · EVM JSON-RPC (eth_*)       │  │  D-01 deposit-addr infer  │  │
│  │  · Blockscout REST v2         │  │  D-02 burst detector      │  │
│  │  · token-bucket rate limiter  │  │  D-03 round-notional      │  │
│  │  · ws lane: eth_subscribe     │  │  D-04 ArbSys/bridge exit  │  │
│  │    newHeads → feed sweeps     │  │  + swap-sim layer [HEUR]  │  │
│  └──────────────┬────────────────┘  └─────────────┬─────────────┘  │
│  ┌──────────────┴────────────────┐  ┌─────────────┴─────────────┐  │
│  │ decode.js — tx normalization  │  │ trace.js — temporal taint │  │
│  │  native ETH value ·           │  │  walk (causality-window   │  │
│  │  ERC-20 method decode ·       │  │  BFS over account graph)  │  │
│  │  counterparty + bridge flag   │  │                           │  │
│  └──────────────┬────────────────┘  └─────────────┬─────────────┘  │
│                 └───────── unified event feed ────┘                │
│      netflow · tx/day chart · topology · scope · heatmap · alerts   │
└────────────────────────────────────────────────────────────────────┘
       │ HTTPS + WSS (public, keyless)
   Robinhood Chain JSON-RPC + Blockscout REST · DexScreener
```

## What is real vs. simulated

Every feed row carries a `SRC` tag:

| SRC | Meaning |
|---|---|
| `WS` | Surfaced by a feed sweep **triggered** by an `eth_subscribe("newHeads")` push, then decoded from the Blockscout tx object. Chain-attested; hash links to the explorer. |
| `RPC` | Found by a timed Blockscout sweep or per-venue history scan, decoded the same way. Chain-attested. |
| `HEUR` | Output of the simulation layer. Instant-swap services rotate per-order deposit addresses and publish no wallet set, so their rows are statistically plausible synthetic intercepts — illustrative, not chain-attested. |

**Real subsystems:**

- **Data plane** (`rpc.js`) — EVM JSON-RPC against
  `rpc.mainnet.chain.robinhood.com` (`eth_blockNumber`, `eth_gasPrice`,
  `eth_subscribe`) plus the chain's **Blockscout REST v2** API for rich data
  (stats, latest txs, per-address histories, top accounts, daily tx charts).
  A single global token bucket (2.5 rps) is shared by both lanes. The
  WebSocket lane subscribes to `newHeads` for a live block counter and to
  trigger feed sweeps. Plane state is honest: `WS-LIVE` → `RPC-POLL` →
  `REPLAY (synthetic)`.
- **Transaction decoding** (`decode.js`) — native ETH value (wei → ETH) with
  live USD conversion, direction relative to the watch registry, counterparty
  extraction, ERC-20 method surfacing, and bridge-touch tagging (the ArbSys
  exit precompile `0x…0064` and L1-deposit machinery).
- **Whale discovery** — at boot (and every 2 min) the top-balance EOAs are
  resolved live from Blockscout's top-accounts API and folded into the watch
  registry as `WHALE-01…05`.
- **Trace console** (`trace.js`) — a *temporal* taint walk over the account
  graph: from a root `0x` address (or a tx hash's sender), collect outgoing
  native transfers, then examine each counterparty's history **after** the
  funds arrived and follow them, depth-limited and request-budgeted. Hops
  landing on a watched venue/whale are hits.
- **Detector D-01** — an intermediate that forwards ≥85% of received value
  into a watched venue within 2h is attributed as a hot-path/deposit address
  and registered (visible in the D-01 registry panel).
- **Detectors D-02/03/04** — burst detection (≥3 arrivals per entity in 90s),
  round-ETH-notional signatures, and ArbSys/bridge-exit exposure. All feed the
  composite risk score applied to real and simulated events alike.
- **Network telemetry** — ETH price, gas, and network utilization from
  Blockscout stats; live block height from JSON-RPC; the throughput panel from
  Blockscout's daily transaction chart.
- **Live systems strip** — the eight HUD gauges are wired to real runtime
  internals: the RPC token-bucket level, ingest-queue depth, WebSocket
  subscription count, event-store size, event throughput/min, cumulative
  detector hits, active endpoint + latency, and a monotonic vector clock.
- **Signal-scope** (`scope.js`) — a rotating polar projection of the live
  event stream (azimuth = entity, radius = log-notional, hue = direction).
- **Activity matrix** (`heatmap.js`) — entity × 24-hour USD-notional heatmap
  on a validated single-hue sequential ramp.
- **Threat index** — a composite of recent risk, active alerts, whale and
  bridge presence, driving the mission-bar meter (NOMINAL → CRITICAL).

The venue registry consists of on-chain system/venue contracts visible on the
chain's Blockscout explorer; whale labels are derived from live balances.
Labels are heuristic and can go stale — disclosed as such.

## Running

No build step, no dependencies. Serve the directory (recommended) or open
`index.html` directly:

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

## Deploying to Vercel

The repo ships a `vercel.json` (static output, hardened headers, a CSP scoped
to the Robinhood Chain RPC/Blockscout/DexScreener origins incl. WebSocket, cache rules for
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
- `assets/css/main.css` — HUD terminal theme (series palette CVD-validated against the dark surface)
- `assets/js/config.js` — brand, token, chain/RPC topology, venue watchlist, entity registry, detector parameters
- `assets/js/rpc.js` — rate-limited EVM JSON-RPC + Blockscout REST client + websocket lane
- `assets/js/decode.js` — Blockscout tx → normalized flow event
- `assets/js/detect.js` — detectors D-01…D-04, risk model, simulation layer
- `assets/js/charts.js` — netflow + tx/day throughput canvases, exposure bars
- `assets/js/heatmap.js` — entity × hour activity matrix
- `assets/js/scope.js` — signal-scope polar projection
- `assets/js/topology.js` — animated routing-graph canvas
- `assets/js/token.js` — $VEDANT token module (Blockscout + DexScreener)
- `assets/js/fx.js` — background lattice, live systems strip, threat meter
- `assets/js/trace.js` — temporal taint-trace engine + graph renderer
- `assets/js/app.js` — orchestrator (boot, pollers, ws wiring, feed, alerts, scope, threat)

## Disclaimer

VEDANT is a demonstration/visualization project. Wallet labels come from
public documentation and may go stale; `SRC=HEUR` rows are simulated; D-01
attributions are heuristic inferences with disclosed evidence; nothing here
is investigative-grade attribution or financial advice.
