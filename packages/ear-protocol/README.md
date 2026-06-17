# @vega/ear-protocol

Shared WebSocket protocol between any Vega Ear client and Vega Core.

The TypeScript schema lives in `src/`. The Swift mirror lives in `swift/` as a local Swift Package. Fixtures in `fixtures/examples.json` are exercised by both round-trip test suites to enforce that the two representations agree on every wire field.

See `openspec/changes/mac-listener-mvp/specs/ear-protocol/spec.md` for the normative requirements.

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
