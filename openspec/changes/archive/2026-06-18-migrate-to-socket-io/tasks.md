## 1. ear-protocol package: per-event schemas

- [x] 1.1 Add `EventName` enum to `packages/ear-protocol/src/schema.ts` listing every event name (`register`, `wake_detected`, `session_start`, `audio_frame`, `session_end`, `ack`, `wake_ack`, `partial_transcript`, `final_transcript`, `overlay_update`, `list_view_update`, `session_mode`, `arm_capture`, `core_session_end`)
- [x] 1.2 Keep the existing per-event payload Zod schemas (already factored: `RegisterMessageSchema`, `WakeDetectedMessageSchema`, `SessionStartMessageSchema`, `EarSessionEndMessageSchema`, `AckMessageSchema`, `WakeAckMessageSchema`, `PartialTranscriptMessageSchema`, `FinalTranscriptMessageSchema`, `OverlayUpdateMessageSchema`, `ListViewUpdateMessageSchema`, `SessionModeChangeMessageSchema`, `ArmCaptureMessageSchema`, `CoreSessionEndMessageSchema`) but drop the `type: z.literal(...)` discriminator from each (the event name is the discriminator now)
- [x] 1.3 Delete `EarToCoreMessageSchema` and `CoreToEarMessageSchema` discriminated unions; export the per-event schemas individually
- [x] 1.4 Delete `packages/ear-protocol/src/binary-frame.ts` entirely; drop the export from `index.ts`
- [x] 1.5 Update Swift mirror: per-event Codable structs (the existing ones are already mostly per-event — just drop the `type` literal property and the `CoreToEarMessage` enum); add a `EventName` Swift enum (or constants)
- [x] 1.6 Delete `AudioFrame` Swift namespace (`headerSize`, `sessionShortId`, `encode`, `decode`) and the matching binary tests
- [x] 1.7 Rewrite `fixtures/examples.json` so each entry is a single event payload (not a wrapped message with a `type` field); copy to `swift/Tests/EarProtocolTests/Fixtures/examples.json`
- [x] 1.8 Rewrite `tests/round-trip.test.ts`: one test per event-payload schema. Add validation tests where they apply (bounds, enum membership)
- [x] 1.9 Rewrite `swift/Tests/EarProtocolTests/RoundTripTests.swift`: per-event encode/decode round trips
- [x] 1.10 Update `packages/ear-protocol/README.md` to describe the socket.io event model
- [x] 1.11 Bump `packages/ear-protocol/package.json` major version
- [x] 1.12 `npm run build -w @vega/ear-protocol` + `cd packages/ear-protocol && npx vitest run` — green
- [x] 1.13 `cd packages/ear-protocol/swift && swift test` — green

## 2. Core: install socket.io stack + EarIoAdapter

- [x] 2.1 `npm i socket.io socket.io-adapter @nestjs/websockets @nestjs/platform-socket.io -w @vega/core`
- [x] 2.2 `apps/core/src/conversation/ear/ear.io-adapter.ts`: `EarIoAdapter extends IoAdapter` with overridden `createIOServer(port, opts)` — set `pingInterval`, `pingTimeout`, a `server.use((socket, next) => { socket.id = ulid(); next(); })` middleware. Keep memory adapter for now
- [x] 2.3 `apps/core/src/main.ts`: replace any existing `useWebSocketAdapter` call (or add one) with `app.useWebSocketAdapter(new EarIoAdapter(app))`
- [x] 2.4 Add `ulid` to deps if not already present (used for socket id generation)

## 3. Core: rewrite EarGateway with decorators

