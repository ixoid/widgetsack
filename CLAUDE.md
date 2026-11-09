# CLAUDE.md — widgetsack fork (личный Windows-дашборд)

> **Читать в начале каждой сессии.** Порядок чтения: `AGENTS.md` (конвенции апстрима — стиль, тесты,
> архитектура; он авторитетен для кода) → этот файл (правила владельца, факты форка, ловушки, пайплайн) →
> `.claude/AGENT_CONTEXT.md` (что сделано / в работе) → `docs/dev/fork-architecture-notes.md` (карта).
> ZCode (GLM) читает `AGENTS.md`, а не этот файл — там в §9 стоит отсылка сюда.

---

## 🎯 Project Overview

**Name:** widgetsack fork (`ixoid/widgetsack`, апстрим `gyng/widgetsack`, лицензия MIT OR Apache-2.0).
**What it is:** Rainmeter-подобный прозрачный click-through оверлей для Windows (Tauri 2 + React 19) с визуальным
редактором «Studio». Форк добавляет встроенные виджеты под задачи владельца: (1) **server check** — доступность
VPS и локальных хостов, (2) **camera** — живой RTSP с IP-камер через go2rtc, (3) **calendar/agenda** — ближайшие
события из личного календаря. Плюс автозапуск, один понятный конфиг, секреты вне git. Бриф: `WIDGETSACK_FORK_BRIEF.md`.
**Owner:** CTO-уровень, учится агентной разработке. Объяснять решения просто, показывать трейд-оффы, не делать больших
рефакторингов молча. Целевая платформа — только Windows 10/11.

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| Framework / shell | Tauri 2 (crate `widgetsack/`, workspace root `Cargo.toml`); NSIS-инсталлер; WebView2 |
| Language | Rust 2024 edition, rust-version 1.95 (на машине stable 1.97 MSVC) · TypeScript strict (client) |
| Frontend | React 19 + Vite, `client/` — статическая SPA, обе роли окна (overlay/studio) рендерят `Canvas.tsx` |
| Styling | CSS-файлы рядом с компонентами, токены `--np-*` / `--text-*` / `--space-*` (`client/src/styles.css`, `core/tokens.ts`); дизайн-система `docs/dev/design-system.md` |
| State management | `useSyncExternalStore`-сторы (`client/src/stores`), editor reducer в `lib/core`, TelemetryHub (`core/telemetry.ts`) |
| Data layer | Фронт владеет схемами layout/widget/sack (JSON); бэкенд — только файловый I/O: `widgets.json`, `themes/*.css`, `sacks/*.sack.json`, `plugins/<integration>.json` в app config dir |
| Secrets | `widgetsack/src/secure_config.rs` — весь JSON шифруется DPAPI текущего пользователя; URL/токены не возвращаются в webview (write-only поля) |
| Bridge | Tauri `invoke` (имена команд = имена Rust-функций, реестр `client/src/lib/bridge/contract.ts`) + `emit`/`listen` (событие `telemetry` с батчами `SensorSample`) |
| Testing | Vitest + Testing Library + happy-dom (co-located `*.test.ts(x)`), 100% покрытие в включённом scope; Playwright e2e (`client/e2e`); Rust `#[cfg(test)]` в тех же файлах |
| Build / deploy | `npx --yes @tauri-apps/cli@2.12.4 dev|build`; CI `.github/workflows/test.yml`; release по тегу `v*` |
| Env handling | Нет .env. Конфиг приложения — `%APPDATA%\io.github.gyng\` (dev-инстанс `--multi` → подпапка `multi/`) |

**Verification command (агенты запускают после правок):**
```powershell
# client/ — те же гейты, что CI
npm run check; npm run lint; npm run test:coverage; npm run build
# repo root — ТОЛЬКО после npm run build (Tauri встраивает client/build при компиляции)
cargo fmt --check; cargo test; cargo clippy --all-targets -- -D warnings
```
Для `cargo` в этой песочнице нужно добавить `$HOME\.cargo\bin` в `PATH` на время команды (см. Gotchas).
Если тронут meta виджета — `npm run check:docs` (CI-гейт), обновление — `npm run gen:docs`.

---

## 📁 Project Structure

> Полная карта — `AGENTS.md` §2. Ключевые точки входа:
> - `widgetsack/src/main.rs` — `mod`-объявления, `.manage(...)` состояний, `invoke_handler![...]`, `spawn` фоновых источников (`run_system_sensors`, `run_ping_source`, …)
> - `widgetsack/src/{ping,service_health,agenda,rss,weather,mqtt,ha}.rs` — образцы «источник телеметрии» (pure seams + demand gate)
> - `widgetsack/src/command/` — `#[tauri::command]` по capability; `layout_grants.rs` — оверлей может вызывать только то, что есть в СОХРАНЁННОМ layout
> - `client/src/lib/core/widget.ts` — `WidgetMeta` (defaults, configFields, `sensors` map); `client/src/lib/widgets/registry.tsx` — type → компонент; `core/dashboardMetas.ts` — сложные metas отдельно
> - `client/src/lib/widgets/WidgetHost.tsx` — контейнер: `useSensorMap`, drag/resize; метеры в `widgets/meters/*` — только props
> - `client/src/lib/widgets/plugins/*` — встроенные интеграции (Settings-панели + `*-commands.ts` адаптеры), регистрация в `plugins/index.ts`
> - `widgetsack/tauri.conf.json` — окна, CSP, bundle; `widgetsack/capabilities/*.json` — разрешения Tauri
> - **Код форка:** `client/src/lib/widgets/fork/*`, `widgetsack/src/fork/*`; в ядро — только точки регистрации

