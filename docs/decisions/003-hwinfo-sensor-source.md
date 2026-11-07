# ADR-003: HWiNFO as the hardware-sensor source (shared memory + registry gadget)

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** owner (HWiNFO over any other monitor — it already runs for Rainmeter); architect (two read-only interfaces behind one catalog)

## Context
On Windows `sysinfo` has no CPU temperature, and `CallNtPowerInformation` (today's `cpu.freq.current`)
reports a nominal clock that never moves on the owner's Ryzen 9 9950X3D. HWiNFO64 already runs on the
machine for the Rainmeter skins. HWiNFO publishes sensor data through two interfaces:

1. **Shared memory** `Global\HWiNFO_SENS_SM2` (the SDK / Rainmeter-plugin layout): every reading
   HWiNFO has, with stable ids, units and min/max/avg. Must be switched on in HWiNFO (*Settings →
   Shared Memory Support*); the free edition disables it 12 h after launch, Pro has no limit.
2. **Registry gadget** `HKCU\Software\HWiNFO64\VSB` (*Settings → Gadget/VSB reporting*): only the
   readings the user ticked in the Sensors window, as `Sensor<n>` / `Label<n>` / `Value<n>` /
   `ValueRaw<n>` string values. No time limit. Measured on the owner's machine 2026-11-07: this one
   is **on** with 10 readings (Core Clocks, CPU (Tctl/Tdie), CPU Package Power, six GPU values) and
   shared memory is **off**.

Constraints: read-only, no network, no child process; new code under `widgetsack/src/fork/` and
`client/src/lib/widgets/fork/`; one line per registration point in core files.

## Options considered
1. **Shared memory only** (the roadmap wording) — richest data; on this machine it shows "—" until the
   owner flips a HWiNFO setting, and goes dark 12 h after every HWiNFO launch on the free edition.
2. **Registry gadget only** — works today with zero setup; catalog limited to what the user ticked in
   HWiNFO; values arrive as strings (`ValueRaw` is a plain decimal, so parsing is trivial).
3. **Both, shared memory preferred** — one catalog shape, the pane says which interface is live and
   how to enable the other; the well-known CPU ids are derived from HWiNFO *labels*, identical in both.
4. **LibreHardwareMonitor / OpenHardwareMonitor** — a second monitor process (and a driver) next to
   HWiNFO; rejected by the owner's existing setup.

## Decision
Option 3. `widgetsack/src/fork/hwinfo/`:
- `model.rs` — pure: `Reading { slug, label, sensor, unit, kind, value }`, `slugify` + collision
  suffixing, `well_known_samples` (label heuristics: `CPU (Tctl/Tdie)` → `hw.cpu.temp`, …),
  `catalog`, config clamps. Unit-tested without Windows.
- `shared_mem.rs` — pure `parse_snapshot(&[u8])` over the SDK layout (header 44 bytes, `#pragma
  pack(1)`, signature `HWiS`, offsets/sizes/counts from the header, every access bounds-checked, counts
  capped at 4096 sensors / 16384 readings); Win32 edge (`OpenFileMappingW` / `MapViewOfFile` /
  `VirtualQuery`, all `FILE_MAP_READ`) behind `cfg(windows)`. Adds the `Win32_System_Memory` feature.
- `registry.rs` — pure `parse_entries(&[(name, value)])` for the VSB key; `winreg` (already a
  dependency) edge with `KEY_READ`.
- `mod.rs` — `HwinfoState` (IntegrationTask + SampleCache), config `plugins/hwinfo.json`
  (`{ pollSeconds 1..=60, default 2; enabled: [slug] }`), demand-gated loop on the `hw.` prefix,
  the four commands, `prime_window`.
- Sensor ids: `hw.status`, `hw.cpu.temp`, `hw.cpu.clock.max`, `hw.cpu.clock.core.<n>`, `hw.cpu.power`,
  `hw.<slug>`. Slugs come from the HWiNFO label (`cpu-package-power`); a label that repeats across
  sensors gets the sensor's short name appended, so ids stay stable and unique.
- Client plugin `client/src/lib/widgets/fork/hwinfo/` (settings pane, source with catalog, typed
  command adapter); registered from one `BUILTINS` line.

## Consequences
- **Positive:** works on the owner's machine with no manual step; the full catalog is one HWiNFO
  checkbox away; no new crate; no network; the demand gate keeps it free until an `hw.*` widget is
  mounted.
- **Negative / trade-offs:** two parsers to maintain; the registry path only sees what the user ticked
  in HWiNFO (the pane says so); HWiNFO labels are English-only heuristics for the well-known ids — a
  renamed reading (user label) still works for the catalog but may drop out of `hw.cpu.*`.
- **Follow-ups:** GPU well-known ids (`hw.gpu.*`) if the owner wants them beside NVML; per-reading
  min/max/avg from shared memory; a Pro-edition note in README-fork.