- [x] 3.1 `apps/core/src/conversation/ear/ear.gateway.ts`: switch class to `@WebSocketGateway({namespace: "/ear", transports: ["websocket"]})`; remove `WebSocketServer` from `ws` import; remove `start()` / `stop()` lifecycle methods that managed the raw `WebSocketServer`
- [x] 3.2 Inject `@WebSocketServer() server: Server` (`from 'socket.io'`)
- [x] 3.3 Implement `OnGatewayInit` to log readiness + run any one-time setup (e.g. seed `server.use` middleware if needed)
- [x] 3.4 Implement `OnGatewayConnection(socket)` — establish the bind handlers for overlay/listView for this device; (initial `bindDevice` calls happen on `register` not on `connect` because we need the `deviceId` first)
- [x] 3.5 Implement `OnGatewayDisconnect(socket)` — unbind overlay/listView, run `sessions.handleDisconnect`, `registry.unregister`
- [x] 3.6 `@SubscribeMessage("register")` handler: validate `RegisterMessage` DTO, register in registry, bind overlay + listView for this device, emit `ack` back to the socket
- [x] 3.7 `@SubscribeMessage("wake_detected")` handler: validate DTO, run wake policy, emit `wake_ack` back. On `proceed`: close list view (silentOverlay), paint overlay listening
- [x] 3.8 `@SubscribeMessage("session_start")` handler: validate, call `sessions.start(connection, message)`
- [x] 3.9 `@SubscribeMessage("session_end")` handler: validate, call `sessions.endFromEar(connection, message)`
- [x] 3.10 `@SubscribeMessage("audio_frame")` handler: signature `(sessionId: string, buffer: Buffer)` — call `sessions.forwardAudio(connection, sessionId, buffer)`; drop the old binary-frame decode path
- [x] 3.11 Add `ValidationPipe` (`@UsePipes(new ValidationPipe(...))`) at the gateway class level
- [x] 3.12 Add `ExceptionsFilter` at the gateway class level — convert thrown errors into an `exception` event back to the socket without disconnecting
- [x] 3.13 Throughput log stays at debug level (already debug-only after the overlay change)
- [x] 3.14 Expose `emitTo(deviceId: string, event: string, ...args: unknown[]): boolean` on the gateway. Pulls the socket from registry, calls `socket.emit`. Returns false if no socket
- [x] 3.15 Export the gateway helper through a token so non-gateway code can inject it

## 4. Core: EarRegistry switches to socket.io Socket

- [x] 4.1 `apps/core/src/conversation/ear/ear.registry.ts`: `EarConnection.socket: Socket` (from `socket.io`) instead of `ws.WebSocket`
- [x] 4.2 `register(socket, message)` — same logic but on the new socket type; the "supersede" path calls `socket.disconnect(true)` on the prior socket instead of `socket.close(...)`
- [x] 4.3 Drop the `activeSessionShortId: bigint` field and `sessionShortIdFromUuid` usage — no longer needed because audio frames carry the sessionId text arg directly
- [x] 4.4 Update `setActiveSession(deviceId, sessionId | null)` to only set `activeSessionId`

## 5. Core: services switch to emit helper

- [x] 5.1 `apps/core/src/conversation/overlay/overlay.service.ts`: `Sender = (event: string, payload: unknown) => void` — handlers call `send("overlay_update", message)` instead of `send(message)`. Update tests + bindings
- [x] 5.2 `apps/core/src/conversation/overlay/list-view.service.ts`: same change — `send("list_view_update", message)`
- [x] 5.3 `apps/core/src/conversation/ear/session/session.service.ts`: replace every `sendToEar(session, message)` with `emitTo(session.deviceId, eventName, payload)` calls; or refactor `sendToEar` to take `(session, eventName, payload)` and emit through the registry-resolved socket
- [x] 5.4 `apps/core/src/conversation/sessions/ear-session-router.service.ts`: `arm_capture` emit via `emitTo(deviceId, "arm_capture", {mode})`
- [x] 5.5 `apps/core/src/conversation/ear/ear.gateway.ts`: `register` handler binds overlay/listView with the per-event emit shape (`(event, payload) => socket.emit(event, payload)`)
- [x] 5.6 Update unit tests to mock the new sender signature

## 6. Core: integration tests with in-process socket.io

- [x] 6.1 Add `socket.io-client` as a devDep
- [x] 6.2 New helper `tests/helpers/ear-test-client.ts`: spins up the gateway against an ephemeral port + creates a connected client; returns `{client, gatewayServer, registry, ...}` for tests
- [x] 6.3 Adapt existing tests that mock `ws.WebSocket` (e.g. `arm-flow.test.ts`, `integration.test.ts`, `full-flow.test.ts`, `session-service.test.ts`) to use the new emit-callback shape
- [x] 6.4 Add a smoke integration test: register → wake_detected → wake_ack → session_start → audio_frame → final_transcript → session_end; assert events on both sides
- [x] 6.5 `npm test -w @vega/core` — green

## 7. mac-ear: add socket-io-client-swift

- [x] 7.1 `apps/mac-ear/Package.swift`: add the swift-socket-io dependency (`https://github.com/socketio/socket.io-client-swift`, pinned to a known minor, e.g. `~> 16.1`)
- [x] 7.2 `swift package resolve` — green

## 8. mac-ear: rewrite EarSocket

