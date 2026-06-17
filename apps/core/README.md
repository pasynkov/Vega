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
