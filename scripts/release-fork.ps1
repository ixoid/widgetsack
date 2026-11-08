# Build the fork's release installer and copy it into dist\ under a name that says which commit it is.
#
# The upstream version number stays untouched (0.0.71 today): changing it in tauri.conf.json, Cargo.toml and
# package.json would conflict on every upstream sync, and NSIS happily installs a same-version build over the
# previous one. The commit short SHA and the build date in the copied file name are what tell builds apart.
#
#   .\scripts\release-fork.ps1            # full build (client + Rust release + NSIS), unsigned
#   .\scripts\release-fork.ps1 -SkipGates # do not run the client/Rust gates first (local hotfix only)
#
# Requirements: Node 24, Rust stable MSVC in $HOME\.cargo\bin, VS Build Tools 2022, WebView2.
param(
    [switch]$SkipGates
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo
$env:PATH = "$HOME\.cargo\bin;$env:PATH"
$env:CARGO_TERM_COLOR = 'never'
$env:NO_COLOR = '1'

$sha = (git rev-parse --short HEAD).Trim()
$dirty = (git status --porcelain | Measure-Object -Line).Lines -gt 0
if ($dirty) { Write-Warning "working tree is dirty; the installer will be named $sha but contain uncommitted changes" }

if (-not $SkipGates) {
    Write-Host "[release] client gates" -ForegroundColor Cyan
    Push-Location (Join-Path $repo 'client')
    try {
        npm run check;         if ($LASTEXITCODE) { throw 'npm run check failed' }
        npm run lint;          if ($LASTEXITCODE) { throw 'npm run lint failed' }
        npm run test:coverage; if ($LASTEXITCODE) { throw 'npm run test:coverage failed' }
        npm run build;         if ($LASTEXITCODE) { throw 'npm run build failed' }
        npm run check:docs;    if ($LASTEXITCODE) { throw 'npm run check:docs failed' }
    } finally { Pop-Location }
    Write-Host "[release] Rust gates" -ForegroundColor Cyan
    cargo fmt --check;                           if ($LASTEXITCODE) { throw 'cargo fmt --check failed' }
    cargo test;                                  if ($LASTEXITCODE) { throw 'cargo test failed' }
    cargo clippy --all-targets -- -D warnings;   if ($LASTEXITCODE) { throw 'cargo clippy failed' }
}

Write-Host "[release] tauri build (nsis, unsigned) at $sha" -ForegroundColor Cyan
& npx --yes @tauri-apps/cli@2.12.4 build --bundles nsis --no-sign
if ($LASTEXITCODE) { throw "tauri build failed with exit code $LASTEXITCODE" }

$setup = Get-ChildItem (Join-Path $repo 'target\release\bundle\nsis') -Filter '*-setup.exe' |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $setup) { throw 'no *-setup.exe found under target\release\bundle\nsis' }

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd'
$suffix = if ($dirty) { "$sha-dirty" } else { $sha }
$name = $setup.Name -replace '_x64-setup\.exe$', "_fork-$stamp-$suffix-x64-setup.exe"
$target = Join-Path $dist $name
Copy-Item $setup.FullName $target -Force
$hash = (Get-FileHash $target -Algorithm SHA256).Hash

Write-Host ""
Write-Host "[release] installer: $target" -ForegroundColor Green
Write-Host "[release] size:      $([math]::Round($setup.Length / 1MB, 1)) MB"
Write-Host "[release] sha256:    $hash"
Write-Host "[release] next: quit the running widgetsack from the tray, then run the installer."
