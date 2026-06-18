## MODIFIED Requirements

### Requirement: Overlay state model

An overlay state SHALL be a single immutable record with shape `{ kind, hint?, caption?, sound? }`. The `kind` field SHALL be one of `idle`, `listening`, `capturing`, `thinking`, `processing`, `success`, `error`, `view`. The `hint` field SHALL be an optional short string (≤ 120 chars) rendered above the orb. The `caption` field SHALL be an optional short string (≤ 240 chars) rendered below the orb. The `sound` field SHALL be an optional cue name (see `ear-protocol` cue enum) that the Ear SHALL play exactly once on receipt.

Every `overlay_update` SHALL contain a complete state record — there are no patches and no partial updates. Fields absent from the payload SHALL be treated as cleared (e.g. omitting `caption` clears the bottom line).

The `view` kind SHALL signal that a structured list-view surface is currently shown by the Ear (driven by the separate `list_view_update` channel — see ear-protocol). The orb SHALL NOT pulse a spinner in `view` mode; the orb glyph SHALL identify the surface (an SF Symbol on mac-ear) so the user knows the overlay is presenting content rather than waiting on speech.

#### Scenario: Empty optional sections collapse

- **WHEN** an `overlay_update` arrives with `{kind: thinking}` and neither `hint` nor `caption`
- **THEN** the Ear SHALL render the orb in the `thinking` style only
- **AND** SHALL NOT render top or bottom text sections

#### Scenario: Bound-checked text fields

- **WHEN** Core attempts to emit an overlay state with `hint` longer than 120 characters or `caption` longer than 240 characters
- **THEN** validation SHALL reject the state at the service boundary and SHALL NOT send a wire message

#### Scenario: view kind pairs with an open list-view surface

- **WHEN** Core emits `overlay_update {kind: view}` for a device
- **THEN** the Ear SHALL render the orb in the `view` style (no spinner, list-bullet glyph on mac-ear)
- **AND** Core SHALL have also emitted (or imminently emit) a `list_view_update {open: true}` so the list surface is populated
