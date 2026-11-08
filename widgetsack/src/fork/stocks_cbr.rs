//! `cbr-binance` provider for the stocks source: Bank of Russia daily rates for `<CODE>RUB` pairs and
//! Binance spot for `<COIN>-USD` crypto, mapped onto the SAME `stocks.<SYMBOL>.*` sensor ids the
//! Yahoo path emits, so the Ticker meter and existing layouts need no change.
//!
//! Hosts: `www.cbr-xml-daily.ru` (one JSON body serves every currency) and `api.binance.com`
//! (`ticker/24hr` + `klines`). Both are keyless; nothing secret is sent, stored or returned. The
//! symbol is validated against a strict charset before anything is built into a URL, no URL ever
//! appears in an error or log line, every request has a 10 s timeout and a body cap, and redirects
//! only follow https hops to the three provider hosts.
//!
//! Decision record: ADR slug `stocks-provider-cbr-binance` (docs/decisions).
//!
//! Pure seams (`route_symbol`, `cbr_to_samples`, `binance_to_samples`, `cbr_due`, `follow_redirect`,
//! the URL builders) hold the logic and are tested without network; `poll_symbol` is the thin
//! network adapter, tested against a local `TcpListener`.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::sensors::{SensorSample, SensorValue};

const CBR_URL: &str = "https://www.cbr-xml-daily.ru/daily_json.js";
const BINANCE_BASE: &str = "https://api.binance.com/api/v3";
/// The feed changes once a day; asking more often only burns the provider's goodwill.
const CBR_REFRESH: Duration = Duration::from_secs(1800);
const TICKER_CAP: usize = 256 * 1024;
const JSON_CAP: usize = 1024 * 1024;
/// After a failed (or any) CBR attempt, wait this long before asking again, so an outage costs one
/// request per 5 min instead of one per tick per symbol.
const CBR_RETRY_FLOOR: Duration = Duration::from_secs(300);
const MAX_SYMBOL_LEN: usize = 24;
/// Matches the 288 five-minute klines requested; also a hard cap against an oversized body.
const MAX_SERIES: usize = 288;
/// Bound on distinct unsupported symbols remembered (and logged) per worker.
const MAX_WARNED: usize = 64;

/// What one poll of a symbol produced.
#[derive(Debug)]
pub enum Quote {
    /// Samples to emit (may be empty: the provider answered but does not know the symbol).
    Samples(Vec<SensorSample>),
    /// The symbol is not served by this provider; no network call was made.
    Unsupported,
    /// Already emitted for the current CBR `Date`; nothing new to send.
    Cached,
}

/// Per-worker memory: the cached CBR body and which symbols were already emitted for its `Date`.
#[derive(Default)]
pub struct CbrState {
    body: Option<(Value, String, Instant)>,
    emitted: HashSet<String>,
    warned: HashSet<String>,
    last_attempt: Option<Instant>,
    last_error: Option<String>,
}

impl CbrState {
    /// Store a freshly fetched body. A new `Date` re-arms every symbol; the same `Date` keeps the
    /// `emitted` set so a refetch does not add duplicate history points. A missing `Date` cannot be
    /// compared, so such a body always counts as new.
    fn accept(&mut self, body: Value, now: Instant) {
        let date = body["Date"].as_str().unwrap_or("").to_string();
        if date.is_empty() || self.body.as_ref().is_none_or(|(_, d, _)| *d != date) {
            self.emitted.clear();
        }
        self.body = Some((body, date, now));
        self.last_error = None;
    }

    /// The cached body is missing or old enough to refetch.
    fn stale(&self, now: Instant) -> bool {
        self.body
            .as_ref()
            .is_none_or(|(_, _, at)| cbr_due(now.saturating_duration_since(*at)))
    }

    /// The error of the last attempt while it is younger than the retry floor: callers return it
    /// instead of issuing another request.
    fn recent_failure(&self, now: Instant) -> Option<String> {
        let at = self.last_attempt?;
        if now.saturating_duration_since(at) < CBR_RETRY_FLOOR {
            self.last_error.clone()
        } else {
            None
        }
    }
}

