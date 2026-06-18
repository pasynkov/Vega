## ADDED Requirements

### Requirement: `ConversationService.handleTurn` SHALL serialize per-session

`ConversationService.handleTurn(sessionId, userText)` SHALL guarantee that for any given `sessionId`, at most one `runTurn` is executing at a time. If `handleTurn` is invoked while a prior turn for the same `sessionId` is still in flight, the new invocation SHALL be queued and SHALL run after every previously-queued turn for that session has settled (resolved or rejected). The queue SHALL preserve arrival order.

The implementation SHALL NOT use the inflight-read-then-set pattern; that pattern races when two callers read the same `prior` promise and both create their own `current` after `prior` settles, causing concurrent `runTurn` invocations. Instead, each caller SHALL append its work onto the *latest* per-session chain head (typically `tail = tail.then(() => runTurn(...))`).

A turn that throws or rejects SHALL NOT block subsequent queued turns; the chain SHALL continue with the next turn.

#### Scenario: Two concurrent finals on the same session

- **WHEN** `handleTurn("S", "Так,")` is invoked while `handleTurn("S", "это у нас")` is still in flight
- **THEN** the second invocation SHALL NOT start its `runTurn` until the first invocation's `runTurn` has settled
- **AND** at no point SHALL two `runTurn` calls for the same `sessionId` be active concurrently

#### Scenario: Three queued turns in arrival order

- **WHEN** `handleTurn("S", "first")`, `handleTurn("S", "second")`, and `handleTurn("S", "third")` are invoked back-to-back
- **THEN** the three `runTurn` calls SHALL execute in the order `first` → `second` → `third`
- **AND** each turn's `lastAgentResult` and supervisor checkpoint state SHALL be visible to the next turn

#### Scenario: A turn rejects

- **WHEN** the first turn in the per-session queue throws inside `runTurn`
- **THEN** the rejection SHALL be caught by the chain's error handler and SHALL NOT prevent the next queued turn from running
- **AND** the rejecting turn's caller SHALL still see the rejection as a rejected promise

### Requirement: First-final wake-word filter SHALL drop wake-only utterances

The transcript fanout that drives `ConversationService.handleTurn` (currently `EarSessionsModule.addTranscriptListener`) SHALL recognise the very first `final_transcript` of each wake-driven session and SHALL drop it if its trimmed, lower-cased text matches a configured wake-word vocabulary (case-insensitive substring or whole-word equality, depending on the matcher). The vocabulary SHALL be a Core-side configurable list whose MVP value covers the OpenWakeWord candidates `Janet` and `edna` along with their common Cyrillic / Russian-phonetic transliterations (e.g. `Этна`, `Эдна`, `Джанет`).

A dropped wake-only final SHALL NOT invoke `ConversationService.handleTurn`; instead the listener SHALL log it at info level (`Dropping wake-only first final: <text>`) and continue. Subsequent finals on the same session SHALL be processed normally. The filter SHALL apply only to the FIRST final of each session — once any non-wake final has been processed, subsequent finals SHALL be passed through without checking the vocabulary.

#### Scenario: First final is the wake word transliteration

- **WHEN** a wake-driven session opens and the first `final_transcript` carries the text `"Этна."`
- **THEN** the transcript fanout SHALL drop the final
- **AND** SHALL NOT invoke `ConversationService.handleTurn`
- **AND** SHALL log `Dropping wake-only first final: Этна.`

#### Scenario: First final is real user speech

- **WHEN** a wake-driven session opens and the first `final_transcript` carries `"Давай запишем большую заметку."`
- **THEN** the transcript fanout SHALL pass the final to `ConversationService.handleTurn` unchanged
- **AND** the wake-word filter SHALL NOT short-circuit subsequent finals for the same session

#### Scenario: Second final is a wake word transliteration

- **WHEN** a session has already processed one non-wake final and a subsequent `final_transcript` happens to match `"Этна."`
- **THEN** the transcript fanout SHALL pass the final to `ConversationService.handleTurn` (the filter applies only to the FIRST final per session)
