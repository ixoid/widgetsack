# Backlog — <TODO: Project Name>

> Open bugs and findings. The security-reviewer and qa-reviewer agents APPEND here (HIGH/MEDIUM/LOW). /backlog triages, auto-fixes the simple ones, and prioritizes the rest.
>
> **An entry is closed by a run, not by a reading.** Every entry carries a `Check:` — a command
> plus the outcome that proves the finding is gone — and only that command's observed output
> closes it. "The code looks fixed" is an arrangement; `<command> → <outcome>` is a result.

Entry format:

```markdown
### [security|qa] Short title
- **Severity:** HIGH | MEDIUM | LOW
- **File:** `path:line`
- **Found by:** [agent]
- **Feature:** [feature name]
- **Date:** [YYYY-MM-DD]
- **Status:** open
- **Description:** [one line]
- **Fix:** [concrete approach]
- **Check:** [command → expected outcome; `none — <why>` if only the owner can close it]
```

Status lines carry evidence, not summaries:
`closed <date> — <command> → <observed outcome>` · `open — checked <date>, reproduces: <command> → <observed outcome>`.
A check asserting absence needs a positive control: the same probe must hit something somewhere,
or it is blind.

## HIGH

## MEDIUM

### [security] met.no HTTP-date parser overflows i64 on an unbounded year (panics in debug builds)
- **Severity:** MEDIUM
- **File:** `widgetsack/src/fork/weather_metno.rs:160` (year via `num`, unbounded digits) → overflow at `:118` (`days_from_civil(..) * 86_400`) and `:176` (subtraction)
- **Found by:** security-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** `parse_http_date` accepts any all-digit year; a response header like `Expires: Sat, 07 Nov 999999999999 16:53:45 GMT` makes `epoch_from_parts` multiply past i64::MAX. Scratch probe (functions copied verbatim, `-C overflow-checks=on`): `attempt to multiply with overflow` panic; release build wraps (result capped later at MAX_INTERVAL). A panic kills the weather poll task until the next `weather_connect`. Needs a hostile/compromised api.met.no response (TLS), hence MEDIUM.
- **Fix:** in `parse_http_date` require the year to be exactly 4 digits (`year_str.len() == 4`) or `(1970..=9999).contains(&year)` — same bound `parse_rfc3339_utc` already gets from its fixed width; and use `checked_sub` in `fresh_for`. Add a unit test for the huge-year header.
- **Check:** `cd widgetsack && cargo test fork::weather_metno::tests::http_date` → a new case `fresh_for(Some("Sat, 07 Nov 999999999999 16:53:45 GMT"), Some("Sat, 07 Nov 2026 16:23:45 GMT")) == None` passes in the (overflow-checked) test profile; positive control in the same test: the 2026 pair still yields `Some(1800s)`.

## LOW / Cosmetic

### [security] Weather HTTP clients follow redirects with reqwest's default policy (any scheme/host, 10 hops)
- **Severity:** LOW
- **File:** `widgetsack/src/fork/weather_metno.rs:53` (also pre-existing `widgetsack/src/weather.rs:294`)
- **Found by:** security-reviewer
- **Feature:** weather provider met.no
- **Date:** 2026-11-07
- **Status:** open
- **Description:** a redirect from api.met.no could send the request (URL carries the user's coordinates) to another host or downgrade to http; body cap and timeout still hold, so impact is location privacy only.
- **Fix:** `.redirect(reqwest::redirect::Policy::custom(|a| if a.url().scheme() == "https" && a.url().host_str() == Some("api.met.no") && a.previous().len() < 3 { a.follow() } else { a.stop() }))` in `metno_client`; same idea for the Open-Meteo client if upstream agrees.
- **Check:** `cd widgetsack && cargo test fork::weather_metno` → a new unit test asserting the policy closure stops an `http://` / foreign-host hop passes; positive control: same test follows an `https://api.met.no/...` hop.


### [qa] Upstream AiUsage tests depend on the machine locale
- **Severity:** LOW
- **File:** `client/src/lib/widgets/meters/AiUsage.test.tsx:218`, `client/src/lib/widgets/meters/AiUsage.compact.test.tsx:294`
- **Found by:** coordinator (stage 0 baseline)
- **Feature:** fork stage 0
- **Date:** 2026-11-07
- **Status:** open — checked 2026-11-07, reproduces: `npx vitest run src/lib/widgets/meters/AiUsage.test.tsx` → `Unable to find an element with the text: 1.2K tokens` (renders «1,2 тыс. tokens» under ru-RU)
- **Description:** `AiUsage.tsx:45` formats with `Intl.NumberFormat(undefined, { notation: 'compact' })`; the two tests assert English output, so they fail on any non-English Windows locale. Not a product bug (user-locale formatting is intended); a test-portability bug worth upstreaming.
- **Fix:** in the two tests, stub the formatter or assert via a locale-independent matcher (e.g. `screen.getByText((t) => /1[.,]25/.test(t))`), or pin `Intl.NumberFormat` default locale in `client/src/test-setup.ts` for the suite. Prefer the test-side fix and offer it upstream as a PR.
- **Check:** `cd client && npx vitest run src/lib/widgets/meters/AiUsage.test.tsx src/lib/widgets/meters/AiUsage.compact.test.tsx` on a ru-RU machine → `Tests 19 passed (19)`; positive control: the same two assertions still fail if the formatter is forced to `ru-RU`.

## Closed
<!-- fixed / wont-fix / stale items moved here with date + reason -->
