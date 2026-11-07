# Pull upstream (gyng/widgetsack) into the fork's main with a merge commit. See docs/dev/upstream-sync.md.
# Usage: ./scripts/sync-upstream.ps1 [-DryRun]
param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$branch = (git branch --show-current).Trim()
if ($branch -ne 'main') { throw "sync-upstream: run on main (current: $branch)" }
$dirty = git status --porcelain
if ($dirty) { throw "sync-upstream: working tree is dirty — commit or stash first:`n$dirty" }
if ((git remote get-url --push upstream) -ne 'DISABLED') { throw "sync-upstream: upstream push URL must stay DISABLED" }

git fetch upstream --tags
$behind = (git rev-list --count main..upstream/main)
if ([int]$behind -eq 0) { Write-Host 'sync-upstream: already up to date with upstream/main'; exit 0 }

Write-Host "sync-upstream: $behind upstream commit(s) since the last sync:"
git log --oneline main..upstream/main
if ($DryRun) { Write-Host 'sync-upstream: dry run, not merging'; exit 0 }

$tag = 'upstream-sync-' + (Get-Date -Format 'yyyyMMdd')
git merge --no-ff upstream/main -m "chore(sync): merge upstream/main ($(git rev-parse --short upstream/main))"
if ($LASTEXITCODE -ne 0) {
  Write-Host 'sync-upstream: conflicts — resolve the registration points (docs/dev/upstream-sync.md), run the gates, then: git commit; git tag ' + $tag
  exit 1
}
git tag $tag
Write-Host "sync-upstream: merged and tagged $tag. Now run the gates (client + cargo) before pushing to origin."
