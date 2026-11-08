# ADR-004: CBR + Binance as a second stocks provider

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** owner (T-1 approved 2026-11-08); CTO review (shape)

## Context
The Stocks plugin (`widgetsack/src/stocks.rs`) talks only to Yahoo Finance's unofficial chart
endpoint. From the owner's network it times out after 10 s, so the three live tickers
(`USDRUB=X`, `EURRUB=X`, `BTC-USD`) render `—`. Probes on 2026-11-07/08 showed that
`www.cbr-xml-daily.ru` (Bank of Russia daily rates mirror) and `api.binance.com` answer promptly.
Constraints: no new crate, Yahoo behaviour unchanged (upstream parity), new code under
`widgetsack/src/fork/`, the `stocks.<SYMBOL>.*` sensor ids and the Ticker meter unchanged, no CSP /
capability / IPC-command / `secure_config` change.

## Options considered
1. **Keep Yahoo only** - zero code; the tickers stay dead on this network.
2. **Proxy Yahoo through the owner's VPS** - no mapper work; adds an operated service and a single
   point of failure outside this repo.
3. **A keyed provider (Alpha Vantage, Twelve Data, ...)** - broader coverage; needs a key in
   `secure_config`, signup and quotas.
4. **CBR for RUB pairs + Binance spot for crypto** - keyless, reachable, free; covers exactly the
   owner's symbols, but not equities or indices.

## Decision
Option 4, behind the existing `provider` field; Yahoo stays the default.
- `StocksConfig.provider` stays a `String` with serde default `"yahoo"`. `normalize_provider` maps
  anything but `"cbr-binance"` (trimmed, ASCII case-insensitive) to `"yahoo"`; it is applied on save,
  on status and when the worker starts, so a hand-edited junk value cannot fail the file parse.
- New module `widgetsack/src/fork/stocks_cbr.rs` (routing, mappers, client, poll). `stocks.rs` gets
  only `normalize_provider`, `change_pct` becoming `pub(crate)` and one provider branch in
  `run_stocks_client`. Demand gate, wake, backoff and status vocabulary are shared and unchanged.
- Samples use the SAME ids as Yahoo and are keyed by the DEMANDED string (`stocks.USDRUB=X.*`), so
  existing layouts light up with no edit.
- **No Yahoo fallback** when `cbr-binance` is selected: failover would hide the network problem and
  double the code paths.

### Symbol routing
Input is trimmed and uppercased; only `[A-Z0-9=/_.^-]`, at most 24 chars, is considered.
1. CBR: strip one trailing `=X`, then `AAA` + optional single `-` `/` `_` + `RUB`, with `AAA` three
   letters and not `RUB` (`USDRUB`, `USDRUB=X`, `USD-RUB`, `EURRUB=X`).
2. Binance (only without `=X`): base `[A-Z0-9]{2,10}`, optional separator, quote `USDT` or `USD`;
   the pair is rebuilt as `<base>USDT` (`BTC-USD`, `BTCUSD`, `BTCUSDT`).
3. Everything else (`AAPL`, `^GSPC`, `EURUSD=X`) is unsupported: no network call, one log line per
   symbol per worker, not counted as a failure (no error status, no backoff).

## Data semantics
- **CBR:** `price = Value / Nominal`, `prevClose = Previous / Nominal`; the "change" is the daily
  move between two published fixings. One request serves all codes; refetched at most every 30 min
  (the feed changes once a day), independent of the poll interval. A newly demanded code is mapped
  from the cached body. Re-emission is gated by the body's `Date`, so a refetch of the same day adds no
  duplicate history points. No `.series` (the feed has none; nothing is fabricated; the Ticker falls
  back to `price.history`) and no `.state`.
- **Binance:** `ticker/24hr` per symbol on the normal poll tick plus best-effort 5m `klines`
  (288 candles) for `.series`; a klines failure never drops the price. The window is a ROLLING 24h,
  not UTC midnight: `prevClose` is roughly the price 24 h ago, and the series covers the same 24 h.
  USDT is treated as USD (`.currency` = `USD`). No `.state`.
- RUB has no glyph in `currencySymbol`, so CBR prices render as a bare number.

## Security
- Symbol charset validated before anything reaches a URL; the Binance pair is built from `[A-Z0-9]`
  only, and the CBR code is only a JSON map key, never part of a URL.
- Redirects follow only `https` hops to `www.cbr-xml-daily.ru`, `cbr-xml-daily.ru`, `api.binance.com`
  with fewer than 3 hops (same strictness as the met.no client).
- 10 s timeout on every request; body caps: CBR 1 MiB, Binance ticker 256 KiB, klines 1 MiB.
- No URL in any error or log line (`request_error` strips it; HTTP errors name only the validated
  symbol). No secrets sent, stored or returned. No CSP, capability, IPC-command or `secure_config`
  change (fetching is server-side), so `layout_grants` is not involved.
- The identifying User-Agent is reused from `fork::weather_metno::USER_AGENT`.

## Consequences
- **Positive:** the three owner tickers work on this network; Yahoo path untouched; config file stays
  backward compatible; no new crate or trust surface.
- **Negative / trade-offs:** unsupported symbols (equities, indices, non-RUB FX) render `—` under this
  provider, so the owner switches provider to get them; CBR data updates once a day; crypto change
  is a rolling 24h, not a calendar-day change; two third-party hosts are contacted. During a CBR
  outage the feed is retried at most once per 5 minutes (one shared error for all CBR symbols).
- **Follow-ups:** a ruble glyph in `currencySymbol`; other crypto quote currencies; per-symbol
  provider mixing if equities are needed alongside RUB pairs.

## Upstream-merge footprint
Only `widgetsack/src/fork/mod.rs` (one line) and the `stocks.rs` hunks listed above; the client side
adds the provider select in `StocksSettings.tsx`, the enum in `studioIntegrationTools.ts` and the
union type in `stocks-types.ts`.