/// Log form of an untrusted symbol: escaped (no raw newlines) and at most `MAX_SYMBOL_LEN` chars.
fn log_key(key: &str) -> String {
    key.chars()
        .flat_map(char::escape_debug)
        .take(MAX_SYMBOL_LEN)
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum Route {
    Cbr { code: String },
    Binance { pair: String },
    Unsupported,
}

const SEPARATORS: [char; 3] = ['-', '/', '_'];

/// Decide which upstream serves `symbol`. Input is trimmed and uppercased; only `[A-Z0-9=/_.^-]`
/// up to 24 chars is considered, and the Binance pair is rebuilt from `[A-Z0-9]` only, so nothing
/// user-controlled can inject into a URL.
fn route_symbol(symbol: &str) -> Route {
    let s = symbol.trim().to_uppercase();
    let charset_ok = s
        .chars()
        .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || "=/_.^-".contains(c));
    if s.is_empty() || s.len() > MAX_SYMBOL_LEN || !charset_ok {
        return Route::Unsupported;
    }
    let (core, fx_suffix) = match s.strip_suffix("=X") {
        Some(c) => (c, true),
        None => (s.as_str(), false),
    };
    if let Some(rest) = core.strip_suffix("RUB") {
        let code = rest.strip_suffix(SEPARATORS).unwrap_or(rest);
        if code.len() == 3 && code.chars().all(|c| c.is_ascii_uppercase()) && code != "RUB" {
            return Route::Cbr {
                code: code.to_string(),
            };
        }
    }
    if fx_suffix {
        return Route::Unsupported;
    }
    for quote in ["USDT", "USD"] {
        if let Some(rest) = core.strip_suffix(quote) {
            let base = rest.strip_suffix(SEPARATORS).unwrap_or(rest);
            let base_ok = (2..=10).contains(&base.len())
                && base
                    .chars()
                    .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit());
            if base_ok {
                return Route::Binance {
                    pair: format!("{base}USDT"),
                };
            }
        }
    }
    Route::Unsupported
}

/// Whether the cached CBR body is old enough to refetch.
fn cbr_due(age: Duration) -> bool {
    age >= CBR_REFRESH
}

/// Redirect rule: only `https` hops to the provider hosts, at most 2 redirects (`hops` counts the
/// original request too, as reqwest's `previous().len()` does — keep `< 3`).
fn follow_redirect(url: &reqwest::Url, hops: usize) -> bool {
    url.scheme() == "https"
        && matches!(
            url.host_str(),
            Some("www.cbr-xml-daily.ru" | "cbr-xml-daily.ru" | "api.binance.com")
        )
        && hops < 3
}

/// A client with the fork's identifying User-Agent, a 10 s timeout and the restricted redirect rule.
pub fn provider_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if follow_redirect(attempt.url(), attempt.previous().len()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .user_agent(crate::fork::weather_metno::USER_AGENT)
        .build()
        .map_err(|e| e.to_string())
}

fn ticker_url(base: &str, pair: &str) -> String {
    format!("{base}/ticker/24hr?symbol={pair}")
}

fn klines_url(base: &str, pair: &str) -> String {
    format!("{base}/klines?symbol={pair}&interval=5m&limit=288")
}

fn positive(n: f64) -> Option<f64> {
    (n.is_finite() && n > 0.0).then_some(n)
}

fn field_f64(v: &Value) -> Option<f64> {
    v.as_f64()
        .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        .filter(|n| n.is_finite())
}

/// Map the CBR body to samples for the demanded `symbol` / CBR `code`. Per-unit price is
/// `Value / Nominal`. No `.series` and no `.state`: the feed has neither, and nothing is fabricated.
fn cbr_to_samples(symbol: &str, code: &str, body: &Value, ts_ms: u64) -> Vec<SensorSample> {
    let v = &body["Valute"][code];
    let nominal = match v.get("Nominal") {
        None | Some(Value::Null) => 1.0,
        Some(n) => match field_f64(n).and_then(positive) {
            Some(n) => n,
            None => return Vec::new(),
        },
    };
    let Some(price) = v["Value"].as_f64().map(|x| x / nominal).and_then(positive) else {
        return Vec::new();
    };
    let prev = v["Previous"]
        .as_f64()
        .map(|x| x / nominal)
        .and_then(positive);
    let base = format!("stocks.{}", symbol.trim().to_uppercase());
    let mut out = vec![SensorSample::scalar(format!("{base}.price"), ts_ms, price)];
    if let Some(pc) = prev {
        // Extreme provider values can overflow to inf (serialised as null): drop those.
        if let Some(pct) = crate::stocks::change_pct(price, pc).filter(|p| p.is_finite()) {
            out.push(SensorSample::scalar(format!("{base}.change"), ts_ms, pct));
        }
        if (price - pc).is_finite() {
            out.push(SensorSample::scalar(
                format!("{base}.changeAbs"),
                ts_ms,
                price - pc,
            ));
        }
        out.push(SensorSample::scalar(format!("{base}.prevClose"), ts_ms, pc));
    }
    out.push(SensorSample::text(format!("{base}.currency"), ts_ms, "RUB"));
    out
}

