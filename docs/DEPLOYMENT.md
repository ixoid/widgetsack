# Deployment — widgetsack fork

Owner-facing instructions in Russian: `README-fork.md`. This file is the agent-facing checklist.

## Targets
- One target: the owner's Windows 11 PC, two monitors, the overlay on the second one (`CRXED00-UID516`, 2560×720).
- Artifact: unsigned NSIS installer `widgetsack_<version>_x64-setup.exe` (Tauri 2 bundle, WebView2 bootstrapper
  on demand). No MSI, no auto-updater, no code signing.
- The installed release and the dev instance (`cargo tauri dev` without `--multi`) share
  `%APPDATA%\io.github.gyng\` and the single-instance lock. Only one of them runs at a time.

## Build
```powershell
.\scripts\release-fork.ps1          # gates → tauri build --bundles nsis --no-sign → dist\…-fork-<date>-<sha>-x64-setup.exe
```
Build order is client → Rust (Tauri embeds `client/build` at compile time). The upstream version number is kept
(`0.0.71`); builds are told apart by the commit SHA in the `dist\` file name. Rust must be on `PATH`
(`$HOME\.cargo\bin`).

## Environment variables
None. Configuration lives in the app config dir; integration secrets go through `secure_config` (DPAPI).
`WIDGETSACK_MULTI=1` (or `--multi`) starts a second, isolated instance with its config under `multi\`.

## Data-layer migrations
- Layout schema is frontend-owned (`layout v2`); the app migrates older layouts on load. Snapshot the live layout
  before any widget/layout change: `.\scripts\snapshot-layout.ps1` → `examples/layouts/own-desktop.widgets.json`.
- Plugin configs (`plugins/*.json`) are versioned by their own `version` field inside the encrypted blob; a
  provider switch (weather met.no, stocks cbr-binance) is a settings change, not a migration.

## Release steps
1. `main` only, clean tree, all gates green (the release script re-runs them unless `-SkipGates`).
2. `.\scripts\release-fork.ps1` → note the `dist\` file and its SHA-256.
3. Tag: `git tag -a fork-release-<yyyymmdd> -m "<what shipped>"` and push the tag.
4. Owner: quit the running app from the tray, run the installer, tick **Launch at login** on the finish page.
5. Do not install upstream `gyng/widgetsack` releases over the fork (same product name and identifier). Pull
   upstream through `scripts/sync-upstream.ps1`, then rebuild.

## Post-release verification
- Overlay comes up on the second monitor with the saved layout; Studio opens from the tray.
- `%LOCALAPPDATA%\io.github.gyng\logs\widgetsack.log` has `window geometry … frame_width=2560`.
- Plugins → Camera: **Test connection** returns the codec; the Camera widget goes live (without a full-tunnel VPN).
- Servers, tickers, weather, agenda cards show data within a minute.
- Autostart: `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\widgetsack` exists after enabling the toggle.
