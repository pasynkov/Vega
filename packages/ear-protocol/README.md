# @vega/ear-protocol

Shared WebSocket protocol between any Vega Ear client and Vega Core.

The TypeScript schema lives in `src/`. The Swift mirror lives in `swift/` as a local Swift Package. Fixtures in `fixtures/examples.json` are exercised by both round-trip test suites to enforce that the two representations agree on every wire field.

See `openspec/specs/ear-protocol/spec.md` for the normative requirements.

## Message catalog (current additions)

- `overlay_update` message added (Core → Ear). Fields: `type`, `seq` (positive int, monotonic per device per connection), `state: { kind, hint?, caption?, sound? }`. Drives the interactive overlay (visual state + optional cue sound, atomically). **BREAKING (2026-06-18)** — replaces the removed `play_cue` message; the `wake` cue stays local-only on the Ear and never appears in `state.sound`. The `kind` enum includes `view` for the "I'm presenting a list" orb state (see `list_view_update`).
- `list_view_update` message added (Core → Ear). Fields: `type`, `seq` (positive int, monotonic per device per connection on its own channel), `view: { title?, items: [{ id, label, done }], open }`. Drives a generic vertical list surface rendered below the orb (shopping, todo, recipes, …). `done` items render struck-through; `open: false` collapses the surface.
- `session_mode` message added (Core → Ear). Fields: `type`, `sessionId`, `mode` ∈ {`regular`, `continuous`}. Drives the long-form dictation / no-VAD-endpoint mode.
- The Swift decoder tolerates unknown `overlay_update.state.kind` / `.sound` and `session_mode.mode` values and surfaces them as `.unknownOverlay` / `.unknownSessionMode` so a newer Core never breaks an older Ear binary.

## TypeScript

```bash
npm run build -w @vega/ear-protocol
npm run test  -w @vega/ear-protocol
```

## Swift

```bash
cd packages/ear-protocol/swift
swift test
```
