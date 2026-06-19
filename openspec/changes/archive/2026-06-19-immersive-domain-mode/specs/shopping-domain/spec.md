## ADDED Requirements

### Requirement: Shopping session-spec for immersive mode

The shopping domain SHALL expose a second `AgentSpec` built by `buildShoppingSessionSpec(tools, closeImmersiveTool)`, parallel to the existing supervisor-spec. The session-spec SHALL contain the same domain tools (`add_item`, `list_items`, `mark_bought`, `delete_item`, `clear_list`, `show_list`, `close_list_view`) plus the session-bound tool `close_immersive_session`. The system prompt SHALL be 95% identical to the supervisor-spec prompt (intent maps for add/mark/delete/show), extended with one rule:

> Если пользователь сказал «закрой покупки» / «хватит» / «выходим» / «закончил» — вызови `close_immersive_session`.

The session-spec SHALL be the spec passed to `EarSessionRouter.arm` when an immersive shopping session is opened. The supervisor-spec SHALL remain unchanged.

#### Scenario: Session-spec is wired into immersive arm

- **WHEN** `open_immersive_session({domain: "shopping"})` is called
- **THEN** `router.arm.ownerSpec` SHALL be the shopping session-spec, not the supervisor-spec

#### Scenario: Session-spec handles close-utterance

- **WHEN** an immersive shopping session receives a final `"закрой покупки"`
- **THEN** the session-spec agent SHALL call `close_immersive_session`
- **AND** the runner SHALL release the session with reason `"user"`

### Requirement: close_immersive_session tool

`close_immersive_session` SHALL be a session-bound tool registered in `buildShoppingSessionSpec`. The tool SHALL return `{release: true, reason: "user"}` (a valid `SessionToolResult`) so the `SessionAgentRunner` per-final-turn strategy releases the session via the standard release-by-tool path. The tool SHALL take a single optional `intent` field for logging.

#### Scenario: close_immersive_session returns release marker

- **WHEN** `close_immersive_session({intent: "user-close"})` is invoked
- **THEN** the tool SHALL return a `SessionToolResult` with `release: true, reason: "user"`

### Requirement: Shopping sessionBegin paints immersive entry

The shopping domain SHALL provide a `sessionBegin(deviceId)` hook registered with `ImmersiveDomainRegistry`. When called, the hook SHALL:

1. Load the live shopping items from `ShoppingStorageService`.
2. Build a `ListView` snapshot.
3. Emit a `list_view_update` with the snapshot via `ListViewService.refresh(deviceId, snapshot, "shopping:immersive_begin")`.
4. Emit `overlay_update` with `{kind: "immersive"}` via `OverlayService.set(deviceId, ...)`.

#### Scenario: sessionBegin paints entry on arm

- **WHEN** an immersive shopping session is bound and `sessionBegin(deviceId)` is invoked
- **THEN** Core SHALL emit a `list_view_update` carrying the current live items
- **AND** Core SHALL emit an `overlay_update` with `state.kind: "immersive"`

### Requirement: Shopping module registers in ImmersiveDomainRegistry

`ShoppingModule` SHALL implement `OnApplicationBootstrap` and call `registry.register({name: "shopping", sessionSpec, sessionBegin})` once during startup. The registration SHALL happen before top-supervisor's spec is built so the supervisor's prompt block lists `shopping`.

#### Scenario: Shopping appears in registry list

- **WHEN** the application boots
- **THEN** `registry.list()` SHALL include `"shopping"` before the top-supervisor spec is built
- **AND** the top-supervisor's prompt SHALL mention `shopping` as an available immersive domain
