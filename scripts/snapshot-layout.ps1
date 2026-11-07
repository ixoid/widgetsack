# Snapshot the live overlay layout into the repository before touching widgets or layouts.
#
# Studio writes the owner's layout to %APPDATA%\io.github.gyng\widgets.json (or multi\widgets.json
# for a --multi dev instance). Nothing in git tracks that file, so hand edits made in Studio are lost
# the moment someone copies examples\layouts\own-desktop.widgets.json back over it. Run this first,
# commit the result, and the layout is recoverable with one command.
#
# Usage (from the repository root):
#   .\scripts\snapshot-layout.ps1           # release instance
#   .\scripts\snapshot-layout.ps1 -Multi    # --multi dev instance
#
# Copy-Item is used on purpose: it is byte-exact, so the JSON never round-trips through a
# PowerShell string (which would re-encode Cyrillic and arrows and add CRLF).

[CmdletBinding()]
param(
	[switch]$Multi
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$configRoot = Join-Path $env:APPDATA 'io.github.gyng'
if ($Multi) { $configRoot = Join-Path $configRoot 'multi' }
$live = Join-Path $configRoot 'widgets.json'
$target = Join-Path $repoRoot 'examples\layouts\own-desktop.widgets.json'

if (-not (Test-Path -LiteralPath $live)) {
	Write-Error "No live layout at $live. Is the overlay installed and has Studio saved at least once?"
}

$liveInfo = Get-Item -LiteralPath $live
Write-Host "live:   $live  ($($liveInfo.Length) bytes, $($liveInfo.LastWriteTime))"

# Refuse to bake a secret into the repository even by accident.
$hits = Select-String -LiteralPath $live -Pattern 'rtsp://[^"]*:[^"]*@|token=|password|api[_-]?key' -CaseSensitive:$false
if ($hits) {
	Write-Error "The live layout contains something that looks like a credential; not copying. Lines: $($hits.LineNumber -join ', ')"
}

if (Test-Path -LiteralPath $target) {
	$before = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
	$after = (Get-FileHash -LiteralPath $live -Algorithm SHA256).Hash
	if ($before -eq $after) {
		Write-Host 'repo copy already matches the live layout; nothing to do.'
		exit 0
	}
}

Copy-Item -LiteralPath $live -Destination $target
Write-Host "copied: $target"

Push-Location (Join-Path $repoRoot 'client')
try {
	npx vite-node scripts/check-layout.ts ../examples/layouts/own-desktop.widgets.json
	if ($LASTEXITCODE -ne 0) { Write-Error 'check-layout reported problems; inspect before committing.' }
} finally {
	Pop-Location
}

Write-Host ''
Write-Host 'Next: review `git diff --stat examples/layouts` and commit, e.g.'
Write-Host '  git add examples/layouts/own-desktop.widgets.json'
Write-Host '  git commit -m "chore(layout): snapshot the live overlay layout"'
