## MODIFIED Requirements

### Requirement: Local WebSocket server for Ear clients

Core SHALL expose a socket.io server on `127.0.0.1:7777` with a single namespace `/ear` configured for WebSocket transport only (no long-polling fallback). All Ear clients SHALL connect through the socket.io adapter implementation; raw `ws.WebSocket` clients SHALL NOT be supported.

The endpoint SHALL bind to loopback only by default and SHALL NOT listen on any non-loopback interface unless explicitly configured to do so in a future change. Core SHALL accept multiple concurrent Ear connections; in the MVP only one is exercised.

The implementation SHALL adopt `@nestjs/platform-socket.io` + `@nestjs/websockets` and register a custom `EarIoAdapter extends IoAdapter` via `app.useWebSocketAdapter(...)` at boot. The legacy `ws.WebSocketServer` instantiation inside `EarGateway` SHALL be removed.

`EarGateway` SHALL declare `@WebSocketGateway({namespace: "/ear", transports: ["websocket"]})` and SHALL expose `@SubscribeMessage` handlers for every inbound Ear → Core event. `@WebSocketServer()` SHALL provide the typed `Server` instance for any cross-handler emit logic.

#### Scenario: Ear connects and registers

- **WHEN** an Ear opens a socket.io connection to `/ear` and emits a valid `register` event
- **THEN** Core SHALL store the `deviceId`, `deviceName`, and `capabilities` in `EarRegistry`
- **AND** SHALL emit an `ack` event back to the same socket carrying the `deviceId`

#### Scenario: Malformed event payload is received

- **WHEN** Core receives an event whose payload does not validate against the corresponding class-validator DTO
- **THEN** Core SHALL log the validation error at warn level
- **AND** SHALL NOT crash or disconnect the socket
- **AND** SHALL NOT propagate the bad payload to downstream consumers
