## Context

The Ear today surfaces session state via audible cues (`play_cue` over the protocol) and a menu-bar status item. There is no visual surface that explains "what's happening right now" to the user during a turn, and no way for a domain to push semantic hints ("сохраняю заметку…", "не понял запрос") that are visible to the user without a notification or a sound.

We want a Siri/ChatGPT-style overlay that reflects every phase of the assistant flow and, in continuous mode, surfaces each STT final as it arrives. The overlay must be domain-agnostic on the Ear: Ear renders state, Core decides state. Domains drive it through a new kernel tool. Implicit state (wake, STT, end-of-session) is also driven by Core through the same path so the wire surface stays small and the Ear has one canonical view-model.

Existing facts that constrain this design:

- A single Ear has a single active capture session at a time (already in `ear-protocol`).
- Protocol is internal: TS + Swift mirror; both sides ship together — no compat shim.
- Cue audio is currently a separate channel (`play_cue`). Merging it into the overlay update removes one source of out-of-order or partial state.
- Wake-word detection is local on the Ear; the `wake` cue is therefore played without server roundtrip. Same for `ack_continue` on `arm_capture`.
- Domains today reach Ear behavior only through kernel-provided tools (`open_continuous_session`) or implicit Core triggers. The new `update_overlay` tool follows the same pattern.

## Goals / Non-Goals

**Goals:**
- One canonical channel from Core to Ear for the interactive overlay: `overlay_update`.
- A single per-device writer on Core (`OverlayService`) so seq ordering and ttl timers have one home.
- A `update_overlay` kernel tool so any domain can paint the overlay through a stable contract.
- Atomic visual + sound in a single message (drops the race between `play_cue` and a visual hint).
- Domain-agnostic client: Ear maps `kind` → orb style, renders `hint`/`caption` text, plays `sound`. No domain identifiers on the wire.
- End-to-end validation on the existing notes domain (short save + continuous dictate).

**Non-Goals:**
- Lists / history of past STT finals in the overlay. We replace caption on each final.
- Cancel-by-click affordance on the overlay. Going silent ends the session; that's the cancel.
- Snapshot/replay on reconnect. Reconnect = sessionless = no overlay.
- Multi-device fan-out for a single user. Per-device state only; if multiple Ears exist, each gets its own state.
- Animation polish beyond a minimal pulse/gradient orb. Polish lands in a follow-up change.
- Domain-driven theming (icon, color per domain). Ear stays domain-agnostic.

## Decisions

### Decision 1: One channel, atomic update, sound merged in

`overlay_update` carries `{ seq, state: { kind, hint?, caption?, sound? } }`. There is no patch form; each message is a complete state record. Sound is part of the state. `play_cue` is removed.

Why:
- Removes the wire race between cue and visual; an overlay change "appears with its sound".
- Simpler client: single discriminated branch instead of two.
- Domain code calls one tool, not two.

Alternatives considered:
- Keep `play_cue` and add a separate `overlay_update`. Rejected: doubles bookkeeping in domain handlers ("did I emit both?") and reintroduces the race.
- Patch-based protocol with field-level merges. Rejected: no real use case; complete-record updates are tiny and easier to reason about.

### Decision 2: Single per-device writer on Core (`OverlayService`)

All overlay mutations go through `OverlayService.set(deviceId, state)`. The service owns seq, ttl timers, and per-device serialization. Implicit triggers (wake_ack, partial/final, session start/end) call it from Core hooks; explicit triggers (domain tool) call it from `update_overlay` handler.

Why:
- One canonical source means the seq is meaningful and ordering is deterministic.
- TTL timers live in one place (no client-side timers, no domain-side timers).
- Removing the service later is easy because no caller talks directly to the WebSocket.

Alternatives considered:
- Domain handlers + Core hooks both write to the WebSocket directly. Rejected: race, no seq authority, ttl logic duplicated.
- A "patch bus" with a reducer on the Ear. Rejected: state machine on both sides is overkill for a one-screen overlay.

### Decision 3: `wake` cue stays local on the Ear; everything else flows in `state.sound`

The wake cue is part of the perceptual loop ("I heard you") and a server roundtrip introduces noticeable latency. The Ear plays `wake` directly on wake-word detection. `ack_continue` likewise plays directly on `arm_capture` (the cue is intrinsic to the act of arming, not to an overlay change). Every other cue (`endpoint`, `error`, `ack_done`, `ack_thinking`, `ack_success`, `ack_error`, `ack_unknown`) flows in `state.sound`.