---

## 🗃️ Data Model

**The data model lives in:** `client/src/lib/core/layout.ts`, `layoutTree.ts`, `layoutPersistence.ts` (layout v2), `core/widget.ts` (meta), `core/telemetry.ts` ↔ `widgetsack/src/sensors.rs` (`SensorSample { sensor, ts_ms, value }`). **Always read the actual file; never rely on a cached description.**

Key invariants:
- Виджет = `{ id, type, rect, config, sensor?, css?, tokens? }` в дереве row/col/grid; `default` = главный монитор. Бэкенд НЕ решает и не правит деревья.
- Сенсор-ID строковые с точками: `net.ping.<host>.ms`, `agenda.list`, `pkg.<id>.<sensor>`. Подписка виджета = спрос (demand gate): фоновый источник ничего не опрашивает, пока сенсор никем не смонтирован (`ActiveSensors`, `set_active_sensors`).
- Struct, пересекающий bridge, меняется **с обеих сторон в одном коммите** (serde camelCase ↔ TS-тип в `plugins/*-types.ts` / `stores.ts`).
- Конфиг интеграций с секретами (`plugins/agenda.json`, `ha.json`, …) — через `secure_config`; статус для webview несёт только host, не URL.
- **Никогда не отдавать в webview:** пароли камер, URL с токенами, токены HA/LLM, содержимое `secure_config`.

---

## ✅ Feature Status

### Done ✅
- [x] Этап 0: форк, тег `upstream-base`, окружение проверено, все гейты апстрима зелёные, dev-оверлей запущен, карта архитектуры и план написаны (2026-11-07)

### Not done ❌
- [ ] Этап 0: план этапов 1–3 согласован с владельцем (`docs/dev/fork-stage0-plan.md` § Decisions requested)
- [x] Этап 1: server check — в `main` (merge f53c9f5, 2026-11-07, ADR-002); осталась проверка владельцем на живом оверлее с тремя реальными целями и карточка в раскладке
- [x] Этап 2: camera — в `main` (merge 6f29604, 2026-11-08, ADR-005): нативный RTSP через `retina` → `Channel` → WebCodecs, без go2rtc и без правки CSP; креды только в `secure_config`; живая картинка проверена в Studio (спайк), на оверлее под VPN владельца штатно «No signal, retrying»
- [x] Этап 3: calendar / agenda — стоковый Agenda на ICS работает, K-1 `agendaplus` (группы + обратный отсчёт) в `main` 73a4247, виден на dev-оверлее (2026-11-07). CalDAV вне scope.
- [x] Этап 4: упаковка — `scripts/release-fork.ps1` → `dist/widgetsack_0.0.71_fork-<дата>-<sha>-x64-setup.exe` (первый боевой инсталлер 2026-11-08, тег `fork-release-20261108`); автозапуск — апстримный тумблер Settings/галочка инсталлера; `README-fork.md` и `docs/DEPLOYMENT.md` написаны; `config.example.*` заменён на `examples/layouts/own-desktop.widgets.json` (секреты примерами не бывают, вводятся в Studio)