/// Map a Binance `ticker/24hr` body (+ optional 5m klines) to samples. Binance sends numbers as JSON
/// strings. The window is a rolling 24h, so "previous close" is the price ~24h ago.
fn binance_to_samples(
    symbol: &str,
    ticker: &Value,
    klines: Option<&Value>,
    ts_ms: u64,
) -> Vec<SensorSample> {
    let Some(price) = field_f64(&ticker["lastPrice"]).and_then(positive) else {
        return Vec::new();
    };
    let prev = field_f64(&ticker["prevClosePrice"]).and_then(positive);
    let base = format!("stocks.{}", symbol.trim().to_uppercase());
    let mut out = vec![SensorSample::scalar(format!("{base}.price"), ts_ms, price)];
    let pct = prev
        .and_then(|pc| crate::stocks::change_pct(price, pc))
        .filter(|p| p.is_finite())
        .or_else(|| field_f64(&ticker["priceChangePercent"]));
    if let Some(p) = pct {
        out.push(SensorSample::scalar(format!("{base}.change"), ts_ms, p));
    }
    let abs = prev
        .map(|pc| price - pc)
        .filter(|a| a.is_finite())
        .or_else(|| field_f64(&ticker["priceChange"]));
    if let Some(a) = abs {
        out.push(SensorSample::scalar(format!("{base}.changeAbs"), ts_ms, a));
    }
    if let Some(pc) = prev {
        out.push(SensorSample::scalar(format!("{base}.prevClose"), ts_ms, pc));
    }
    out.push(SensorSample::text(format!("{base}.currency"), ts_ms, "USD"));
    if let Some(rows) = klines.and_then(Value::as_array) {
        let mut closes: Vec<f64> = rows.iter().filter_map(|row| field_f64(&row[4])).collect();
        closes.drain(..closes.len().saturating_sub(MAX_SERIES));
        if closes.len() >= 2 {
            out.push(SensorSample {
                sensor: format!("{base}.series"),
                ts_ms,
                value: SensorValue::Series(closes),
            });
        }
    }
    out
}

async fn fetch_cbr(client: &reqwest::Client, url: &str, symbol: &str) -> Result<Value, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(crate::http_response::request_error)?;
    if !resp.status().is_success() {
        return Err(format!("{symbol}: HTTP {}", resp.status()));
    }
    crate::http_response::read_json(resp, JSON_CAP).await
}

/// `Ok(None)` = Binance does not know the pair (HTTP 400, code -1121): connected, no samples.
async fn fetch_ticker(
    client: &reqwest::Client,
    url: &str,
    symbol: &str,
) -> Result<Option<Value>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(crate::http_response::request_error)?;
    if resp.status() == reqwest::StatusCode::BAD_REQUEST {
        return Ok(None);
    }
    if !resp.status().is_success() {
        return Err(format!("{symbol}: HTTP {}", resp.status()));
    }
    crate::http_response::read_json(resp, TICKER_CAP)
        .await
        .map(Some)
}

