## Context

Today the only domain that opens a long-running capture session is `notes`, and it does so via a tool factory inlined in `apps/core/src/domains/notes/notes.tools.ts`:

```ts
const beginDictation = makeTool({
  dto: BeginDictationDto,
  name: "begin_dictation",
  handler: async () => {
    const spec = sessionSpecRef.spec;
    if (!spec) return { ok: false, reason: "notes-session-spec-not-ready" };
    const result = router.arm({ ownerSpec: spec, mode: "long_note" });
    return result;
  },
});
```

`EarSessionRouter.arm` is a kernel service (in `conversation/sessions/`). The tool is essentially `arm(spec, mode)`-with-a-name, which makes it a primitive kernel concern dressed up as a notes-domain concern. Any future domain (story dictation, voice journaling, chat-style turn-taking with no auto-VAD) would either duplicate this factory or reach into `EarSessionRouter` directly — both worse than centralizing the builder once.

At the protocol layer the mode value is named `long_note`. The Ear and Core both treat `long_note` as "suppress VAD endpoint, use a 60-second silence cap, play the Submarine cue on arm." Nothing about that behavior is specific to notes. The name baked the original use case into the wire format and into the audio pipeline's mode discriminant.

This change extracts the kernel-side builder and flips the protocol enum value to `continuous`. The capability-name in `openspec/specs/long-note-mode/` stays for one cycle to avoid a directory rename in addition to the wire change; the requirements inside are reworded.

## Goals / Non-Goals

**Goals:**

- A single kernel builder, `buildOpenContinuousSessionTool(router, ownerSpecRef)`, returns the canonical `open_continuous_session` `AgentTool`. Domains that want continuous capture inject this builder's output into their `AgentSpec.tools`. The notes domain is the first consumer.
- The wire enum value `long_note` is renamed to `continuous` in one coordinated change spanning `ear-protocol` (TypeScript and Swift), Core (`conversation/ear/session/`, `conversation/sessions/`), `mac-ear`, and `domains/notes`. After this change, no source file under `apps/`, `packages/`, or `openspec/` contains the literal string `long_note` outside of archived changes.
- Tests stay green: the existing long-note end-to-end flow in `apps/core/tests/ear-sessions/full-flow.test.ts` continues to drive arm → bind → flush → finalize, just with the new mode literal; the contract e2e from `refactor-backend-modules` is unaffected.

**Non-Goals:**

- Changing the silence-cap value (`60_000 ms`).
- Adding any new mode beyond `regular` and `continuous`.
- Moving the *decision* of when to open a continuous session up to the supervisor — the supervisor still routes to `notes`, the `notes` domain decides whether the user wants a long dictation and calls `open_continuous_session`.
- Splitting the `notes` tool bundle further or extracting any other notes tool.
- Changing the long-note safety cap, the flush-hook semantics, or the per-final routing.
- Supporting older Ear builds at the protocol level. The protocol bump is breaking.

## Decisions

### Decision: Kernel builder lives in `conversation/kernel/tools/`

Put the builder under `apps/core/src/conversation/kernel/tools/open-continuous-session.tool.ts` (a new directory). Subsequent kernel-provided tool builders (`close_session`, `pause_session`, future capture-control primitives) land in the same folder.

**Alternative considered:** put the builder next to `EarSessionRouter` under `conversation/sessions/`. Rejected because the builder is the kernel's *outer* API surface for domains — domains import from `conversation/kernel/tools/` (a shallow public-looking path) rather than from `conversation/sessions/` (which sounds like an internal pipeline subdir).

**Alternative considered:** export the builder from `conversation/kernel/index.ts` (a barrel). Rejected — no other kernel module re-exports through a barrel; this would set a precedent we don't yet want.

### Decision: Signature is `(router, ownerSpecRef)`, not `(router, ownerSpec)`

The `notes` domain builds its session-bound `AgentSpec` and its tool bundle in the same constructor; the spec is not assignable to a const at builder-call time because it depends on the tool bundle, which depends on a `sessionSpecRef` for the supervisor tools. The existing `sessionSpecRef: { spec: AgentSpec | null }` indirection is preserved verbatim.

```ts
export function buildOpenContinuousSessionTool(
  router: EarSessionRouter,
  ownerSpecRef: { spec: AgentSpec | null },
): AgentTool;
```

The handler reads `ownerSpecRef.spec` at call time, returning `{ ok: false, reason: "<name>-session-spec-not-ready" }` when null. The error string is parameterized by `ownerSpecRef.spec?.name ?? "owner"` — same diagnostics as today.

**Alternative considered:** require a fully-constructed `AgentSpec` and disallow the ref. Rejected for backward compatibility — `notes` builds the supervisor and session specs in one pass, and threading a constructed `sessionSpec` through to the supervisor's tool factory would require restructuring `NotesAgentService` more than this change wants.

### Decision: Tool name is `open_continuous_session`

Public LLM-facing name for the tool. The DTO stays parameter-less (the existing `BeginDictationDto` is a single optional `intent: string` field; we keep it and rename the DTO to `OpenContinuousSessionDto`).

**Alternative considered:** keep DTO name `BeginDictationDto` for code-stability. Rejected — code touched anyway during the tool rename; aligning DTO with tool name is cleaner.

