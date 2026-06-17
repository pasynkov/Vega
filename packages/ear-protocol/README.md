# @vega/ear-protocol

Shared WebSocket protocol between any Vega Ear client and Vega Core.

The TypeScript schema lives in `src/`. The Swift mirror lives in `swift/` as a local Swift Package. Fixtures in `fixtures/examples.json` are exercised by both round-trip test suites to enforce that the two representations agree on every wire field.

See `openspec/specs/ear-protocol/spec.md` for the normative requirements.

## Message catalog (current additions)

- `play_cue.cue` enum gained `ack_done`, `ack_continue`, `ack_thinking`, `ack_success`, `ack_error`. Only `ack_done` (Tink.aiff) and `ack_continue` (Submarine.aiff) have Ear-side handler wiring today; the rest are reserved for future tools.
- `session_mode` message added (Core → Ear). Fields: `type`, `sessionId`, `mode` ∈ {`regular`, `long_note`}. Drives the long-note dictation mode.
- The Swift decoder tolerates unknown `cue` and `mode` values and surfaces them as `.unknownCue` / `.unknownSessionMode` so a newer Core never breaks an older Ear binary.

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