---

## 🧑‍💻 Agent Roles & Skills

Skills live globally and surface themselves by description — name the *capability* you need in a task, not a path.

**Full feature pipeline:** `/feature <description>` — Requirements → CPO ↔ CTO → Architect → Backend → UI → Frontend → Security → QA → Tests → DevOps → Report.

**Два клиента, один пайплайн.** Claude Code берёт команды и агентов из `~/.claude`, ZCode (z.ai, модели GLM) — из `~/.zcode` и плагина `pipeline-toolkit` (зеркало от 2026-11-03). ZCode читает `AGENTS.md`, он в §9 отсылает сюда. Правила для обоих клиентов пишутся здесь.

**Модели.** Opus — auth/секреты, CSP, security-ревью; Sonnet — механика по точной спецификации, вёрстка, тесты; Fable — координация и решения. Перед merge в `main`: security-reviewer + qa-reviewer по финальному HEAD ветки.

**Маршрут форка (решение владельца 2026-11-07, `scripts/pipeline/route.mjs`, пиннится `route.test.ts`).** Координатор измеряет два дополнительных признака: `touchesTrustSurface` (CSP, capabilities, новые IPC-команды, secure_config, дочерние процессы) и `uiIsExistingPaneField` (правка — поле в существующей панели, не новый виджет). Правила: вторая итерация security только при `touchesTrustSurface`; UI-спека и runtime-eval выключены для поля в существующей панели; `mergeGate.on` → clarifier, CPO и CTO идут одним CONFIRM-агентом (sonnet), как в fast-path для роадмапа. Тест планировщика: из `client/` → `npx vitest run --root .. ../scripts/pipeline/route.test.ts`.

---

## 🔍 Code Review — Severity Tiers

CRITICAL blocks, HIGH warns, MEDIUM/LOW are notes.

| Tier | Examples | Action |
|---|---|---|
| **CRITICAL** | Секрет в репо или в webview; URL с кредами в логе/ошибке; расширение CSP шире нужного; команда оверлея без `layout_grants`; untrusted input через bridge без валидации | Block — fix before any merge |
| **HIGH** | Нет таймаута/лимита размера у сетевого вызова; источник без demand gate (опрашивает всегда); struct поменян с одной стороны bridge; `any`; метер читает store/Tauri напрямую | Must fix — warn |
| **MEDIUM** | Логика в `.tsx` вместо `lib/core`/Rust seam без теста; лишние ре-рендеры; жёсткие цвета вместо токенов; падение покрытия | Fix when possible |
| **LOW** | Стиль, имена, magic numbers, документация | Note only |

---

## 📏 Code Standards

- Апстримные: `AGENTS.md` §4–§7. Кратко: TDD, concentric architecture (домен без React/Tauri/DOM), atomic design (метеры — только props), Conventional Commits.
- Frontend: oxfmt — **табы**, одинарные кавычки, **без trailing commas**, `printWidth 100`; oxlint `--max-warnings=0`; TS strict, новых `any` нет.
- Rust: `rustfmt` по умолчанию, `clippy --all-targets -D warnings` чист; enum + exhaustive `match`; внешние типы остаются на краю (anti-corruption layer).
- Component size limit: метер ≤ ~150 строк — иначе выносить pure-хелперы в `*.ts` с тестом.
- **Response/return convention:** Tauri-команды возвращают `Result<T, String>`; ошибки — человекочитаемые, без URL/кредов внутри.
- **Env access:** нет env; конфиг через `file_io::config_root` + `secure_config`.
- Код и комментарии — **на английском**; объяснения владельцу — на русском.
- Comments explain WHY, not WHAT.

---

## 🔒 Security Rules

