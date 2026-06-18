# @vega/ear-protocol

Shared socket.io event catalog and payload schemas between any Vega Ear client and Vega Core.

The TypeScript schemas live in `src/`. The Swift mirror lives in `swift/` as a local Swift Package. Fixtures in `fixtures/examples.json` are exercised by both round-trip test suites to enforce that the two representations agree on every event payload.

See `openspec/specs/ear-protocol/spec.md` for the normative requirements.

## Event catalog (current)

Wire is socket.io — each message is its own event with its own payload schema. The event name is the discriminator; payloads no longer carry a `type` literal.

- **Ear → Core**: `register`, `wake_detected`, `session_start`, `audio_frame` (binary attachment + `sessionId` text arg), `session_end`.
- **Core → Ear**: `ack`, `wake_ack`, `partial_transcript`, `final_transcript`, `overlay_update` (orb state + optional cue sound), `list_view_update` (generic vertical list surface), `session_mode`, `arm_capture`, `session_end`, `exception` (gateway-level error).

The `overlay_update.state.kind` enum is `idle | listening | capturing | thinking | processing | success | error | view`. The `view` kind pairs with an open `list_view_update {open: true}` surface.

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