/// Best effort: any failure just means no `.series`.
async fn fetch_klines(client: &reqwest::Client, url: &str) -> Option<Value> {
    let resp = client.get(url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    crate::http_response::read_json(resp, JSON_CAP).await.ok()
}

/// Poll one demanded `symbol`. Errors never contain a URL.
pub async fn poll_symbol(
    client: &reqwest::Client,
    state: &mut CbrState,
    symbol: &str,
    now: Instant,
    ts_ms: u64,
) -> Result<Quote, String> {
    poll_with(client, state, symbol, now, ts_ms, CBR_URL, BINANCE_BASE).await
}

async fn poll_with(
    client: &reqwest::Client,
    state: &mut CbrState,
    symbol: &str,
    now: Instant,
    ts_ms: u64,
    cbr_url: &str,
    binance_base: &str,
) -> Result<Quote, String> {
    let key = symbol.trim().to_uppercase();
    match route_symbol(symbol) {
        Route::Unsupported => {
            if state.warned.len() < MAX_WARNED && state.warned.insert(key.clone()) {
                eprintln!(
                    "stocks: symbol {} is not supported by the cbr-binance provider",
                    log_key(&key)
                );
            }
            Ok(Quote::Unsupported)
        }
        Route::Cbr { code } => {
            if state.stale(now) {
                // Reuse the last failure inside the retry floor: no second request in this tick
                // for another CBR symbol, none on the next ticks either.
                if let Some(err) = state.recent_failure(now) {
                    return Err(err);
                }
                state.last_attempt = Some(now);
                match fetch_cbr(client, cbr_url, &key).await {
                    Ok(body) => state.accept(body, now),
                    Err(e) => {
                        state.last_error = Some(e.clone());
                        return Err(e);
                    }
                }
            }
            if state.emitted.contains(&key) {
                return Ok(Quote::Cached);
            }
            let samples = state
                .body
                .as_ref()
                .map(|(body, _, _)| cbr_to_samples(&key, &code, body, ts_ms))
                .unwrap_or_default();
            if !samples.is_empty() {
                state.emitted.insert(key);
            }
            Ok(Quote::Samples(samples))
        }
        Route::Binance { pair } => {
            let Some(ticker) = fetch_ticker(client, &ticker_url(binance_base, &pair), &key).await?
            else {
                return Ok(Quote::Samples(Vec::new()));
            };
            let klines = fetch_klines(client, &klines_url(binance_base, &pair)).await;
            Ok(Quote::Samples(binance_to_samples(
                &key,
                &ticker,
                klines.as_ref(),
                ts_ms,
            )))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    fn cbr(code: &str) -> Route {
        Route::Cbr { code: code.into() }
    }
    fn bn(pair: &str) -> Route {
        Route::Binance { pair: pair.into() }
    }

    #[test]
    fn routes_cbr_spellings() {
        for s in [
            "USDRUB",
            "USDRUB=X",
            "usd-rub",
            "USD/RUB",
            "USD_RUB=X",
            " usdrub ",
        ] {
            assert_eq!(route_symbol(s), cbr("USD"), "{s}");
        }
        assert_eq!(route_symbol("EURRUB=X"), cbr("EUR"));
        assert_eq!(route_symbol("BTCRUB"), cbr("BTC"));
    }

    #[test]
    fn routes_binance_spellings() {
        for s in [
            "BTC-USD", "BTC/USD", "BTCUSD", "BTCUSDT", "btc-usdt", "BTC_USD",
        ] {
            assert_eq!(route_symbol(s), bn("BTCUSDT"), "{s}");
        }
        assert_eq!(route_symbol("ETH-USD"), bn("ETHUSDT"));
    }

    #[test]
    fn unsupported_and_hostile_symbols_never_route() {
        for s in [
            "AAPL",
            "^GSPC",
            "EURUSD=X",
            "RUBRUB",
            "BTC-USD=X",
            "",
            "   ",
            "BTC&limit=1",
            "BTC USD",
            "../x",
            "BTC-USD?x=1",
            "ИКС-USD",
            "ABCDEFGHIJKLMNOPQRSTUVWXY",
        ] {
            assert_eq!(route_symbol(s), Route::Unsupported, "{s}");
        }
        assert_eq!("ABCDEFGHIJKLMNOPQRSTUVWXY".len(), 25);
    }

    fn cbr_body() -> Value {
        json!({
            "Date": "2026-11-08T11:30:00+03:00",
            "Valute": {
                "USD": { "Nominal": 1, "Value": 80.0, "Previous": 78.0 },
                "JPY": { "Nominal": 100, "Value": 50.0, "Previous": 40.0 },
                "NOP": { "Value": 10.0 },
                "ZER": { "Value": 0.0, "Previous": 1.0 },
                "BAD": { "Nominal": 0, "Value": 5.0, "Previous": 4.0 }
            }
        })
    }

    fn scalar_of(s: &[SensorSample], id: &str) -> Option<f64> {
        s.iter()
            .find(|x| x.sensor == id)
            .and_then(|x| match x.value {
                SensorValue::Scalar(v) => Some(v),
                _ => None,
            })
    }

    #[test]
    fn cbr_maps_price_change_and_currency_under_the_demanded_key() {
        let s = cbr_to_samples("usdrub=x", "USD", &cbr_body(), 5);
        assert_eq!(scalar_of(&s, "stocks.USDRUB=X.price"), Some(80.0));
        assert_eq!(scalar_of(&s, "stocks.USDRUB=X.prevClose"), Some(78.0));
        assert_eq!(scalar_of(&s, "stocks.USDRUB=X.changeAbs"), Some(2.0));
        let pct = scalar_of(&s, "stocks.USDRUB=X.change").unwrap();
        assert!((pct - 2.0 / 78.0 * 100.0).abs() < 1e-9);
        let cur = s.iter().find(|x| x.sensor.ends_with(".currency")).unwrap();
        assert!(matches!(&cur.value, SensorValue::Text(t) if t == "RUB"));
        assert!(s.iter().all(|x| !x.sensor.ends_with(".series")));
        assert!(s.iter().all(|x| !x.sensor.ends_with(".state")));
    }

    #[test]
    fn cbr_divides_by_nominal() {
        let s = cbr_to_samples("JPYRUB", "JPY", &cbr_body(), 0);
        assert_eq!(scalar_of(&s, "stocks.JPYRUB.price"), Some(0.5));
        assert_eq!(scalar_of(&s, "stocks.JPYRUB.prevClose"), Some(0.4));
    }

    #[test]
    fn cbr_degrades_without_inventing_values() {
        // Missing Previous: price + currency only, no change fields.
        let s = cbr_to_samples("NOPRUB", "NOP", &cbr_body(), 0);
        assert_eq!(scalar_of(&s, "stocks.NOPRUB.price"), Some(10.0));
        assert!(scalar_of(&s, "stocks.NOPRUB.change").is_none());
        assert!(scalar_of(&s, "stocks.NOPRUB.prevClose").is_none());
        assert!(cbr_to_samples("XXXRUB", "XXX", &cbr_body(), 0).is_empty());
        assert!(cbr_to_samples("ZERRUB", "ZER", &cbr_body(), 0).is_empty());
        assert!(cbr_to_samples("BADRUB", "BAD", &cbr_body(), 0).is_empty());
    }

    fn ticker() -> Value {
        json!({
            "lastPrice": "110.50",
            "prevClosePrice": "100.00",
            "priceChangePercent": "9.0",
            "priceChange": "9.0"
        })
    }

    fn klines(closes: &[&str]) -> Value {
        Value::Array(
            closes
                .iter()
                .map(|c| json!([0, "1", "2", "0.5", c, "9"]))
                .collect(),
        )
    }

    #[test]
    fn binance_parses_string_numbers_and_series() {
        let k = klines(&["100.0", "105.5", "110.5"]);
        let s = binance_to_samples("btc-usd", &ticker(), Some(&k), 1);
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.price"), Some(110.5));
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.prevClose"), Some(100.0));
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.change"), Some(10.5));
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.changeAbs"), Some(10.5));
        let series = s.iter().find(|x| x.sensor.ends_with(".series")).unwrap();
        assert!(matches!(&series.value, SensorValue::Series(v) if v == &[100.0, 105.5, 110.5]));
        let cur = s.iter().find(|x| x.sensor.ends_with(".currency")).unwrap();
        assert!(matches!(&cur.value, SensorValue::Text(t) if t == "USD"));
        assert!(s.iter().all(|x| !x.sensor.ends_with(".state")));
    }

    #[test]
    fn binance_falls_back_to_reported_percent_without_prev_close() {
        let t = json!({ "lastPrice": "10", "priceChangePercent": "-1.5", "priceChange": "-0.2" });
        let s = binance_to_samples("BTC-USD", &t, None, 0);
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.change"), Some(-1.5));
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.changeAbs"), Some(-0.2));
        assert!(scalar_of(&s, "stocks.BTC-USD.prevClose").is_none());
    }

    #[test]
    fn binance_series_needs_two_good_closes() {
        let one = klines(&["1.0"]);
        let s = binance_to_samples("X", &ticker(), Some(&one), 0);
        assert!(s.iter().all(|x| !x.sensor.ends_with(".series")));
        for bad in [
            json!("nope"),
            json!([[1], 7, "x"]),
            json!([null, [0, 1, 2, 3, "NaN"]]),
        ] {
            let s = binance_to_samples("X", &ticker(), Some(&bad), 0);
            assert!(s.iter().all(|x| !x.sensor.ends_with(".series")), "{bad}");
            assert_eq!(scalar_of(&s, "stocks.X.price"), Some(110.5));
        }
    }

    #[test]
    fn binance_zero_or_missing_price_is_empty() {
        let zero = json!({ "lastPrice": "0.0", "prevClosePrice": "1" });
        assert!(binance_to_samples("X", &zero, None, 0).is_empty());
        assert!(binance_to_samples("X", &json!({}), None, 0).is_empty());
    }

    #[test]
    fn cbr_cache_age_and_date_rules() {
        assert!(!cbr_due(Duration::from_secs(1799)));
        assert!(cbr_due(Duration::from_secs(1800)));
        let t0 = Instant::now();
        let mut st = CbrState::default();
        st.accept(cbr_body(), t0);
        st.emitted.insert("USDRUB".into());
        // Same Date: the emitted set survives a refetch (no duplicate history points).
        st.accept(cbr_body(), t0 + Duration::from_secs(1800));
        assert!(st.emitted.contains("USDRUB"));
        // New Date: every symbol is re-armed.
        let mut next = cbr_body();
        next["Date"] = json!("2026-11-09T11:30:00+03:00");
        st.accept(next, t0 + Duration::from_secs(3600));
        assert!(st.emitted.is_empty());
    }

    #[test]
    fn redirects_stay_on_https_provider_hosts() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap();
        assert!(follow_redirect(&u("https://www.cbr-xml-daily.ru/x"), 0));
        assert!(follow_redirect(&u("https://cbr-xml-daily.ru/x"), 2));
        assert!(follow_redirect(&u("https://api.binance.com/x"), 1));
        assert!(!follow_redirect(&u("https://api.binance.com/x"), 3));
        assert!(!follow_redirect(&u("http://api.binance.com/x"), 0));
        assert!(!follow_redirect(&u("https://evil.example/x"), 0));
        assert!(!follow_redirect(
            &u("https://api.binance.com.evil.example/x"),
            0
        ));
    }

    #[test]
    fn urls_carry_only_the_built_pair() {
        assert_eq!(
            ticker_url(BINANCE_BASE, "BTCUSDT"),
            "https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT"
        );
        assert_eq!(
            klines_url(BINANCE_BASE, "BTCUSDT"),
            "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=288"
        );
    }

    #[test]
    fn client_builds_with_the_identifying_user_agent() {
        assert!(provider_client().is_ok());
    }

    /// Serve `wires` one per connection, then stop listening.
    async fn serve(wires: Vec<String>) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            for wire in wires {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let mut buf = [0u8; 4096];
                let _ = sock.read(&mut buf).await;
                let _ = sock.write_all(wire.as_bytes()).await;
            }
        });
        addr
    }

    fn wire(status: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
    }

    #[tokio::test]
    async fn cbr_fetch_is_cached_and_a_new_date_rearms() {
        let mut next = cbr_body();
        next["Date"] = json!("2026-11-09T11:30:00+03:00");
        let addr = serve(vec![
            wire("200 OK", &cbr_body().to_string()),
            wire("200 OK", &next.to_string()),
        ])
        .await;
        let url = format!("http://{addr}/daily_json.js");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let t0 = Instant::now();
        let poll = |st: &mut CbrState, sym: &'static str, at: Instant| {
            let (c, u) = (client.clone(), url.clone());
            let mut local = std::mem::take(st);
            async move {
                let r = poll_with(&c, &mut local, sym, at, 1, &u, BINANCE_BASE).await;
                (r, local)
            }
        };

        let (r, s) = poll(&mut st, "USDRUB=X", t0).await;
        st = s;
        assert!(
            matches!(r, Ok(Quote::Samples(ref v)) if !v.is_empty()),
            "{r:?}"
        );
        // Same symbol again: no network (the server only has one more response queued).
        let (r, s) = poll(&mut st, "USDRUB=X", t0 + Duration::from_secs(5)).await;
        st = s;
        assert!(matches!(r, Ok(Quote::Cached)), "{r:?}");
        // A newly demanded code maps from the cached body without a refetch.
        let (r, s) = poll(&mut st, "JPYRUB", t0 + Duration::from_secs(6)).await;
        st = s;
        assert!(
            matches!(r, Ok(Quote::Samples(ref v)) if !v.is_empty()),
            "{r:?}"
        );
        // After 30 min the body is refetched; a new Date re-emits.
        let (r, s) = poll(&mut st, "USDRUB=X", t0 + Duration::from_secs(1900)).await;
        st = s;
        assert!(
            matches!(r, Ok(Quote::Samples(ref v)) if !v.is_empty()),
            "{r:?}"
        );
        // Server is gone: a due refetch is an error, never stale data, and never names the URL.
        let (r, _) = poll(&mut st, "USDRUB=X", t0 + Duration::from_secs(4000)).await;
        let err = r.unwrap_err();
        assert!(!err.contains("127.0.0.1"), "{err}");
    }

    #[tokio::test]
    async fn binance_400_is_connected_with_no_samples_and_5xx_is_an_error() {
        let addr = serve(vec![
            wire(
                "400 Bad Request",
                r#"{"code":-1121,"msg":"Invalid symbol."}"#,
            ),
            wire("429 Too Many Requests", "{}"),
        ])
        .await;
        let base = format!("http://{addr}/api/v3");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let t0 = Instant::now();
        let r = poll_with(&client, &mut st, "ZZZ-USD", t0, 1, CBR_URL, &base).await;
        assert!(
            matches!(r, Ok(Quote::Samples(ref v)) if v.is_empty()),
            "{r:?}"
        );
        let r = poll_with(&client, &mut st, "BTC-USD", t0, 1, CBR_URL, &base).await;
        let err = r.unwrap_err();
        assert!(err.contains("BTC-USD: HTTP 429"), "{err}");
        assert!(
            !err.contains("127.0.0.1") && !err.contains("symbol="),
            "{err}"
        );
    }

    #[tokio::test]
    async fn binance_price_survives_a_failed_klines_call() {
        let t = r#"{"lastPrice":"50.0","prevClosePrice":"40.0"}"#;
        let addr = serve(vec![
            wire("200 OK", t),
            wire("500 Internal Server Error", "{}"),
        ])
        .await;
        let base = format!("http://{addr}/api/v3");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let r = poll_with(
            &client,
            &mut st,
            "BTC-USD",
            Instant::now(),
            1,
            CBR_URL,
            &base,
        )
        .await;
        let Ok(Quote::Samples(s)) = r else {
            panic!("expected samples")
        };
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.price"), Some(50.0));
        assert!(s.iter().all(|x| !x.sensor.ends_with(".series")));
    }

    #[tokio::test]
    async fn unsupported_symbol_makes_no_request_and_warns_once() {
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        for _ in 0..2 {
            let r = poll_symbol(&client, &mut st, "AAPL", Instant::now(), 1).await;
            assert!(matches!(r, Ok(Quote::Unsupported)));
        }
        assert_eq!(st.warned.len(), 1);
    }

    #[test]
    fn log_key_is_escaped_and_bounded() {
        let hostile = format!("A\nB{}", "X".repeat(1000));
        let shown = log_key(&hostile);
        assert!(shown.chars().count() <= MAX_SYMBOL_LEN, "{shown}");
        assert!(
            !shown.contains('\n') && shown.starts_with("A\\nB"),
            "{shown}"
        );
        assert_eq!(log_key("AAPL"), "AAPL");
    }

    #[tokio::test]
    async fn warned_set_is_capped() {
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        for i in 0..(MAX_WARNED + 20) {
            let r = poll_symbol(&client, &mut st, &format!("J{i}"), Instant::now(), 1).await;
            assert!(matches!(r, Ok(Quote::Unsupported)));
        }
        assert_eq!(st.warned.len(), MAX_WARNED);
    }

    #[test]
    fn binance_series_keeps_only_the_last_288_closes() {
        let owned: Vec<String> = (0..300).map(|i| i.to_string()).collect();
        let refs: Vec<&str> = owned.iter().map(String::as_str).collect();
        let s = binance_to_samples("X", &ticker(), Some(&klines(&refs)), 0);
        let series = s.iter().find(|x| x.sensor.ends_with(".series")).unwrap();
        let SensorValue::Series(v) = &series.value else {
            panic!("series expected")
        };
        assert_eq!(v.len(), MAX_SERIES);
        assert_eq!((v[0], v[MAX_SERIES - 1]), (12.0, 299.0));
        // Positive control: a short series is untouched.
        let s = binance_to_samples("X", &ticker(), Some(&klines(&["1", "2", "3"])), 0);
        let series = s.iter().find(|x| x.sensor.ends_with(".series")).unwrap();
        assert!(matches!(&series.value, SensorValue::Series(v) if v.len() == 3));
    }

    #[test]
    fn overflowing_change_is_dropped_but_the_price_stays() {
        let body = json!({ "Valute": { "USD": { "Value": 1e300, "Previous": 1e-308 } } });
        let s = cbr_to_samples("USDRUB", "USD", &body, 0);
        assert_eq!(scalar_of(&s, "stocks.USDRUB.price"), Some(1e300));
        assert!(scalar_of(&s, "stocks.USDRUB.change").is_none());
        let t = json!({ "lastPrice": "1e300", "prevClosePrice": "1e-308" });
        let s = binance_to_samples("BTC-USD", &t, None, 0);
        assert_eq!(scalar_of(&s, "stocks.BTC-USD.price"), Some(1e300));
        assert!(scalar_of(&s, "stocks.BTC-USD.change").is_none());
        // Positive control: the normal fixture still emits `.change`.
        let s = cbr_to_samples("USDRUB", "USD", &cbr_body(), 0);
        assert!(scalar_of(&s, "stocks.USDRUB.change").is_some());
    }

    #[test]
    fn a_dateless_body_is_always_new() {
        let t0 = Instant::now();
        let mut st = CbrState::default();
        st.accept(json!({ "Valute": {} }), t0);
        st.emitted.insert("USDRUB".into());
        st.accept(json!({ "Valute": {} }), t0 + Duration::from_secs(1800));
        assert!(st.emitted.is_empty());
    }

    /// Like `serve`, but counts accepted connections and keeps accepting (answering nothing) once
    /// the queued wires are used up, so an unexpected request is visible in the counter.
    async fn serve_counted(
        wires: Vec<String>,
    ) -> (
        std::net::SocketAddr,
        std::sync::Arc<std::sync::atomic::AtomicUsize>,
    ) {
        use std::sync::atomic::Ordering;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let seen = count.clone();
        tokio::spawn(async move {
            let mut wires = wires.into_iter();
            while let Ok((mut sock, _)) = listener.accept().await {
                seen.fetch_add(1, Ordering::SeqCst);
                if let Some(wire) = wires.next() {
                    let mut buf = [0u8; 4096];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock.write_all(wire.as_bytes()).await;
                }
            }
        });
        (addr, count)
    }

    #[tokio::test]
    async fn cbr_outage_costs_one_request_per_retry_floor() {
        use std::sync::atomic::Ordering;
        let (addr, count) = serve_counted(vec![
            wire("503 Service Unavailable", "{}"),
            wire("200 OK", &cbr_body().to_string()),
        ])
        .await;
        let url = format!("http://{addr}/daily_json.js");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let t0 = Instant::now();

        // Two CBR symbols in the same tick: the first failure is reused.
        let a = poll_with(&client, &mut st, "USDRUB=X", t0, 1, &url, BINANCE_BASE).await;
        let b = poll_with(&client, &mut st, "EURRUB=X", t0, 1, &url, BINANCE_BASE).await;
        let (a, b) = (a.unwrap_err(), b.unwrap_err());
        assert!(a.contains("HTTP 503"), "{a}");
        assert!(a.starts_with("USDRUB=X: HTTP 503"), "{a}");
        assert_eq!(a, b);
        assert!(!a.contains("127.0.0.1"), "{a}");
        assert!(!a.contains("cbr-xml-daily"), "{a}");
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // Next tick inside the floor: still the stored error, still one connection.
        let c = poll_with(
            &client,
            &mut st,
            "USDRUB=X",
            t0 + Duration::from_secs(60),
            1,
            &url,
            BINANCE_BASE,
        )
        .await;
        assert_eq!(c.unwrap_err(), a);
        assert_eq!(count.load(Ordering::SeqCst), 1);

        // Positive control: past the floor the 200 on the same listener yields samples.
        let d = poll_with(
            &client,
            &mut st,
            "USDRUB=X",
            t0 + CBR_RETRY_FLOOR,
            1,
            &url,
            BINANCE_BASE,
        )
        .await;
        assert!(
            matches!(d, Ok(Quote::Samples(ref v)) if !v.is_empty()),
            "{d:?}"
        );
        assert_eq!(count.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn redirect_policy_rejects_host_spoofing_tricks() {
        let u = |s: &str| reqwest::Url::parse(s).unwrap_or_else(|e| panic!("{s}: {e}"));
        for hostile in [
            // userinfo: the real host is evil.example
            "https://api.binance.com@evil.example/",
            "https://www.cbr-xml-daily.ru:pw@evil.example:8443/",
            // allowed name only in the path or query
            "https://evil.example/api.binance.com",
            "https://evil.example/?h=api.binance.com",
            // punycode / IDN homoglyph (Cyrillic a) of an allowed host
            "https://xn--80ak6aa92e.com/",
            "https://\u{430}pi.binance.com/",
            // trailing dot is a different host string
            "https://api.binance.com./",
            "https://www.cbr-xml-daily.ru./",
            // other subdomain, other schemes
            "https://sub.api.binance.com/",
            "http://api.binance.com/",
            "ftp://api.binance.com/",
        ] {
            assert!(!follow_redirect(&u(hostile), 0), "{hostile}");
        }
        // Positive controls on the same code path, including the hop limit.
        for ok in [
            "https://api.binance.com/x",
            "https://www.cbr-xml-daily.ru/x",
            "https://cbr-xml-daily.ru/x",
        ] {
            assert!(follow_redirect(&u(ok), 2), "{ok}");
            assert!(!follow_redirect(&u(ok), 3), "{ok} hop 3");
        }
    }

    #[test]
    fn routing_pairs_cover_separator_and_quote_variants() {
        assert_eq!(route_symbol("USD_RUB"), cbr("USD"));
        assert_eq!(route_symbol("usd/rub=x"), cbr("USD"));
        assert_eq!(route_symbol("BTC/USD"), bn("BTCUSDT"));
        assert_eq!(route_symbol("BTCUSD"), bn("BTCUSDT"));
        assert_eq!(route_symbol("BTC-USDT"), bn("BTCUSDT"));
        assert_eq!(route_symbol("btc_usdt"), bn("BTCUSDT"));
        assert_eq!(route_symbol("BTCRUB"), cbr("BTC"));
        // A one-letter base is below the 2-char floor; fx pairs on =X never go to Binance.
        assert_eq!(route_symbol("X-USD"), Route::Unsupported);
        assert_eq!(route_symbol("EURUSD=X"), Route::Unsupported);
        assert_eq!(route_symbol("RUBRUB"), Route::Unsupported);
        assert_eq!(route_symbol("RUB-RUB=X"), Route::Unsupported);
    }

    #[tokio::test]
    async fn cbr_http_error_names_the_symbol_and_never_the_host() {
        let addr = serve(vec![
            wire("503 Service Unavailable", "{}"),
            wire("200 OK", &cbr_body().to_string()),
        ])
        .await;
        let url = format!("http://{addr}/daily_json.js");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let t0 = Instant::now();
        let err = poll_with(&client, &mut st, "usdrub=x", t0, 1, &url, BINANCE_BASE)
            .await
            .unwrap_err();
        assert!(err.starts_with("USDRUB=X: HTTP 503"), "{err}");
        assert!(!err.contains("cbr-xml-daily"), "{err}");
        assert!(!err.contains("127.0.0.1"), "{err}");
        // Positive control: after the retry floor the 200 on the same listener yields samples.
        let ok = poll_with(
            &client,
            &mut st,
            "usdrub=x",
            t0 + CBR_RETRY_FLOOR,
            1,
            &url,
            BINANCE_BASE,
        )
        .await;
        let Ok(Quote::Samples(v)) = ok else {
            panic!("{ok:?}");
        };
        assert_eq!(scalar_of(&v, "stocks.USDRUB=X.price"), Some(80.0));
    }

    #[tokio::test]
    async fn demanded_key_is_normalised_in_polled_sample_ids() {
        let addr = serve(vec![wire("200 OK", &cbr_body().to_string())]).await;
        let url = format!("http://{addr}/daily_json.js");
        let client = provider_client().unwrap();
        let mut st = CbrState::default();
        let at = Instant::now();
        let r = poll_with(&client, &mut st, " usdrub=x ", at, 1, &url, BINANCE_BASE).await;
        let Ok(Quote::Samples(v)) = r else {
            panic!("{r:?}");
        };
        assert_eq!(scalar_of(&v, "stocks.USDRUB=X.price"), Some(80.0));
        assert!(v.iter().all(|x| x.sensor.starts_with("stocks.USDRUB=X.")));
    }
}
