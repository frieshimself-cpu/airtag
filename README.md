# AIRTAG

**A**utonomous **I**nter-exchange **R**outing · **T**agging & **A**ttribution **G**raph

A dark-terminal web console for detecting and tracing funds moving through
centralized exchanges (Binance, Coinbase, OKX, Kraken, …) and instant-swap
services (ChangeNOW, SimpleSwap, FixedFloat, SideShift, StealthEX, ChangeHero,
LetsExchange, eXch).

```
┌─────────────────────────────────────────────────────────────────┐
│  browser (zero-dependency static SPA)                           │
│                                                                 │
│  ┌────────────┐  ┌─────────────┐  ┌──────────────────────────┐  │
│  │ net.js     │  │ synth.js    │  │ trace.js                 │  │
│  │ data plane │  │ heuristic   │  │ forward taint engine     │  │
│  │ (live API) │  │ sim layer   │  │ (BFS over UTXO graph)    │  │
│  └─────┬──────┘  └──────┬──────┘  └────────────┬─────────────┘  │
│        └────────────────┴──────────────────────┘                │
│                     unified event feed                          │
│        ┌────────────┬──────────────┬─────────────┐              │
│   netflow chart   topology graph   alerts / exposure / rules    │
└─────────────────────────────────────────────────────────────────┘
                 │ HTTPS (public, keyless)
        mempool.space REST API · CoinGecko market data
```

## What is real vs. simulated

The console is explicit about provenance — every feed row carries a `SRC` tag:

| SRC | Meaning |
|---|---|
| `CHAIN` | Chain-confirmed transaction fetched live from the mempool.space API against publicly documented exchange cold wallets (Binance, Bitfinex, Robinhood). Txids link to the block explorer. |
| `MEMPOOL` | Same, but the transaction is still unconfirmed. |
| `HEUR` | Output of the heuristic **simulation layer**. Instant-swap services rotate deposit addresses per order and publish no wallet set, so their events here are statistically plausible synthetic intercepts (log-normal notionals, Poisson arrivals) — illustrative, not chain-attested. |

Also real:

- **Trace console** — paste any bitcoin txid (or address) and the engine walks
  the UTXO graph forward, breadth-first, up to depth 4 via `/tx/:id` and
  `/tx/:id/outspends`, following the largest outputs per hop and flagging any
  hop that pays into a watchlisted custodial wallet. Request-budgeted and
  paced to stay polite to the public API. `DEMO` renders a synthetic graph.
- **Topbar telemetry** — BTC/USD, chain tip height, recommended fee rate,
  mempool depth, and ingest latency, polled every 30 s.
- **Risk scoring** — the composite scoring function (entity base risk, size
  bands, round-notional automation signature, privacy-asset destination
  premium) runs the same real logic over both live and simulated events.

If the public APIs are unreachable, the data-plane indicator flips from
`LIVE` to `REPLAY (synthetic)` and the console keeps operating on the
simulation layer alone.

## Running

No build step, no dependencies. Either open `index.html` directly, or serve
the directory (recommended):

```sh
python3 -m http.server 8080
# → http://localhost:8080
```

## Layout

- `index.html` — single-page shell
- `assets/css/main.css` — terminal theme (series palette CVD-validated against the dark surface)
- `assets/js/config.js` — entity registry, watchlist, engine constants
- `assets/js/net.js` — live data plane with graceful degradation
- `assets/js/synth.js` — heuristic simulation layer (`SRC=HEUR`)
- `assets/js/charts.js` — canvas netflow chart + exposure bars
- `assets/js/topology.js` — animated routing-graph canvas
- `assets/js/trace.js` — forward taint-trace engine + graph renderer
- `assets/js/app.js` — orchestrator (boot, pollers, feed, alerts, rules)

## Disclaimer

AIRTAG is a demonstration/visualization project. Exchange wallet labels come
from public documentation and may go stale; `SRC=HEUR` events are simulated;
nothing here is investigative-grade attribution or financial advice.
