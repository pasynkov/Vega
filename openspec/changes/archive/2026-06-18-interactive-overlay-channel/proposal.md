## Why

Today the Ear surfaces session state only through audio cues and a menu-bar icon. The user wants a Siri/ChatGPT-style interactive overlay that reflects every phase of the assistant flow (listening, capturing, thinking, processing, success, error) and shows STT progress in continuous sessions. The overlay must be domain-agnostic on the client and driven entirely by the backend so any domain (starting with notes) can paint screens without the Ear needing domain knowledge.

## What Changes

- Introduce a single `overlay_update` channel from core to Ear that carries both visual state and the sound to play, replacing the current `play_cue` message.
- Add a kernel-side tool `update_overlay` that domains call from their agent handlers to push semantic overlay states.
- Add an `OverlayService` on the backend as the sole writer to the channel; both explicit (domain tool) and implicit (wake_ack, partial_transcript, final_transcript, session_end, kernel-emitted tool start/ok/err) triggers go through it.
- **BREAKING**: Remove `PlayCueMessage` from the Ear protocol and from the Ear client. `wake` and continuous `ack_continue` cues remain local-Ear plays driven by wake-word detection and `arm_capture`; all other cues move into `overlay_update.sound`.
- Add an SwiftUI overlay window to mac-ear (NSPanel, floating, borderless, `ultraThinMaterial`, `ignoresMouseEvents`) rendering an ORB + optional hint (top) + optional caption (bottom). Empty sections collapse.
- Reuse the existing notes domain for end-to-end validation: `save_short_note` paints processing → success/error; continuous-mode notes paint `capturing` with each STT final as caption.

## Capabilities

### New Capabilities
- `overlay-channel`: defines the overlay state model, the `update_overlay` kernel tool contract, the `overlay_update` wire message, and the role of `OverlayService` as the single per-device writer.

### Modified Capabilities
- `ear-protocol`: add `overlay_update` to Core→Ear discriminated union; remove `play_cue`; document that `wake` cue stays local-Ear and `arm_capture` continues to carry mode-specific cue semantics.
- `mac-ear`: add overlay window + view-model that consumes `overlay_update`; drop the `play_cue` handler; keep CuePlayer for local wake and arm_capture cues only.
- `kernel-session-control-tools`: add `update_overlay` to the catalog of kernel-provided tools that any domain can inject into its agent spec.

## Impact

- `packages/ear-protocol`: schema deletion of `PlayCueMessage`, addition of `OverlayUpdateMessage` and `OverlayStateSchema`; bump protocol minor.
- `apps/core`: new `OverlayService` (per-device single writer, monotonic `seq`), wiring in `SessionService` (partial/final/session_end) and `EarSessionRouter` / wake flow (wake_ack proceed), kernel tool `update_overlay` exposed alongside `open_continuous_session`.
- `apps/core/src/domains/notes`: notes handlers call `update_overlay` for processing/success/error; continuous-mode reacts to STT finals through OverlayService (no notes-specific code needed beyond opening continuous mode).
- `apps/mac-ear`: new `OverlayWindowController`, SwiftUI `OverlayView` and `Orb`, `OverlayViewModel`, removal of `play_cue` branch in `SessionCoordinator`. CuePlayer still serves wake/arm_capture cues.
- No backwards compatibility shim — protocol is internal; both sides ship together.
