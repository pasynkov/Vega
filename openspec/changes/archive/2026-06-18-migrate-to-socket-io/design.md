## Context

The Ear ↔ Core wire today is raw `ws` (`ws` npm package on Core, `URLSessionWebSocketTask` on mac-ear). The Core side ships a hand-rolled `EarGateway` (manual `WebSocketServer` construction + per-message `switch` on a discriminated union) and a manual binary framing helper (`packages/ear-protocol/src/binary-frame.ts`) that prepends an 8-byte little-endian short-id header to every audio frame. mac-ear runs its own backoff loop in `EarSocket.swift` and decodes events through a single `dispatch(data)` `switch`.

Everything works, but the next planned feature — domain rooms (continuous shopping-room, todo-room, …) — wants the kind of state-tracking that socket.io rooms give for free. Rolling that on top of raw `ws` is more code than it's worth.

The user already shipped a clean socket.io NestJS pattern in `balancy-backend/apps/edge/gateway` and explicitly asked to copy it. This change adopts that pattern with feature parity. No business logic. No rooms. The next change consumes the new platform.

## Goals / Non-Goals

**Goals:**
- Drop-in replacement of the raw-`ws` transport with socket.io on both ends.
- Adopt `@nestjs/platform-socket.io` + `@nestjs/websockets` on Core; `@WebSocketGateway` + `@SubscribeMessage` for inbound events; `@WebSocketServer` for outbound emit.
- A custom `EarIoAdapter extends IoAdapter` analogous to balancy's `ApplicationAdapter`.
- A `socket-io-client-swift` (~v16) replacement of `EarSocket.swift` on mac-ear with built-in reconnect matching the prior backoff.
- Rewrite the `ear-protocol` package around per-event Zod schemas + Swift Codable structs (no more discriminated union); drop `binary-frame.ts`; bump major version.
- Feature parity: overlay, list view, sessions, audio frames, wake flow, partial / final transcripts, arm_capture, all session_end paths.