- [x] 8.1 `apps/mac-ear/Sources/VegaEar/EarSocket.swift`: replace `URLSessionWebSocketTask` with `SocketManager` + `Socket`. URL pointing at the host without `/ear` path; configure `nsp: "/ear"`
- [x] 8.2 Configure reconnect via `SocketIOClientConfiguration`: `.reconnects(true)`, `.reconnectAttempts(-1)` (infinite), `.reconnectWait(1)`, `.reconnectWaitMax(30)`, `.randomizationFactor(0.25)` — matches the legacy ±25% jitter
- [x] 8.3 Reset the reconnect-delay counter only after `ack` arrives (custom flag; the lib doesn't know about our app-level handshake)
- [x] 8.4 Replace the `dispatch(data:)` switch with per-event `socket.on("overlay_update") { ... }`, `socket.on("list_view_update") { ... }`, `socket.on("wake_ack") { ... }`, `socket.on("partial_transcript") { ... }`, `socket.on("final_transcript") { ... }`, `socket.on("session_end") { ... }`, `socket.on("session_mode") { ... }`, `socket.on("arm_capture") { ... }`, `socket.on("ack") { ... }`, `socket.on("exception") { ... }`
- [x] 8.5 Each handler decodes its payload through `JSONDecoder` against the per-event Codable struct
- [x] 8.6 Tolerance branches for unknown overlay kind/sound stay (they live inside `OverlayUpdateMessage` decoding now)
- [x] 8.7 `connect()` / `disconnect()` map to `manager.connect()` / `manager.disconnect()`; `socket.on(clientEvent: .connect) { ... }` triggers the `register` emit
- [x] 8.8 Replace `sendJSON(_:)` with `socket.emit("event_name", payload)` — accept a payload that can be encoded into `SocketData`-compatible form (Codable → `Data` via `JSONEncoder` → cast to `[String: Any]` is the typical pattern, or define `convertible: SocketData` helpers)
- [x] 8.9 Replace `sendAudio(sessionId:opusFrame:)` with `socket.emit("audio_frame", sessionId, pcmData)` — socket.io-client-swift accepts `Data` as a binary attachment argument
- [x] 8.10 Drop the entire `scheduleReconnect` / `openTask` / `listen(_:)` loop and `reconnectDelay` state — socket.io manages it now

## 9. mac-ear: SessionCoordinator + supporting files

- [x] 9.1 `apps/mac-ear/Sources/VegaEar/SessionCoordinator.swift`: replace `socket.onMessage = ...` with the per-event registration set up inside `EarSocket`
- [x] 9.2 Wire each per-event handler from `EarSocket` back to `SessionCoordinator` via closures (`onOverlayUpdate`, `onListViewUpdate`, …) or pass `SessionCoordinator` to `EarSocket` and have it call into it directly
- [x] 9.3 `handleArmCapture(mode:)` stays — driven by the `arm_capture` event handler
- [x] 9.4 `handleCoreMessage(_:)` switch is gone; per-event handlers replace it
- [x] 9.5 `audio_frame` emit path: `socket.emit("audio_frame", sessionId, pcm)`; drop `AudioFrame.encode` callers
- [x] 9.6 `AppDelegate.swift`: the `EarSocket` constructor signature changes — adapt the call site
- [x] 9.7 Audit any remaining `Codable` work where we previously decoded `EarProtocol.decodeCoreToEar(data)` — replace with per-event `JSONDecoder().decode(...)` against the specific struct
- [x] 9.8 `swift build` — green

## 10. Manual + cross-cutting

- [x] 10.1 Grep the repo for `ws.WebSocket`, `WebSocketServer`, `sessionShortIdFromUuid`, `encodeAudioFrame`, `decodeAudioFrame`, `binary-frame` references — remove
- [x] 10.2 Update `apps/core/package.json` to drop `ws` from `dependencies` if it's no longer needed transitively (DeepgramClient still imports `ws` directly — keep)
- [x] 10.3 Update `apps/core/CLAUDE.md` (if exists) or any developer notes that reference the prior wire pattern
- [x] 10.4 End-to-end smoke on macOS: short save → notes flow; continuous notes dictation → finalize; shopping add/mark/delete/clear; show_list → list view; close_list_view; disconnect Core, reconnect, verify register re-fires + state recovers as expected
- [x] 10.5 `openspec validate migrate-to-socket-io --type change --strict` — passes
- [x] 10.6 `npm test -w @vega/core` — green; `cd packages/ear-protocol && npx vitest run` — green; `cd packages/ear-protocol/swift && swift test` — green; `cd apps/mac-ear && swift build` — green
