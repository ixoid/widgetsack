# Keeping the fork in sync with upstream

The fork never contributes to `gyng/widgetsack`; it only pulls from it. `main` of the fork is
**upstream history + fork commits on top**. Feature branches merge into the fork's `main`;
upstream is pulled into `main` with a merge commit (never a rebase, so published fork history
stays stable).

## Guards already in place

- `git remote get-url --push upstream` → `DISABLED`: a stray `git push upstream` cannot happen.
- `remote.pushDefault = origin`, `branch.main.remote = origin`: `git push` goes to the fork.
- `.gitattributes` pins LF so a Windows agent cannot inflate a diff and create fake conflicts.
- Fork code lives in `widgetsack/src/fork/**`, `client/src/lib/widgets/fork/**`, `examples/layouts/**`,
  `docs/dev/fork-*.md`, `docs/decisions/**`, `.claude/**`, `scripts/pipeline/**` — upstream never
  touches those paths, so they merge cleanly.

## Where conflicts can appear (the registration points)

| File | Fork change | Expected conflict |
| --- | --- | --- |
| `widgetsack/src/main.rs` | `mod fork;` | trivial — keep both sides |
| `widgetsack/Cargo.toml` | `Win32_System_Time` feature on `windows` | trivial |
| `widgetsack/src/weather.rs` | `provider` field + provider branch in the poll loop | real conflict if upstream reworks weather.rs — re-apply the branch; the mapper itself is in `fork/` |
| `client/src/lib/widgets/plugins/WeatherSettings.tsx` | provider select + hints | real conflict if upstream restyles the pane |
| `client/src/lib/llm/studioIntegrationTools.ts` | `provider` in the weather field list | trivial |
| `client/src/lib/widgets/plugins/index.ts` | one `BUILTINS` row per fork plugin (future) | trivial |
| `.gitignore`, `AGENTS.md` | `.claude/` un-ignored; §9 fork layer | trivial |

## Procedure

```powershell
# from the repo root, on main, with a clean tree
./scripts/sync-upstream.ps1            # fetch, show what is new, merge upstream/main, tag
```

The script stops before merging if the tree is dirty or you are not on `main`, prints the upstream
commits since the last sync, merges with `--no-ff`, and tags `upstream-sync-<yyyymmdd>`. If the
merge reports conflicts, resolve them in the files above, then run the gates:

```powershell
cd client; npm ci; npm run check; npm run lint; npm run test:coverage; npm run build; cd ..
cargo fmt --all --check; cargo test; cargo clippy --all-targets -- -D warnings
```

Then `git commit` the merge and move on. After a sync, check that the fork's `provider` branch
in `weather.rs` still compiles against upstream's weather changes — the Rust tests in
`fork/weather_metno.rs` and `weather.rs` cover the contract.

## Publishing the fork

`git push origin main` publishes to `github.com/ixoid/widgetsack` (a backup and the place CI
runs). Nothing is ever pushed to upstream.
