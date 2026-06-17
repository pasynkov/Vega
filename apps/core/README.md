# @vega/core

NestJS daemon. Hosts the WebSocket endpoint Ear clients connect to, relays audio to Deepgram's streaming STT, persists sessions to `recordings/`.

```bash
cp .env.example .env
# fill in DEEPGRAM_API_KEY
npm run dev
```

By default it binds `ws://127.0.0.1:7777/ear`. See `src/config/env.ts` for all knobs.

## LLM harness

The orchestration spine (supervisor + sub-agents + memory) is wired into Core but the Ear's `final_transcript` is intentionally NOT yet routed to it. To drive the orchestration interactively, use the stdin REPL harness:

```bash
cp .env.example .env
# fill in DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
npm --workspace @vega/core run dev:llm-harness
```

Required env: `DEEPGRAM_API_KEY` (validated at boot), `ANTHROPIC_API_KEY`. Optional: `VEGA_DB_PATH` (defaults to `<recordings-dir>/vega.sqlite`), `VEGA_LLM_PING_ON_BOOT=1`.

The harness sends every line to `ConversationService.handleTurn("default", line)` and prints the supervisor's spoken reply. Conversation state and memory persist in the same SQLite file across restarts.

The harness is the only entry point that exercises the LLM layer in this change; bridging the Ear's transcripts to `handleTurn` is a follow-up change.

## Tool-driven Ear sessions

A domain tool can own an Ear capture session for its full lifetime via `EarSessionRouter` and `SessionAgentRunner` (see `src/ear-sessions/`). The flow:

1. Supervisor calls a domain tool (e.g. notes' `begin_dictation`) which calls `EarSessionRouter.arm({ ownerSpec, mode: "long_note" })`. The router sends `arm_capture` and reserves the next session for `ownerSpec`.
2. Ear opens a fresh long-note session. On `session_start`, the router binds `sessionId → ownerSpec` and `SessionAgentRunner.start(...)` boots a session-bound sub-agent.
3. Every Deepgram final for that session is pushed into the sub-agent as the next turn. The sub-agent reacts via its own session-bound tools (e.g. `append_text`, `finalize_note`, `discard_note`).
4. The sub-agent ends the session by returning a `{ release: true, reason }` tool result; the runner terminates the Ear session with initiator `core:tool_release`.

Independent backstops on owned sessions: the existing Core silence cap (`core:silence_cap`), the Ear-side safety timer, and `EAR_SESSION_OWNER_CAP_MS` (default 90 s wall clock from `session_start`, initiator `core:owner_safety_cap`). When any cap fires the owning domain's flush hook runs before ownership is released.

Unowned sessions go through the existing post-endpoint flow: `SessionService` fires its endpoint listener with the concatenated finals, which `EarSessionsModule` forwards into `ConversationService.handleTurn`. Session-bound tools refuse to run from this path with `ToolUsedOutsideSessionError`.
