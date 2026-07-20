/* ============================================================
 * VEDANT // token.js
 * $VEDANT token module — Solana / pump.fun.
 *
 * When CONFIG.TOKEN.ca is UNSET the module sits in STANDBY (no
 * address shown, no network calls). When a CA is bound it polls
 * DexScreener and walks two honest states:
 *   PRE-LAUNCH — no DEX pool indexed yet. Module armed, polling.
 *   LIVE       — a pair is indexed → price / 24h change / market
 *                cap / liquidity / 24h volume / buy-sell pressure
 *                and a live-updating price trace.
 *
 * All endpoints/links are derived from `ca` at runtime, so
 * re-arming is a single config edit.
 * ============================================================ */

(function () {
  const T = AIRTAG.CONFIG.TOKEN;
  const hasCA = () => !!(T.ca && T.ca.length);
  const urls = () => ({
    dex:     `https://api.dexscreener.com/token-pairs/v1/solana/${T.ca}`,
    pump:    `https://pump.fun/coin/${T.ca}`,
    dexUi:   `https://dexscreener.com/solana/${T.ca}`,
    solscan: `https://solscan.io/token/${T.ca}`,
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

  const Token = {
    priceSeries: [],
    el: {},

    init() {
      this.el = {
        state: document.getElementById("tok-state"),
        caCode: document.getElementById("tok-ca-code"),
        copy: document.getElementById("tok-copy"),
        linkPump: document.getElementById("tok-link-pump"),
        linkDex: document.getElementById("tok-link-dex"),
        linkScan: document.getElementById("tok-link-solscan"),
        price: document.getElementById("tok-price"),
        change: document.getElementById("tok-change"),
        mcap: document.getElementById("tok-mcap"),
        liq: document.getElementById("tok-liq"),
        vol: document.getElementById("tok-vol"),
        pressure: document.getElementById("tok-pressure"),
        pbBuy: document.getElementById("tok-pb-buy"),
        pbSell: document.getElementById("tok-pb-sell"),
        spark: document.getElementById("tok-spark"),
        pair: document.getElementById("tok-pair"),
      };
      if (this.el.copy) this.el.copy.addEventListener("click", () => this._copy(this.el.copy));

      if (!hasCA()) { this._standby(); return; }

      const u = urls();
      this.el.caCode.textContent = T.ca;
      if (this.el.linkPump) this.el.linkPump.href = u.pump;
      if (this.el.linkDex) this.el.linkDex.href = u.dexUi;
      if (this.el.linkScan) this.el.linkScan.href = u.solscan;
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

    _standby() {
      const box = document.getElementById("panel-token");
      if (box) box.classList.remove("token-live");
      this.el.state.className = "tok-state pre";
      this.el.state.textContent = "◍ STANDBY · NO CONTRACT BOUND";
      if (this.el.caCode) this.el.caCode.textContent = "contract address pending";
      if (this.el.copy) this.el.copy.hidden = true;
      [this.el.linkPump, this.el.linkDex, this.el.linkScan].forEach((a) => { if (a) a.hidden = true; });
      this.el.pair.textContent = "token module idle — CA will be bound at launch";
      ["price", "mcap", "liq", "vol", "change", "pressure"].forEach((k) => {
        if (this.el[k]) this.el[k].textContent = "—";
      });
      this.el.change.className = "tok-change";
      this.el.pbBuy.style.width = "50%";
      this.el.pbSell.style.width = "50%";
      this._drawSpark("price trace populates once a contract is bound");
    },

    async poll() {
      if (!hasCA()) return;
      let pairs = null;
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        const res = await fetch(urls().dex, { cache: "no-store", signal: ctl.signal });
        clearTimeout(timer);
        if (res.ok) pairs = await res.json();
      } catch { /* keep last state */ }

      if (!Array.isArray(pairs) || !pairs.length) { this._preLaunch(); return; }
      pairs.sort((a, b) => ((b.liquidity && b.liquidity.usd) || 0) - ((a.liquidity && a.liquidity.usd) || 0));
      this._live(pairs[0]);
    },

    _preLaunch() {
      const box = document.getElementById("panel-token");
      if (box) box.classList.remove("token-live");
      this.el.state.className = "tok-state pre";
      this.el.state.textContent = "◍ PRE-LAUNCH · AWAITING LIQUIDITY POOL";
      this.el.pair.textContent = "no DEX pool indexed yet — module armed, polling every 30s";
      ["price", "mcap", "liq", "vol", "change", "pressure"].forEach((k) => {
        if (this.el[k]) this.el[k].textContent = "—";
      });
      this.el.change.className = "tok-change";
      this.el.pbBuy.style.width = "50%";
      this.el.pbSell.style.width = "50%";
      this._drawSpark("price trace populates once pool is live");
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
      this.el.pair.textContent = `${p.dexId || "dex"} · ${(p.baseToken && p.baseToken.symbol) || T.symbol}/${(p.quoteToken && p.quoteToken.symbol) || "SOL"}`;
      this.el.price.textContent = fmtPrice(price);
      this.el.mcap.textContent = fmt(mcap);
      this.el.liq.textContent = fmt(liq);
      this.el.vol.textContent = fmt(vol);
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
