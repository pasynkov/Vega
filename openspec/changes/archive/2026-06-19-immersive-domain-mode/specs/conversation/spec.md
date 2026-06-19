## ADDED Requirements

### Requirement: SessionAgentRunner supports two strategies

`SessionAgentRunner.start(args)` SHALL select an internal strategy from `args.handle.mode`:

- `continuous` → existing `continuous-finalize` strategy (pause-prompt finalize-check, terminal-check, flush-hook accumulation — unchanged from current behavior).
- `immersive` → new `per-final-turn` strategy.

The two strategies SHALL share `pushFinal`, `signalEnd`, `forceTimeout`, `dispose` external interface but SHALL run different internal control flow. Other modes (`regular`, `ask`) SHALL never spawn a `SessionAgentRunner`.

#### Scenario: Strategy selection on start

- **WHEN** `runner.start({handle: {mode: "immersive", ...}, spec, ...})` is called
- **THEN** the runner SHALL initialize the `per-final-turn` strategy
- **AND** SHALL NOT arm a pause-timer
- **AND** SHALL NOT register a flush-hook

#### Scenario: pushFinal triggers immediate agent invocation in per-final-turn

- **WHEN** in per-final-turn strategy, `pushFinal("добавь молоко")` is called
- **THEN** `agent.invoke` SHALL be called once with `messages: [HumanMessage("добавь молоко")]`
- **AND** SHALL NOT wait for a pause-window

### Requirement: SessionAgentRunner emits inFlight transitions

The per-final-turn strategy SHALL emit `inFlight` transitions through a callback registered at `runner.start` via `args.callbacks.onInFlightChange?: (inFlight: boolean) => void`. The callback SHALL fire exactly once at the start of each agent invocation (`true`) and once after invocation finishes regardless of outcome (`false`). The continuous-finalize strategy SHALL NOT fire this callback.

#### Scenario: inFlight pairs around invoke

- **WHEN** in per-final-turn strategy, `pushFinal` triggers an invoke that takes 3 seconds
- **THEN** `onInFlightChange(true)` SHALL be called at t=0
- **AND** `onInFlightChange(false)` SHALL be called at t=3s (after release-parse and any tool fire)

#### Scenario: invoke timeout still emits inFlight false

- **WHEN** an agent invocation exceeds the 20-second hard timeout
- **THEN** the runner SHALL abort the invoke
- **AND** `onInFlightChange(false)` SHALL still fire
- **AND** an error overlay SHALL be painted via the standard error path

### Requirement: SessionService observes inFlight for immersive silence timer

`SessionService` SHALL accept an `inFlight` signal from the owning runner for immersive sessions and SHALL use it to gate the per-session silence timer: while `inFlight = true`, `armSilenceTimer` SHALL not schedule a new fire; when `inFlight` transitions to `false`, the timer SHALL be re-armed for the full `silenceCapMs` budget. The signal SHALL be propagated through a new `setSessionInFlight(sessionId, inFlight)` method on `SessionService`, called by `EarSessionsModule` from the `onInFlightChange` callback.

#### Scenario: Silence timer paused during in-flight

- **WHEN** an immersive session has `inFlight = true` and 20 seconds elapse with no STT activity
- **THEN** the silence cap SHALL NOT fire
- **AND** the timer state SHALL show "paused"

#### Scenario: Silence timer re-arms on inFlight false

- **WHEN** `setSessionInFlight(sessionId, false)` is called at time T
- **THEN** the silence timer for that session SHALL re-arm for `silenceCapMs` from T

### Requirement: EarSessionsModule wires immersive sessions

`EarSessionsModule.attachOwnerStarter` SHALL handle the new owner-strategy selection: when `ownership.mode === "immersive"`, the module SHALL:

1. Spawn the runner with `mode = "immersive"` so the `per-final-turn` strategy is selected.
2. Pass `onInFlightChange: (b) => sessions.setSessionInFlight(sessionId, b)` to the runner callbacks.
3. After successful bind, look up the domain in `ImmersiveDomainRegistry` and invoke `reg.sessionBegin(deviceId)` (best-effort; errors logged, do not abort the session).
4. NOT register a `FlushHookRegistry` flush-hook or `finalAppend` (those are continuous-style).

#### Scenario: Immersive bind triggers sessionBegin

- **WHEN** an immersive shopping session is bound at session_start
- **THEN** `EarSessionsModule` SHALL invoke `registry.get("shopping").sessionBegin(deviceId)` exactly once

#### Scenario: Immersive sessionBegin error does not crash the session

- **WHEN** `sessionBegin` throws synchronously
- **THEN** `EarSessionsModule` SHALL log a warning
- **AND** the runner SHALL remain alive and accept pushFinal calls
