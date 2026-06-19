## ADDED Requirements

### Requirement: Immersive Ear-session mode

The system SHALL support a fourth Ear-session mode named `immersive`, parallel to `regular`, `continuous`, and `ask`. An `immersive` session SHALL be opened only via `EarSessionRouter.arm({mode: "immersive", ownerSpec, ...})` triggered by the top-supervisor kernel-tool `open_immersive_session`. While active, the session SHALL belong to a domain `sessionSpec` and SHALL bypass the kernel orchestration graph: every STT-final on the session SHALL go directly to the owning runner, not to `ConversationService.handleTurn`.

#### Scenario: Immersive session bypasses top-supervisor

- **WHEN** an immersive session is bound to a `shopping-session-spec` owner and an STT-final arrives
- **THEN** `EarSessionsModule` SHALL NOT invoke `ConversationService.handleTurn` for that final
- **AND** the final SHALL be forwarded to the session-bound runner via `SessionService.onFinal → ownerController.pushFinal`

#### Scenario: Immersive session uses 15s silence cap by default

- **WHEN** an immersive session is started
- **THEN** `SessionService` SHALL set the per-session `silenceCapMs` to 15_000 by default
- **AND** SHALL set `vadEndpointSuppressed = true` (no Ear-side VAD-endpoint termination)

### Requirement: Immersive silence timer pauses while agent is in flight

The immersive silence-cap timer SHALL be paused while the domain agent is executing a turn (between `pushFinal` and the end of `agent.invoke`). When the agent turn completes, the timer SHALL re-arm with the full `silenceCapMs` budget. Incoming STT-partials SHALL re-arm the timer regardless of in-flight state.

#### Scenario: Long agent invocation does not trigger silence cap

- **WHEN** an immersive session has `inFlight = true` for 16 seconds while the agent runs
- **AND** no new partial or final arrives in that window
- **THEN** the silence cap SHALL NOT fire during the 16-second window
- **AND** the timer SHALL re-arm at `t = inFlight false` for the next 15 seconds

#### Scenario: Partial during in-flight resets the timer

- **WHEN** a partial transcript arrives while `inFlight = true`
- **THEN** the partial SHALL be recorded
- **AND** the silence timer state SHALL note the activity so the next re-arm starts from now

### Requirement: ImmersiveDomainRegistry

A new `ImmersiveDomainRegistry` Nest-service SHALL be the single source of truth for immersive-capable domains. Each domain that wants to support immersive mode SHALL call `registry.register({name, sessionSpec, sessionBegin})` in its module's `OnApplicationBootstrap`. The registry SHALL expose `register`, `get(name)`, and `list(): string[]` (sorted lexicographically).

#### Scenario: Domain registers itself on bootstrap

- **WHEN** `ShoppingModule.onApplicationBootstrap` runs
- **THEN** `registry.register({name: "shopping", sessionSpec, sessionBegin})` SHALL be called
- **AND** `registry.list()` SHALL include `"shopping"`

#### Scenario: Unknown domain rejected at session-arm time

- **WHEN** `open_immersive_session` is invoked with `domain: "unknown"`
- **THEN** the handler SHALL return `{ok: false, reason: "unknown-immersive-domain"}`
- **AND** no `arm_capture` SHALL be dispatched

### Requirement: Kernel tool `open_immersive_session`

Top-supervisor SHALL have a kernel-provided tool `open_immersive_session({domain, intent?})`. The tool SHALL resolve `registry.get(domain)`; if found, SHALL call `EarSessionRouter.arm({ownerSpec: reg.sessionSpec, mode: "immersive", intent})`. The tool SHALL NOT live in any domain-supervisor-spec. Domain enum SHALL be validated at handler runtime against the live registry list.

#### Scenario: Top-supervisor opens immersive session for shopping

- **WHEN** the top-supervisor calls `open_immersive_session({domain: "shopping", intent: "погружение"})`
- **THEN** `router.arm` SHALL be invoked with `ownerSpec = shopping-session-spec` and `mode = "immersive"`
- **AND** the result SHALL include `{ok: true, deviceId, mode: "immersive"}` on success

### Requirement: SessionAgentRunner per-final-turn strategy

`SessionAgentRunner` SHALL support a second strategy `per-final-turn` selected when `handle.mode === "immersive"`. In this strategy:

- Each `pushFinal(text)` SHALL invoke `agent.invoke({messages: [HumanMessage(text)]})` synchronously (sequential, not interleaved across finals).
- The runner SHALL signal `inFlight=true` at the start of `invoke` and `inFlight=false` at the end. Both values SHALL be observable by `SessionService` so the silence timer can pause.
- The runner SHALL skip its own pause-prompt / terminal-prompt logic. The strategy has neither.
- If the agent's tool return parses as `SessionToolResult { release: true, reason }` (e.g. `close_immersive_session`), the runner SHALL release with that reason.
- Wake-word-only finals (per `isWakeWordFinal`) SHALL be filtered before invoke (mirroring short-session behavior).
- The agent SHALL have a hard invocation timeout of 20_000 ms (env-overridable). On timeout, the runner SHALL log a warning, set `inFlight=false`, paint an error overlay, and remain alive (no auto-release).

#### Scenario: Per-final-turn invokes agent on each final

- **WHEN** two finals `"добавь молоко"` then `"купил молоко"` arrive in an immersive session
- **THEN** `agent.invoke` SHALL be called twice (sequentially), once per final
- **AND** `inFlight` SHALL transition true→false twice
- **AND** neither invocation SHALL include rolling history of the other final

#### Scenario: close_immersive_session triggers runner release

- **WHEN** during a per-final-turn invoke the agent calls `close_immersive_session`
- **AND** the tool returns `{release: true, reason: "user"}`
- **THEN** the runner SHALL call `onRelease(sessionId, "user", "core:tool_release")`
- **AND** the session SHALL be torn down via `terminateExternal`

### Requirement: Wake-word inside immersive is not parsed

While an immersive session is active, the Ear-side wake detector's signal SHALL NOT route the user into another domain. The existing continuous-style mechanism (`vadEndpointSuppressed = true`) covers this on Core; no additional Ear logic is required. Escape from immersive SHALL be possible only through `close_immersive_session` (voice tool), the Ear physical tap (which sends `session_end{reason:"user"}`), or the silence cap.

#### Scenario: Wake during immersive does not switch domain

- **WHEN** the user says `"Этна, открой заметку"` while inside an immersive shopping session
- **THEN** the Ear SHALL NOT start a new session
- **AND** Core SHALL receive the text as a normal final and route it through the shopping-session-spec
- **AND** shopping-session-spec SHALL respond per its prompt rules (likely a no-op or a clarification via overlay)