- **Граница проекта (правило владельца 2026-09-14).** Ничего вне папки проекта — процессы, файлы, окружение, реестр, устройства — без прямого «да» владельца в тексте. Нужно действие за границей → остановиться и спросить: «Нужно <действие> за пределами проекта, потому что <причина>. Подтверждаешь?». Свои процессы гасить только по PID, полученному при запуске; занятый порт — взять другой. `-Force`/`SilentlyContinue` не делают действие допустимым. Хук `block-process-kill` стоит глобально, хук `secret-guard` (`scripts/hooks/secret-guard.mjs`) — в этом репозитории; оба смотрят на весь текст команды, поэтому файлы со словами вроде kill или `.env` писать через Edit/Write, а не heredoc.
- **Секреты не в репо, даже в тестах:** пароли камер, RTSP-URL с кредами, приватные ICS-ссылки, токены. Хранить через `secure_config` (DPAPI); в git — только `*.example.*`. Перед коммитом — `git diff --cached | grep -iE "rtsp://.*:.*@|token=|password"` должен молчать.
- **Validate all inputs** на Rust-стороне команды: URL (схема, без user:pass@), хост (без пробелов), порт (1–65535), интервалы clamp как в `agenda.rs` (`MIN_INTERVAL`/`MAX_INTERVAL`).
- **Таймаут и лимит на каждый сетевой вызов** (образцы: `service_health.rs` 10 с, `http_response.rs` лимиты тела).
- **Оверлей без Studio-гейта** может вызывать только то, что есть в сохранённом layout — паттерн `layout_grants.rs` для любой новой команды, доступной из оверлея.
- **CSP** в `tauri.conf.json` расширять точечно (конкретный origin go2rtc, не `*`), с ADR.
- Никаких `--dangerously-*`, никаких отключений sandbox у `iframe`/`customhtml` ради камер.

---

## 🧪 Testing

```
client/:  npm run test:unit (watch) · npm run test:coverage (CI-гейт, 100% в включённом scope) · npm run test:e2e (Playwright, первый раз: npx playwright install chromium)
root:     cargo test (нужен client/build — хотя бы placeholder <!doctype html>, как в CI) · cargo test native_desktop_smoke -- --ignored (только вручную, трогает Win+D)
```

**Test invariants (breaking these = many failing tests):**
- Покрытие — храповик в `client/vite.config.ts`; новый код в `lib/core` без тестов роняет CI.
- Тесты детерминированы: без сети, реального железа, sleep; таймеры/слушатели восстанавливать.
- Rust-тесты сетевых seams поднимают локальный `TcpListener` на `127.0.0.1:0` (образец в `service_health.rs`) — не ходят наружу.
- `docs/widgets.md` генерируется из реестра: `check:docs` упадёт, если поменяли meta и не сделали `gen:docs`.

When adding a feature: run baseline → adapt affected tests → write new tests → full run green.

---

## 📝 Architecture Decisions

ADRs in `docs/decisions/`. **Create a new ADR** when: choosing between libraries/approaches, changing the data model, adding a dependency, расширяя CSP или capabilities, or defining a new pattern. Template: `docs/decisions/000-adr-template.md`. Апстримные архитектурные заметки — `docs/dev/architecture.md`.

---

## 🪤 Gotchas — traps that already cost time

> Read before any task. Each entry is a real bug or time sink. **Add to this list whenever something bites you.**

