## Why

The Ear ↔ Core wire today is raw `ws` (the `ws` npm package on the backend, `URLSessionWebSocketTask` on mac-ear). Everything works, but we want **domain rooms** next (continuous shopping-room, todo-room, etc.) and rolling our own room state on top of raw `ws` is more code than it's worth. socket.io ships rooms, namespaces, ack semantics, declarative gateway decorators, and built-in reconnect — and we already have a proven socket.io NestJS pattern in `balancy-backend/apps/edge/gateway` to copy.

This change is **infrastructure only**: move both sides of the wire to socket.io with full feature parity. No business-logic changes, no rooms, no domain refactors. The next change consumes the new platform for shopping-room.

## What Changes

- **BREAKING (internal protocol)**: the wire moves from raw `ws` text/binary frames to socket.io events.
  - Each existing message type becomes its own socket.io event with the same payload (e.g. `overlay_update`, `list_view_update`, `wake_detected`, `audio_frame`).
  - The discriminated-union `CoreToEarMessageSchema` / `EarToCoreMessageSchema` go away; each event gets its own Zod schema and DTO.
  - `audio_frame` no longer carries an 8-byte session-id header — it becomes `socket.emit("audio_frame", sessionId, buffer)` and socket.io ships the buffer as a binary attachment.
  - `binary-frame.ts` (encode/decode + short-id helpers) is removed.
- Backend `EarGateway` becomes a NestJS `@WebSocketGateway({namespace: "/ear", transports: ["websocket"]})` with `@SubscribeMessage` handlers per inbound event. Adoption mirrors `balancy-backend/apps/edge/gateway`.
- A custom `EarIoAdapter extends IoAdapter` sets server-level options (ping interval/timeout, custom id generation) — analogue of balancy's `ApplicationAdapter`.
- `EarRegistry` stores socket.io `Socket` instances (typed via `socket.data`) instead of `ws.WebSocket`.
- All outbound emit paths (`OverlayService`, `ListViewService`, `SessionService.sendToEar`, `EarSessionRouter.arm`) switch from `socket.send(JSON.stringify(...))` to `socket.emit(event, payload)`.
- mac-ear adopts `socket-io-client-swift` (~v16). `EarSocket` is rewritten on top of `SocketManager` + `Socket`; the per-event `socket.on(...)` handlers replace the discriminated-union `dispatch(data)` switch. The custom backoff/reconnect logic in `EarSocket.swift` is dropped — socket.io-client-swift's built-in reconnect is configured to match the existing 1 s → 30 s ± 25 % jitter behaviour.
- DeepgramClient is **untouched** — it speaks its own `ws` connection to Deepgram's API.
- The ear-protocol package bumps to the major version it's earned: a new top-level `EventName` enum, per-event Zod schemas, per-event Swift Codable structs, fixtures and round-trip tests rebuilt around the per-event shape.
- No domain code (notes, shopping, supervisor, kernel tools) changes behaviour. Only the wire adapter layer underneath them flips.

## Capabilities

### New Capabilities
- `websocket-platform`: the socket.io-based wire between Vega Core and Ear clients — namespace, adapter, gateway pattern, event catalog, ack/reconnect semantics, validation pipeline. This capability owns the platform contract; per-event payload semantics keep living in `ear-protocol`.

### Modified Capabilities
- `ear-protocol`: messages become events on a socket.io connection. The discriminated unions are replaced by an `EventName` enum + per-event Zod schemas. `audio_frame` no longer carries an 8-byte header; the binary buffer is shipped as a socket.io binary attachment alongside a `sessionId` text arg. `binary-frame.ts` is removed.
- `mac-ear`: the WebSocket layer (`EarSocket.swift`) switches to `socket-io-client-swift`; per-event `socket.on(...)` handlers replace the dispatch switch; the custom reconnect/backoff is replaced by the library's built-in policy configured to match the prior behaviour.
- `vega-core`: NestJS gateway pattern moves to `@nestjs/platform-socket.io` + `@nestjs/websockets` decorators (`@WebSocketGateway`, `@SubscribeMessage`). A custom `EarIoAdapter` extends `IoAdapter` for server-level options. Service-level emit paths (`OverlayService`, `ListViewService`, `SessionService`, `EarSessionRouter`) shift from `socket.send(JSON.stringify(...))` to `socket.emit(event, payload)`.

## Impact

- `packages/ear-protocol`: schema rewrite (per-event), Swift mirror rewrite (per-event Codable), `binary-frame.ts` deleted, fixtures + round-trip tests rebuilt, README updated, version bump.
- `apps/core`:
  - `package.json`: drop `ws` runtime dep (keep as transitive for Deepgram client only, which still imports `ws` directly); add `socket.io`, `socket.io-adapter`, `@nestjs/websockets`, `@nestjs/platform-socket.io`.
  - `main.ts`: `app.useWebSocketAdapter(new EarIoAdapter(app))`.
  - `apps/core/src/conversation/ear/`: `ear.gateway.ts` rewritten with decorators; `ear.io-adapter.ts` new; `ear.registry.ts` typed for socket.io Socket; emit helpers updated.
  - `apps/core/src/conversation/overlay/` (Overlay + ListView): sender callbacks now expect a socket.io `Socket` reference (or the gateway exposes a `emitTo(deviceId, event, payload)` helper they call into).
  - `apps/core/src/conversation/sessions/ear-session-router.service.ts`: `arm_capture` emitted via `socket.emit("arm_capture", ...)`.
  - `apps/core/src/conversation/ear/session/session.service.ts`: every `sendToEar` call site replaced with the event-shaped emit.
  - Tests (`apps/core/tests/`): mocks updated; integration tests use `socket.io-client` to drive an in-process `socket.io` server.
- `apps/mac-ear`:
  - `Package.swift`: add `socket-io-client-swift` (~v16).
  - `Sources/VegaEar/EarSocket.swift`: rewritten on `SocketManager` + `Socket`.
  - `Sources/VegaEar/SessionCoordinator.swift`: dispatch switch is gone; replace with per-event handlers wired during `EarSocket` setup.
  - `AudioFrame.swift` helpers removed (no header).
  - `swift test` updated; new fixtures for per-event payloads.
- No bump to mac-ear distribution; users keep using the same app, but it ships against the new protocol.
- No backwards compatibility: protocol is internal; backend and mac-ear ship together.
