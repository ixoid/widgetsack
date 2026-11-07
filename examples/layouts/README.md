# Fork layouts

Version 2 layout documents for this fork (schema: [docs/dev/layout-format.md](../../docs/dev/layout-format.md)).
They contain no secrets: integration settings (weather location, calendar feed) live in Studio → Plugins.

| File | What it is |
| --- | --- |
| `own-desktop.widgets.json` | The owner's Rainmeter desktop rebuilt with built-in widgets, docked in three columns: weather + uptime/network on the left, clock + agenda in the centre, GPU / CPU / load history on the right. Fork widgets (server check, cameras) will be added as their stages land. |

## Snapshot the live layout (do this first)

The owner edits widgets and the layout by hand in Studio. Those edits exist only in the live
`widgets.json`; before changing widgets, their config fields or anything under `examples/layouts/`,
pull the live file into the repository and commit it, so the layout is recoverable:

```powershell
.\scripts\snapshot-layout.ps1          # release instance
.\scripts\snapshot-layout.ps1 -Multi   # --multi dev instance
git add examples\layouts\own-desktop.widgets.json
git commit -m "chore(layout): snapshot the live overlay layout"
```

The script is byte-exact (no re-encoding), refuses files that look like they contain credentials,
and runs the layout checker below.

## Check a layout

```powershell
cd client
npx vite-node scripts/check-layout.ts ../examples/layouts/own-desktop.widgets.json
```

The script runs the real document decoder and checks every widget type and config key against the registry.

## Load a layout

Studio previews and saves `widgets.json` in the app configuration directory
(`%APPDATA%\io.github.gyng\`, or `multi\` under it for a `--multi` instance). The overlay reloads when
the file changes. **This overwrites the owner's hand edits** — agents do it only on the owner's explicit
say-so, and never without the snapshot step above. Close Studio first so a pending preview write cannot
overwrite the copy:

```powershell
$layoutPath = "$env:APPDATA\io.github.gyng\widgets.json"
if (Test-Path -LiteralPath $layoutPath) { Copy-Item -LiteralPath $layoutPath -Destination "$layoutPath.bak" }
Copy-Item -LiteralPath examples\layouts\own-desktop.widgets.json -Destination $layoutPath
```

Then set the weather location and the calendar feed in Studio → Plugins.
