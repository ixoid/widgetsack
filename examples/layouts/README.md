# Fork layouts

Version 2 layout documents for this fork (schema: [docs/dev/layout-format.md](../../docs/dev/layout-format.md)).
They contain no secrets: integration settings (weather location, calendar feed) live in Studio → Plugins.

| File | What it is |
| --- | --- |
| `own-desktop.widgets.json` | The owner's Rainmeter desktop rebuilt with built-in widgets, docked in three columns: weather + uptime/network on the left, clock + agenda in the centre, GPU / CPU / load history on the right. Fork widgets (server check, cameras) will be added as their stages land. |

## Check a layout

```powershell
cd client
npx vite-node scripts/check-layout.ts ../examples/layouts/own-desktop.widgets.json
```

The script runs the real document decoder and checks every widget type and config key against the registry.

## Load a layout

Studio previews and saves `widgets.json` in the app configuration directory
(`%APPDATA%\io.github.gyng\`, or `multi\` under it for a `--multi` instance). The overlay reloads when
the file changes. Close Studio first so a pending preview write cannot overwrite the copy:

```powershell
$layoutPath = "$env:APPDATA\io.github.gyng\widgets.json"
if (Test-Path -LiteralPath $layoutPath) { Copy-Item -LiteralPath $layoutPath -Destination "$layoutPath.bak" }
Copy-Item -LiteralPath examples\layouts\own-desktop.widgets.json -Destination $layoutPath
```

Then set the weather location and the calendar feed in Studio → Plugins.
