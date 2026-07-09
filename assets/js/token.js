/* ============================================================
 * VEDANT // token.js
 * $VEDANT token module — Robinhood Chain ERC-20.
 *
 * When CONFIG.TOKEN.ca is UNSET the module sits in STANDBY (no
 * address shown, no network calls). When a CA is bound it walks
 * three honest states:
 *   PRE-DEPLOY   — contract not found on-chain yet (Blockscout
 *                  404, no DEX pairs). Module armed, polling.
 *   DEPLOYED     — Blockscout returns token metadata (name,
 *                  symbol, holders, supply) but no pool is indexed
 *                  → real on-chain stats shown.
 *   LIVE         — DexScreener indexes a pair → price / mcap /
 *                  liquidity / 24h volume / buy-sell pressure and
 *                  a live price trace.
 *
 * All endpoints are derived from `ca` at runtime, so re-arming is
 * a single config edit.
 * ============================================================ */

(function () {
  const T = AIRTAG.CONFIG.TOKEN;
  const hasCA = () => !!(T.ca && T.ca.length);
  const urls = () => ({
    bs:       `${T.explorerBase}/api/v2/tokens/${T.ca}`,
    dex:      `https://api.dexscreener.com/latest/dex/tokens/${T.ca}`,
    explorer: `${T.explorerBase}/token/${T.ca}`,
    dexUi:    `https://dexscreener.com/search?q=${T.ca}`,
  });

  const fmt = (v) => {
    if (v == null || isNaN(v)) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return "$" + (v / 1e9).toFixed(2) + "B";
    if (a >= 1e6) return "$" + (v / 1e6).toFixed(2) + "M";
    if (a >= 1e3) return "$" + (v / 1e3).toFixed(1) + "K";
    if (a >= 1)   return "$" + v.toFixed(2);
    return "$" + v.toPrecision(3);
  };
  const fmtPrice = (v) => {
    if (v == null || isNaN(v)) return "—";
    if (v >= 1) return "$" + v.toFixed(4);
    if (v >= 0.0001) return "$" + v.toFixed(6);
    return "$" + v.toExponential(2);
  };
  const fmtCount = (v) => {
    const n = parseFloat(v);
    if (isNaN(n)) return "—";
    if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
    return Math.round(n).toLocaleString("en-US");
  };

  const Token = {
    priceSeries: [],
    el: {},

    init() {
      this.el = {
        state: document.getElementById("tok-state"),
        caCode: document.getElementById("tok-ca-code"),
        copy: document.getElementById("tok-copy"),
        linkEx: document.getElementById("tok-link-explorer"),
        linkDex: document.getElementById("tok-link-dex"),
        price: document.getElementById("tok-price"),
        change: document.getElementById("tok-change"),
        l1: document.getElementById("tok-l1"), v1: document.getElementById("tok-mcap"),
        l2: document.getElementById("tok-l2"), v2: document.getElementById("tok-liq"),
        l3: document.getElementById("tok-l3"), v3: document.getElementById("tok-vol"),
        pressure: document.getElementById("tok-pressure"),
        pbBuy: document.getElementById("tok-pb-buy"),
        pbSell: document.getElementById("tok-pb-sell"),
        spark: document.getElementById("tok-spark"),
        pair: document.getElementById("tok-pair"),
      };
      if (this.el.copy) this.el.copy.addEventListener("click", () => this._copy(this.el.copy));

      if (!hasCA()) { this._standby(); return; }

      this.el.caCode.textContent = T.ca;
      if (this.el.linkEx) this.el.linkEx.href = urls().explorer;
      if (this.el.linkDex) this.el.linkDex.href = urls().dexUi;
      this.poll();
      setInterval(() => this.poll(), T.pollMs);
    },

    _copy(btn) {
      if (!hasCA()) return;
      const done = () => { const o = btn.textContent; btn.textContent = "COPIED ✓"; setTimeout(() => (btn.textContent = o), 1400); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(T.ca).then(done).catch(() => {});
      }
    },

    _setLabels(a, b, c) {
      if (this.el.l1) this.el.l1.textContent = a;
      if (this.el.l2) this.el.l2.textContent = b;
      if (this.el.l3) this.el.l3.textContent = c;
    },

    _standby() {
      const box = document.getElementById("panel-token");
      if (box) box.classList.remove("token-live");
      this.el.state.className = "tok-state pre";
      this.el.state.textContent = "◍ STANDBY · NO CONTRACT BOUND";
      if (this.el.caCode) this.el.caCode.textContent = "contract address pending";
      if (this.el.copy) this.el.copy.hidden = true;
      if (this.el.linkEx) this.el.linkEx.hidden = true;
      if (this.el.linkDex) this.el.linkDex.hidden = true;
      this.el.pair.textContent = "token module idle — CA will be bound at launch";
      this._setLabels("MARKET CAP", "LIQUIDITY", "VOLUME 24H");
      ["price", "v1", "v2", "v3", "change", "pressure"].forEach((k) => {
        if (this.el[k]) this.el[k].textContent = "—";
      });
      this.el.change.className = "tok-change";
      this.el.pbBuy.style.width = "50%";
      this.el.pbSell.style.width = "50%";
      this._drawSpark("price trace populates once a contract is bound");
    },

    async _fetchJson(url) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(url, { cache: "no-store", signal: ctl.signal });
        clearTimeout(timer);
        if (res.status === 404) return { notFound: true };
        if (!res.ok) return null;
        return await res.json();
      } catch { return null; }
    },

    async poll() {
      if (!hasCA()) return;
      const u = urls();
      const [dex, bs] = await Promise.all([this._fetchJson(u.dex), this._fetchJson(u.bs)]);
      const pairs = dex && Array.isArray(dex.pairs) ? dex.pairs : (Array.isArray(dex) ? dex : []);
      if (pairs && pairs.length) {
        pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
        this._live(pairs[0]);
      } else if (bs && !bs.notFound && (bs.symbol || bs.name)) {
        this._deployed(bs);
      } else {
        this._preDeploy();
      }
    },

    _preDeploy() {
      const box = document.getElementById("panel-token");
      if (box) box.classList.remove("token-live");
      this.el.state.className = "tok-state pre";
      this.el.state.textContent = "◍ PRE-DEPLOY · CONTRACT NOT ON-CHAIN YET";
      this.el.pair.textContent = "robinhood-chain · module armed, polling Blockscout + DexScreener every 30s";
      this._setLabels("MARKET CAP", "LIQUIDITY", "VOLUME 24H");
      ["price", "v1", "v2", "v3", "change", "pressure"].forEach((k) => {
        if (this.el[k]) this.el[k].textContent = "—";
      });
      this.el.change.className = "tok-change";
      this.el.pbBuy.style.width = "50%";
      this.el.pbSell.style.width = "50%";
      this._drawSpark("price trace populates once a pool is live");
    },

    _deployed(bs) {
      const box = document.getElementById("panel-token");
      if (box) box.classList.remove("token-live");
      this.el.state.className = "tok-state pre";
      this.el.state.textContent = "◉ DEPLOYED · AWAITING LIQUIDITY POOL";
      this.el.pair.textContent = `${bs.name || "token"} (${bs.symbol || "?"}) · ${bs.type || "ERC-20"} on robinhood-chain`;
      this._setLabels("HOLDERS", "TOTAL SUPPLY", "DECIMALS");
      this.el.price.textContent = bs.exchange_rate ? fmtPrice(parseFloat(bs.exchange_rate)) : "—";
      this.el.v1.textContent = fmtCount(bs.holders_count || bs.holders);
      const dec = parseInt(bs.decimals || "18", 10);
      const supply = bs.total_supply ? parseFloat(bs.total_supply) / Math.pow(10, dec) : null;
      this.el.v2.textContent = supply != null ? fmtCount(supply) : "—";
      this.el.v3.textContent = isNaN(dec) ? "—" : String(dec);
      this.el.change.textContent = "";
      this.el.pressure.textContent = "on-chain metadata live · market data pending pool";
      this.el.pbBuy.style.width = "50%";
      this.el.pbSell.style.width = "50%";
      this._drawSpark("price trace populates once a pool is live");
    },

    _live(p) {
      const box = document.getElementById("panel-token");
      if (box) box.classList.add("token-live");
      const price = parseFloat(p.priceUsd);
      const ch = (p.priceChange && p.priceChange.h24) || 0;
      const mcap = p.marketCap || p.fdv || 0;
      const liq = (p.liquidity && p.liquidity.usd) || 0;
      const vol = (p.volume && p.volume.h24) || 0;
      const buys = (p.txns && p.txns.h24 && p.txns.h24.buys) || 0;
      const sells = (p.txns && p.txns.h24 && p.txns.h24.sells) || 0;

      this.el.state.className = "tok-state live";
      this.el.state.textContent = "● LIVE · POOL ACTIVE";
      this.el.pair.textContent = `${p.dexId || "dex"} · ${(p.baseToken && p.baseToken.symbol) || T.symbol}/${(p.quoteToken && p.quoteToken.symbol) || "WETH"} · ${p.chainId || "robinhood-chain"}`;
      this._setLabels("MARKET CAP", "LIQUIDITY", "VOLUME 24H");
      this.el.price.textContent = fmtPrice(price);
      this.el.v1.textContent = fmt(mcap);
      this.el.v2.textContent = fmt(liq);
      this.el.v3.textContent = fmt(vol);
      this.el.change.textContent = (ch >= 0 ? "▲ +" : "▼ ") + Math.abs(ch).toFixed(1) + "%";
      this.el.change.className = "tok-change " + (ch >= 0 ? "up" : "down");

      const tot = buys + sells || 1;
      const bp = (buys / tot) * 100;
      this.el.pbBuy.style.width = bp.toFixed(1) + "%";
      this.el.pbSell.style.width = (100 - bp).toFixed(1) + "%";
      this.el.pressure.textContent = `${buys.toLocaleString("en-US")} buys / ${sells.toLocaleString("en-US")} sells (24h)`;

      if (price > 0) {
        this.priceSeries.push(price);
        if (this.priceSeries.length > 60) this.priceSeries.shift();
      }
      this._drawSpark();
    },

    _drawSpark(placeholder) {
      const cv = this.el.spark;
      if (!cv) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = cv.getBoundingClientRect();
      cv.width = Math.max(1, rect.width * dpr);
      cv.height = Math.max(1, rect.height * dpr);
      const ctx = cv.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const w = rect.width, h = rect.height;
      ctx.clearRect(0, 0, w, h);
      const S = this.priceSeries;
      const css = getComputedStyle(document.documentElement);
      if (S.length < 2) {
        ctx.fillStyle = css.getPropertyValue("--ink-muted").trim();
        ctx.font = "9px " + css.getPropertyValue("--mono").trim();
        ctx.textAlign = "center";
        ctx.fillText(placeholder || "awaiting data", w / 2, h / 2 + 3);
        return;
      }
      const min = Math.min(...S), max = Math.max(...S), rng = max - min || 1;
      const up = S[S.length - 1] >= S[0];
      const color = css.getPropertyValue(up ? "--c-outflow" : "--c-inflow").trim();
      ctx.beginPath();
      S.forEach((v, i) => {
        const x = (i / (S.length - 1)) * w;
        const y = h - 4 - ((v - min) / rng) * (h - 8);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.strokeStyle = color; ctx.lineWidth = 1.6; ctx.stroke();
      ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
      ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fill(); ctx.globalAlpha = 1;
    },
  };

  AIRTAG.Token = Token;
})();