**Non-Goals:**
- Rooms / namespace fan-out — added in the follow-up `shopping-room` change.
- Acknowledgment semantics on outbound events — added if/when we actually need delivery guarantees.
- Redis adapter / clustering — single-process is enough for the user's setup.
- Long-polling fallback — TLS WebSocket works fine on loopback.
- Auth / authorization on connect — single-user single-machine.
- DeepgramClient (still talks `ws` directly to Deepgram's API). Untouched.
- Migration tooling for past recordings — none needed; sqlite schemas don't change.

## Decisions

### Decision 1: NestJS adapter pattern, copy balancy

`@nestjs/platform-socket.io` over rolling our own integration with raw `socket.io`. Why:

- The balancy gateway is a proven, idiomatic NestJS-socket.io codebase. Copying it gets us:
  - `@WebSocketGateway` + `@SubscribeMessage` + `@WebSocketServer` decorators, with class-validator validation pipe + exception filter.
  - `ApplicationAdapter extends IoAdapter` for server-level options (pings, custom id generation, custom room adapter factory).
- Alternative considered: instantiate `socket.io` directly inside our existing `EarGateway` and skip the NestJS decorators. Rejected — we want the same wiring style as balancy so a future second backend engineer is at home immediately, and we want the validation pipeline (DTO + class-validator) wired through the same `ValidationPipe` we already use for tool DTOs.

### Decision 2: Per-event Zod schemas instead of a discriminated union

Drop `CoreToEarMessageSchema` / `EarToCoreMessageSchema`. Each event becomes its own exported Zod schema and Swift struct. Why:

- socket.io's discriminator is the event name on the wire — re-discriminating in a Zod union is redundant and forces a `switch` on the consumer side.
- Per-event schemas read cleanly at the handler level: `@SubscribeMessage("wake_detected")` receives `@MessageBody() body: WakeDetectedDto` and the validation pipe rejects malformed payloads automatically.
- Round-trip tests stay simple: one fixture per event, validate through the per-event schema.
- Forward compat: adding a new event is `+1 schema export`, not "extend the union, regen the discriminator, update both decoders".

### Decision 3: Drop `binary-frame.ts` and the 8-byte session-id header

`audio_frame` becomes `socket.emit("audio_frame", sessionId, buffer)`. socket.io ships the buffer as a binary attachment alongside the `sessionId` text arg. Why:

- The 8-byte header was a workaround for raw-`ws`'s flat-bytes-per-frame model — we needed a way to tag which session a buffer belonged to. socket.io gives us multi-arg events; we no longer need the workaround.
- Throughput cost: socket.io's binary attachment framing adds a small number of bytes per event. At our ~94 KB/s rate the overhead is < 5 KB/s — negligible.
- Win: `binary-frame.ts` (+ matching Swift `AudioFrame.swift`) goes away on both sides. Less code, less risk, no parallel decoders.

### Decision 4: socket.io-client-swift built-in reconnect replaces our custom backoff

`socket-io-client-swift` configures reconnect through `reconnectAttempts`, `reconnectWait`, `reconnectWaitMax`, `randomizationFactor`. Match our existing 1 s → 30 s ±25 % jitter directly via library options. Reset the counter on `ack` (post-register), not on `connect` — same invariant we have today.

Why drop our own loop:
- Less custom code in Swift land. 50-ish lines of backoff/jitter logic go away.
- socket.io-client-swift handles `connect` / `disconnect` / `reconnect` events idiomatically; the status item maps cleanly to its connection state machine.

Alternative considered: keep our backoff, disable the library's internal reconnect. Rejected — duplicating the library's job for no benefit.

### Decision 5: No rooms / no `io.to(deviceId)` in this change

Outbound emit stays per-socket via `socket.emit(event, payload)` (with the socket pulled from `EarRegistry`). Why:

- The MVP has one Ear per user; we don't gain anything from `io.to(room)` until we have a use case (which the next change introduces).
- Skipping rooms keeps the migration narrow: change the transport, don't change the addressing model.
- When the shopping-room change lands, we just call `socket.join(roomName)` from the appropriate service and switch the outbound path; the wire already supports it.

### Decision 6: A small `EarEmitter` helper instead of leaking sockets

Service code (`OverlayService`, `ListViewService`, `SessionService`, `EarSessionRouter`) today holds a `Sender` callback that takes a JSON message. After migration it holds an `Emit` callback: `(event: string, payload: unknown) => void`. The gateway exposes a single `emitTo(deviceId, event, payload)` helper that resolves the socket from the registry and emits. Services never touch the socket directly.

Why an extra helper layer:
- Same shape as today (services have callbacks, not sockets).
- The helper is the single place where we'd later add `io.to(deviceId).emit(...)` once we move addressing into rooms.
- Test mocking stays trivial — replace the emit fn.

### Decision 7: Validation pipe + exception filter; no AckInterceptor for now

Inbound `@SubscribeMessage` handlers run through `ValidationPipe` + class-validator DTOs (the same pattern our tool DTOs already use). A gateway-level `ExceptionsFilter` converts throws into a structured `exception` event without disconnecting. We skip `AlwaysAckInterceptor` from balancy for now — none of our outbound flows currently expect an ack callback; adding it later if we ever do is one decorator + one interceptor.

### Decision 8: No protocol-level compat shim

The protocol is internal. Backend + mac-ear ship together. We don't keep a parallel raw-`ws` listener "for older Ear binaries" — there are none in the wild. The major-version bump on `@vega/ear-protocol` is symbolic.

## Risks / Trade-offs

- **mac-ear depends on a new third-party Swift library (`socket-io-client-swift`).** Mitigation: socket.io-client-swift is the de-facto Swift socket.io client, maintained, MIT-licensed. Drop-in for our use. Pin to a known-good minor version.
- **Migration is wide — touches gateway, registry, every service that emits, ear-protocol shape, mac-ear network layer.** Mitigation: cut the migration in clear groups (`platform` → `ear-protocol` → `mac-ear` → `services emit paths` → `tests`) and keep the end-to-end smoke until the whole stack is on socket.io.
- **Binary attachment overhead on audio_frame.** Mitigation: measured order-of-magnitude is < 5 KB/s at 94 KB/s baseline; acceptable. If we see real regression we can switch to a manual buffer batching strategy later.
- **socket.io's framing changes the on-wire shape entirely.** A user running the prior mac-ear against the new Core (or vice versa) will fail handshake. Mitigation: protocol is internal, both sides ship together; no real risk.
- **socket.io-client-swift on macOS uses its own queues / threads.** Mitigation: existing `SessionCoordinator.serial` queue stays; `socket.on(...)` callbacks `serial.async { ... }` to keep the existing concurrency model.
- **Reconnect semantics shift slightly.** socket.io may emit `disconnect`/`reconnect` events on transient network blips that our hand-rolled loop didn't surface. Mitigation: keep `EarRegistry`'s "register supersedes" logic on the new socket — the second `register` cleanly replaces the first regardless of how many transport-level blips happened.

## Migration Plan

1. `@vega/ear-protocol`: per-event Zod schemas + per-event Swift Codable structs. Drop `binary-frame.ts`. New fixture per event, round-trip tests rebuilt. Major version bump. Both TS and Swift test suites green.
2. Backend platform: install `socket.io`, `socket.io-adapter`, `@nestjs/websockets`, `@nestjs/platform-socket.io`. Build `EarIoAdapter`. Rewrite `EarGateway` with decorators. New `EarRegistry` socket type. `emitTo(deviceId, event, payload)` helper.
3. Backend services: every `sendToEar(session, msg)` / `socket.send(JSON.stringify(...))` site swaps to `emitTo(deviceId, event, payload)`. Overlay, ListView, SessionService, EarSessionRouter.
4. mac-ear: add `socket-io-client-swift` Swift package dependency, rewrite `EarSocket.swift` on `SocketManager` + `Socket`, per-event `socket.on(...)`, drop custom backoff, drop `AudioFrame.encode/decode/headerSize`. Adapt `SessionCoordinator` per-event handlers + `socket.emit("audio_frame", sessionId, pcm)`.
5. Tests: vitest mocks updated; new in-process integration test using `socket.io-client` against the in-process server. Swift `swift test` green.
6. End-to-end smoke: wake → command → notes / shopping round-trip; long-form notes session; list-view show/refresh/close; arm_capture; disconnect/reconnect from Core restart.
7. Spec sync + archive. No rollback shim.