### Decision: Protocol value `continuous`, not `continuous_conversation`

Short, mode-flavored, matches the existing peer value `regular`. `continuous_conversation` would be 21 characters in a tight enum and would imply two-way dialog (which this mode is not; it is one-way streamed dictation / monologue).

**Alternative considered:** `streaming`. Rejected — every WebSocket session is streaming; the discriminant is "does VAD auto-end?" The word `continuous` captures that ("no auto endpoint, runs until user stops or 60-second silence cap").

### Decision: Constant in Core renames to `CONTINUOUS_MODE_SILENCE_CAP_MS`

`LONG_NOTE_SILENCE_CAP_MS` in `apps/core/src/conversation/ear/session/session.service.ts` is renamed alongside the wire value. Value unchanged (`60_000`).

### Decision: Capability folder `openspec/specs/long-note-mode/` is NOT renamed in this change

Renaming a capability folder on disk requires (a) all delta specs to use the new folder path and (b) the archive flow to handle the migration. Out of scope. The requirements inside the folder are reworded around the term `continuous`, which is enough — the folder name is internal-only.

A follow-up change MAY rename `openspec/specs/long-note-mode/` → `openspec/specs/continuous-capture-mode/` when there is no other pending change touching that folder.

### Decision: Notes prompts and tool descriptions also rename

`apps/core/src/domains/notes/notes.agent.ts` system prompts contain the words `long_note` and "длинной заметки" in several places. Where the model text says the tool name or the mode value, rename. Where the text says "длинной заметки" as a Russian-language description of the user-facing scenario, keep — the user's mental model is still "diktovat' dlinnuyu zametku" even if the wire mode is now `continuous`.

### Decision: One PR per kind of change

The work is split into three commits (tasks groups 1, 2, 3) but landed as a single PR because the protocol rename and the kernel builder extraction must land atomically — a Core that emits `continuous` against an Ear expecting `long_note` would fail at zod validation.

1. **Protocol + Swift**: `packages/ear-protocol` and Swift consumers. Standalone-valid TypeScript + Swift compile.
2. **Core + kernel builder**: the new kernel file + every Core consumer of `long_note` + the notes domain. Vitest suite green at end.
3. **Tests + final verification**: any test literal updates, contract e2e re-run, manual `npm run core:dev` + `swift build` confirmation.

## Risks / Trade-offs

- **[Risk] Wire-format change breaks unbuilt Ear builds** — anyone with a stale `mac-ear` will see zod-validation rejections on `arm_capture { mode: "continuous" }`. → **Mitigation:** this is a solo-developer project; bump `packages/ear-protocol` package.json version (minor → next major) and check in the regenerated `dist/`. Document the breaking change in the proposal so a future bisect points here.

- **[Risk] Swift enum migration miss** — Swift's exhaustive switch on `SessionMode` will catch a missed case at compile time, but a missed string literal `"long_note"` would silently pass compilation. → **Mitigation:** post-rename, grep the whole `apps/mac-ear` tree for `long_note` and `longNote`; both should yield zero hits before commit.

- **[Risk] Spec folder name drift** — the `openspec/specs/long-note-mode/` folder keeps its name while every requirement inside talks about `continuous`. Confusing for a new reader. → **Mitigation:** add a one-line note at the top of `spec.md` explaining the folder name is historical and a follow-up will rename it. The risk is cosmetic.

- **[Trade-off] No backward-compatibility shim on the protocol** — we could accept both `long_note` and `continuous` for one release. Decided against — there's exactly one Ear, the developer's local Mac, and a shim adds permanent surface area we'd never remove. Hard cut is cheaper.

- **[Trade-off] Tool builder takes a router instance, not a port** — the kernel builder injects `EarSessionRouter` directly. We could define a `SessionControlPort` interface to abstract from `EarSessionRouter`, but no second implementation exists, so a port today is speculation. If a non-WebSocket transport (Telegram, in-process) lands later, factor the port out then.

## Migration Plan

In-place on `main`. No external deployment. Steps map 1:1 to tasks.md groups:

1. Land the protocol rename (TypeScript + Swift) and rebuild `packages/ear-protocol/dist/`. Verify `swift build` and `tsc --noEmit` succeed in isolation.
2. Land the Core-side rename + the new kernel builder. Notes consumes the builder. Run the full vitest suite — fix any test literal that still says `long_note`. Run `npm run core:dev` for a few seconds to confirm boot.
3. Land any remaining test fixes + run `apps/core/tests/e2e/contract.e2e.test.ts` and the long-note `full-flow.test.ts` to confirm end-to-end arm → bind → flush → finalize still works.

Rollback: revert the three commits in reverse. No DB migration, no env var change.

## Open Questions

- *Should `OpenContinuousSessionDto` keep the optional `intent` field?* — it's not used by `EarSessionRouter.arm`. Probably yes for debuggability (the model fills in why it wants the session), but it's purely log surface. Decided at code time, not in spec.
- *Should we expose a `close_continuous_session` builder in this change?* — `finalize_note` and `discard_note` already implicitly close the session via the `release: true` return contract. No second builder needed today.