- **Сборка в порядке «клиент → Rust».** Tauri встраивает `client/build` на этапе компиляции (`generate_context!`); `cargo build/test/clippy` без собранного клиента либо падают, либо встраивают старый бандл. `cargo tauri dev` делает это сам через `beforeDevCommand`.
- **Пакетный менеджер клиента — npm (`package-lock.json`), не pnpm.** Node 24.
- **Tauri CLI пинится 2.12.4:** `npx --yes @tauri-apps/cli@2.12.4 dev|build`. Старые CLI не знают `build.windows.staticVCRuntime`.
- **Rust есть, но не в PATH песочницы:** `C:\Users\ixoid\.cargo\bin` (stable 1.97 MSVC). В каждой команде: PowerShell `$env:PATH = "$HOME\.cargo\bin;$env:PATH"`, bash `export PATH="$HOME/.cargo/bin:$PATH"`.
- **Апстримный `.gitignore` игнорировал `.claude/` целиком** — в форке правило снято, иначе слой пайплайна не коммитится. При merge апстрима сюда смотреть на конфликт в `.gitignore`.
- **Пинг в репо уже есть и уже на Rust** (`ping.rs`, `IcmpSendEcho`, без админ-прав). ICMP из песочницы агента слеп (TimedOut всегда) — проверять пинг только через сам оверлей или TCP-пробой, не `ping` из Bash.
- **`iframe`-виджет грузит только https, CSP `connect-src 'self' ipc:`.** go2rtc на `http://127.0.0.1:1984` через iframe/customhtml не заработает — нужен встроенный виджет и точечное расширение CSP.
- **Dev-инстанс рядом с установленным релизом:** `cargo run -- --multi` (или `WIDGETSACK_MULTI=1`) — отдельный конфиг в `<app config>/multi`, без single-instance lock. Dev-сервер Vite на порту **1420** (`strictPort`) — если занят, не убивать чужой процесс (граница проекта), а спросить владельца.
- **Тесты не должны зависеть от локали машины.** Node на Windows не читает `LC_ALL`/`LANG`; `Intl.NumberFormat(undefined, …)` под `ru-RU` даёт «1,25 млн» вместо `1.25M`. Два апстримных теста `AiUsage*.test.tsx` на этом падали до 2026-11-07, теперь ожидания считаются тем же форматтером; полный `npm run test:coverage` на этой машине зелёный, исключений в pre-push хуке больше нет. Новые тесты на вывод чисел/дат — через тот же `Intl`, что и код, или с явной локалью.
- **Апстрим только тянем, никогда не пушим.** `main` форка = апстрим + наши коммиты сверху; синк — `./scripts/sync-upstream.ps1` (merge `upstream/main` с `--no-ff`, тег `upstream-sync-<дата>`), процедура и точки конфликтов — `docs/dev/upstream-sync.md`. Push-URL `upstream` стоит `DISABLED`, `remote.pushDefault = origin`. Новый код — только в `fork/`-папках, в ядро — точки регистрации.
- **Файлы репозитория — только LF.** Бэкенд-агент 2026-11-07 пересохранил `main.rs`, `Cargo.toml`, `weather.rs` с CRLF (PowerShell `Set-Content`/`Out-File`), и диф в одну строку стал дифом в 1471 строку — это ломает слияние с апстримом. Правки делать через Edit/Write; `.gitattributes` теперь принудительно нормализует в LF, но проверять `git diff --stat` перед коммитом: подозрительно большой диф = CRLF.
- **Два хука режут команды по тексту:** `block-process-kill` (глобальный) и `secret-guard` (репо). Heredoc с `.env`/`kill` в тексте блокируется — писать такие файлы через Write/Edit.
- **Параллельные полосы (fork-агент + worktree) не порождают субагентов.** 2026-11-07 три полосы гнали `/feature` «в одном лице»: requirements, CPO/CTO, security и QA делал тот же агент, что писал код. Перед merge такой ветки в `main` координатор запускает отдельный security+QA-ревью (opus) по `git diff main...<branch>` — политика «security-reviewer + qa-reviewer по финальному HEAD» иначе не выполняется.
- **Параллельные ветки берут один и тот же номер ADR.** H-1 и S-1 обе создали `002-*.md`. Номер ADR выдаёт координатор при merge (следующий свободный в `docs/decisions/`), ссылки `ADR-00N` править во всех файлах ветки; в полосе — писать ADR как `NNN-<slug>.md` и не ссылаться на номер в коде, только на slug.
- **Регистронезависимая ФС: модуль и компонент в одной папке не называть одним словом.** `agendaplus.ts` рядом с `AgendaPlus.tsx` → `./AgendaPlus` резолвится в сам модуль, TS1149 «differs only in casing», компонент `undefined`. Файл плагина называть `<widget>-plugin.ts`, компонент — `PascalCase.tsx`.
- **Пустой экран после автоперезапуска dev-оверлея = клиент упал на старте, а не Rust.** 2026-11-08 (C-1): cargo-watch перезапускал `widgetsack.exe` после правок Rust ровно в те минуты, когда frontend-агент дописывал модули (Vite: `does not provide an export named …`). Клиент не загрузился → refit окон не выполнился → у процесса одно окно 375×500 по умолчанию (`overlay_diag: frame_width=375 … ex_style=0x00040110`) вместо `2560×720`, на экране ничего. Диагноз: `grep "window geometry" work/tauri-dev.log | tail`, `grep "Unhandled error" work/tauri-dev.err.log`. Лечение без убийства процессов: дождаться, пока `npm run check` зелёный, и `touch widgetsack/src/main.rs` — cargo-watch перезапустит приложение сам. Правило: параллельные Rust- и client-агенты допустимы, но после них координатор проверяет `window geometry` в логе, а не только «процесс жив». Второй симптом того же дня: Studio не открывается, в `tauri-dev.err.log` — `does not provide an export named …` с СТАРОЙ меткой `?t=` при зелёном `npm run check` — это устаревший transform-кэш Vite (watcher на Windows пропустил часть быстрых правок). Лечение: `touch` всех файлов тронутой папки, проверить `curl http://localhost:1420/<путь модуля>` на нужный экспорт, переоткрыть Studio.
- **Новые файлы коммитить до передачи следующему агенту.** 2026-11-08 (T-1) тест-райтер скриптом на Python обнулил `stocks_cbr.rs` (725 строк, untracked) до 2 байт — упал на кириллице при записи — и восстанавливал его из транскриптов предыдущих агентов. Git бы вернул файл одной командой, если бы он был в индексе. Правило координатора: после каждого шага пайплайна, который создал новые файлы (backend, frontend, fix), делать WIP-коммит на ветке (`wip(T-1): backend` и т. п.; перед merge — squash или оставить как есть), и только потом запускать следующего агента. Агентам: файлы с не-ASCII текстом писать только через Write/Edit, не через `open(..., 'w')` без `encoding='utf-8'` и не через PowerShell.
- **`retina` (RTSP-клиент камеры) пишет в фасад `log`, а бэкенда `log` в приложении нет — и добавлять его нельзя.** C-1 (ADR-005): `retina` на уровне debug/trace логирует адреса и куски RTSP-обмена, включая URL; стоит поставить `env_logger`/`tauri-plugin-log`, и креды камеры попадут в консоль и в файл логов. Поэтому: никакого `log`-бэкенда в `main.rs`/`Cargo.toml`, и никогда `{}`/`{:?}` от `retina::Error`, `Credentials`, `SessionOptions`, `CameraConfig` — их текст несёт адрес и контекст соединения. Ошибка превращается в enum только через `fork/camera/error_map.rs` (фаза + код статуса), в `crate::log` идёт `{kind, phase}`. Если для отладки нужен лог retina — смотреть счётчики/статус-события, а не включать фасад.
- **`retina::Session` нельзя дропать вне tokio-рантайма — только внутри задачи воркера.** Дроп сессии делает `tokio::spawn` (фоновый TEARDOWN); из синхронной Tauri-команды, из `spawn_blocking` или после остановки рантайма это паника «no reactor running» либо молчаливая потеря TEARDOWN — тогда замок Aqara держит RTSP-слот до своего таймаута, а слотов у него мало (S5 спайка: Aqara Home/HomeKit должны открываться параллельно, 10 циклов subscribe/unsubscribe не должны его заклинивать). Поэтому остановка кооперативная: `select!` на `watch`-канале внутри задачи, сессия дропается там же, затем join с `timeout(2 s)`, потом abort; воркер стартует из async-команды через `tokio::spawn` (это рантайм Tauri; в тестах рантайм свой), никогда через `spawn_blocking`. Отсюда же 2-секундный grace после последней отписки (`registry.rs`): StrictMode-ремонт и короткое скрытие оверлея не должны дёргать сессию туда-сюда.
- **В статистике WebCodecs `dropped` ≠ `superseded`.** Спайк C-1 показал «dropped 43 %» и выглядел как потеря данных; на деле это кадры, декодированные, но вытесненные более новым до rAF-отрисовки (newest-frame-wins, rAF режется, когда панель закрыта). Теперь `camera-decoder.ts` считает отдельно: `superseded` (норма, десятки процентов) и `dropped` (ошибки декода + дельты до ключевого кадра + сброс по `decodeQueueSize > 20`; на здоровом потоке около нуля). Смотреть на `dropped`, а не на сумму. Для Rust-стороны тайм-логику писать с явным `now` (в `Cargo.toml` у `tokio` нет `test-util`, паузить часы нельзя), а не через `tokio::time::pause`.

