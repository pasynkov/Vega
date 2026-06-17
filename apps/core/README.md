# @vega/core

NestJS daemon. Hosts the WebSocket endpoint Ear clients connect to, relays audio to Deepgram's streaming STT, persists sessions to `recordings/`.

```bash
cp .env.example .env
# fill in DEEPGRAM_API_KEY
npm run dev
```

By default it binds `ws://127.0.0.1:7777/ear`. See `src/config/env.ts` for all knobs.