Why:
- Wake latency budget is ~200 ms; a WS roundtrip burns most of it.
- Keeping `wake` local also means the wake feedback doesn't depend on the server being responsive.
- `ack_continue` is already coupled to `arm_capture` in the existing protocol; preserving that is the smaller diff.

Alternative considered:
- Move `wake` into `overlay_update` for uniformity. Rejected: latency cost and a reliability regression (no wake feedback if Core is slow).

### Decision 4: Reconnect = idle, no snapshot replay

If the WebSocket drops, the active session is gone. The Ear hides any overlay and the new connection starts at implicit `idle`. Core does not emit anything on reconnect.

Why:
- Sessions don't survive reconnects (already true in current behavior).
- Replaying stale overlay state misleads the user.
- Simpler client lifecycle.

Alternative considered:
- `overlay_snapshot` on connect. Rejected: there's nothing to restore in the no-session steady state.

### Decision 5: TTL terminates the session, not the overlay

When a domain sets `ttl`, Core schedules a `session_end(endpoint)` after the delay. The overlay disappears as a consequence of the session ending (Ear-side rule: overlay drops on `session_end`). The overlay state itself stays put during the TTL.

Why:
- Single rule on the client: overlay tied to session lifecycle.
- Keeps domain semantics simple: "show success for 1.5 s, then we're done" maps directly to "success state with ttl: 1500".
- Avoids a competing "revert to idle without ending session" pathway.

Alternative considered:
- TTL reverts overlay to idle and leaves session open. Rejected: encourages dangling sessions; the only realistic ttl use today is "show success and close".

### Decision 6: Caption is a single line, replaced on every final

In continuous mode each STT final becomes `{kind: thinking, caption: <text>}`. No list is accumulated. The user sees the latest sentence; older sentences are gone from the overlay (still go to whatever domain logic consumes them).

Why:
- Matches the user's explicit ask ("на отдельные фразы… не список").
- Keeps the Ear stateless w.r.t. transcript history.

Alternative considered:
- Accumulate finals client-side and render as a scrolling list. Rejected: not asked for; pushes domain semantics into the client.

### Decision 7: Field-bound length limits + strict enum + tolerant Swift decode

DTO validation rejects oversize `hint`/`caption` at the service boundary on Core. The Ear's Swift decoder treats unknown `kind`/`sound` as `.unknown` and falls back to a sensible visual rather than aborting the WebSocket.

Why:
- Bounded text prevents accidental megabyte payloads in the overlay.
- Tolerant decode means a Core upgrade adding a new `kind` doesn't break old Ears in the field.

## Risks / Trade-offs

- **Removing `play_cue` is a breaking protocol change.** Mitigation: the protocol is internal; both sides ship together. The archive note in `ear-protocol/spec.md` after archival explains the migration.
- **Single overlay writer is a serialization point.** Mitigation: it's per-device; volume is low (≤ ~10 updates per turn); a simple async lock or in-memory queue suffices.
- **TTL implies the success/error overlay always closes the session.** Mitigation: domains that don't want auto-close just omit `ttl`. If a domain wants overlay revert without ending the session, that's a follow-up requirement; today there's no use case.
- **Implicit triggers + explicit domain pushes can fight each other.** Mitigation: last-writer-wins by seq is deterministic; domains are expected to set `processing/success/error` after the implicit `thinking` set by the STT path, which is the natural sequence anyway.
- **Empty optional sections vs hint-only updates.** Risk: a domain emits `{kind: processing, hint: "..."}` and clears the active caption. Mitigation: this is the intended semantic (full replacement); document in the kernel tool's description and notes-domain example.
- **Performance of SwiftUI Canvas orb on older hardware.** Mitigation: MVP uses a `Circle` + `RadialGradient` + an `Animation.repeatForever`. If this lags on older machines, swap to a static glyph in a later iteration.

## Migration Plan

1. Land the `ear-protocol` package change (add `OverlayUpdateMessageSchema`, remove `PlayCueMessageSchema`, bump minor). Update the Swift mirror generator in the same commit.
2. Land Core changes alongside: introduce `OverlayService`, wire implicit triggers, expose `update_overlay` kernel tool, remove all `play_cue` emit sites.
3. Land mac-ear changes in the same release: drop `play_cue` handler, add overlay window + view-model, keep CuePlayer for `wake` and `ack_continue`.
4. Wire the notes domain: inject `update_overlay` into the supervisor bundle; replace existing `ack` cue emits in `save_short_note` and continuous-mode terminators with `update_overlay` calls.
5. Manual end-to-end validation on notes (short save → success ttl → session end; continuous dictate → multiple `thinking` updates with captions).
6. No rollback shim. If a regression appears, revert the whole change (it's an atomic protocol+client+server bump).