- **Отсоединённый лаунчер: путь с пробелом в `Start-Process pwsh -File` обязан быть в кавычках внутри `-ArgumentList`.** 2026-11-09 (W-3): `-ArgumentList '-File','D:\VSC proj\own pc\work\tauri-dev-multi.ps1'` молча запустил pwsh с аргументом `D:\VSC`, в `.err.log` легло «not recognized as the name of a script file», а координатор ждал строку `window geometry`, которой не могло быть; runtime-eval отработал вхолостую. Правильно: `'-File','"D:\VSC proj\own pc\work\…ps1"'` и сразу после запуска прочитать первые строки обоих логов. Dev-процесс, запущенный так, агент погасить не может (хук блокирует остановку процессов даже своих) — закрывает владелец из трея; планировать это заранее.

### Environment (Windows + MSYS bash) — already paid for, not TODOs

- **`node` does not understand an MSYS path.** `/c/proj/…` works for `cd`, but the same string handed to `node` resolves as `C:\c\proj\…` and dies with `ENOENT`. Node needs `C:/proj/…`. A probe that loads its own content from a file or a substitution must assert that content is non-empty — otherwise "green" means "the probe never loaded".
- **Non-ASCII text must not round-trip through PowerShell** `Get-Content`/`Set-Content`/`Out-File`: UTF-8-without-BOM turns Cyrillic into mojibake silently. Edit through Read/Edit/Write, finish by grepping for the actual word you wrote.
- **Entry-gate `import.meta.url === \`file://${process.argv[1]}\`` is always false on Windows.** Compare `resolve(argv[1])` with `fileURLToPath(import.meta.url)`.
- **Probe a local listener on the same address its real consumer uses:** `localhost` and `127.0.0.1` are different stacks here.

---

## 🔄 Self-improvement loop

- **Bug → rule:** when a bug lands in `docs/BACKLOG.md`, ask what rule here would have prevented it. If none exists, add it to Gotchas or Security Rules.
- **Start of session:** read Gotchas and the open items in `docs/BACKLOG.md`.
- **A pattern that repeats twice** becomes a rule, not just a backlog note.

---

## ✅ Verification

- **Never mark a task done without proof:** run the verification command + affected tests. For UI — визуальная проверка на живом оверлее (`cargo tauri dev` или `--multi`), для камер — реальный поток.
- **Staff-engineer question:** before the final answer — "would an experienced engineer approve this, or is there an obvious problem I missed?"
- **Pause before non-trivial changes:** CSP, capabilities, secure_config, дочерние процессы (go2rtc), автозапуск — есть скрытые зависимости; is there a simpler path?

---

## 📋 Plan management

- **Снимок живой раскладки перед каждым изменением (правило владельца 2026-11-07).** Владелец правит виджеты и раскладку руками в Studio; результат живёт только в `%APPDATA%\io.github.gyng\widgets.json`, git его не видит. Перед любой задачей, которая трогает виджеты, их meta/config-поля, раскладку или пример в `examples/layouts/`, сначала `.\scripts\snapshot-layout.ps1` (для dev-инстанса `-Multi`) и коммит `chore(layout): snapshot the live overlay layout`. Чтение этого файла владелец разрешил постоянно, это исключение из границы проекта; копировать пример из репо ПОВЕРХ живого файла — только по прямому «да». Коммит, который переименовывает/удаляет config-поле существующего виджета, обязан обновить и пример раскладки в том же коммите.
- **Minimal footprint:** touch only the files the task needs; новый код — в `fork/`-папках, ядро — только точки регистрации.
- **Visible progress:** чекбоксы этапов в брифе и в Feature Status выше; тикать по ходу.
- **Document decisions:** behavior change → ADR; recurring bug pattern → Gotchas rule; one-off bug → BACKLOG.
- **No half-implementations:** a stub with a TODO is worse than no feature — it fakes readiness.
- **Ветка на этап** (`feat/server-check`, `feat/camera`, `feat/calendar`), коммит на каждый логический шаг, Conventional Commits. В `main` не пушить без слова владельца.

---

## 🗣️ Communication Style

- **Только по-русски.** Все ответы, отчёты, сводки и вопросы владельцу — на русском (правило владельца с 2026-07-19). Идентификаторы не переводить: имена файлов, команды, коммиты, ID задач, вывод инструментов остаются как есть. Код, комментарии и коммит-месседжи — на английском (конвенция апстрима).
- Владелец — CTO-уровень, учится агентной разработке: объяснять решения просто, показывать трейд-оффы.
- **Спрашивать, если выбор неочевиден** (формат конфига, где хранить секреты, транспорт для видео). Не делать больших рефакторингов молча.
- Describe the plan in 2-3 sentences before writing code.
- After a task: summarize what changed and what to test manually.
- Flag manual actions (go2rtc.yaml с реальными камерами, ICS-ссылка, автозапуск, VM для чистой установки).
