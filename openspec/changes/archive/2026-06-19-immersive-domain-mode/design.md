## Context

Vega Core уже умеет три режима Ear-сессии:
- `regular` — короткий wake→turn→endpoint цикл; finals роутятся через top-supervisor (`ConversationService.handleTurn` → kernel-graph).
- `continuous` — длинная диктовка одной заметки; owner = notes-session-spec; finals копятся, agent решает finalize/discard.
- `ask` — single-final-exit, отвечает на question от tool'а.

`EarSessionRouter.arm` резервирует сессию через `arm_capture` + `session_start binding`, `SessionService` ведёт жизненный цикл и понимает silence cap / VAD. Continuous-сессия владелец — domain-session-spec, finals идут в `SessionAgentRunner.pushFinal` минуя top-supervisor (см. `EarSessionsModule:148-149`).

Существующий fundament покрывает 60% задачи: owner-bypass, arm-flow, mode-aware silence cap. Нужен второй pattern владения сессией — **multi-command per-final** — и кросс-доменный registry для intent detection.

## Goals / Non-Goals

**Goals:**
- Один `mode: "immersive"` поверх существующего session-pipeline.
- Top-supervisor открывает immersive-сессию для произвольного зарегистрированного домена через kernel-tool.
- Domain-session-spec получает каждый final как изолированный turn, выполняет tool, заканчивает ход.
- Exit через voice-tool + silence cap 15s. Silence-таймер ставится на паузу пока agent в полёте.
- Wake-word внутри immersive не интерпретируется (ровно как в continuous).
- Shopping — первый клиент режима. Pattern масштабируется на любой будущий domain.

**Non-Goals:**
- Multi-device fan-out / true "rooms" с broadcast'ом overlay-update (overkill для одного Ear).
- Уход от kernel-graph для top-supervisor в short-режиме (continues working as-is).
- Перевод Notes на immersive (continuous остаётся для single-artifact dictation).
- Wake-word transitions между immersive-доменами без явного `close_immersive_session`.

## Decisions

### Decision 1: Новый `SessionMode "immersive"` (не reuse `continuous`)

Continuous уже жёстко привязан к notes-семантике: `silence cap 60s`, runner pause-check + finalize-prompt, flush-hook append-all-finals. Reuse через флаг (`immersive: true`) превратил бы `SessionService.start` и `SessionAgentRunner.start` в спагетти из conditional'ов.

Чистый mode = чистая ветка:
- `SessionService` понимает `immersive` ровно как `continuous` в части `vadEndpointSuppressed=true`, но `silence cap = 15_000` (default из env).
- `SessionAgentRunner` ловит mode в `handle.mode` → выбирает runner-strategy (`per-final-turn`) на старте.

**Альтернатива (reused continuous + flag)** — отвергнута: smell-test «два совершенно разных runner-loop'а внутри одного класса с if'ами на mode» проваливается.

### Decision 2: `ImmersiveDomainRegistry` как Nest-сервис

Registry — единая точка истины «какие домены поддерживают immersive». Используется:
- top-supervisor: dynamic `domain` enum в `open_immersive_session` schema + список доменов в system prompt;
- `EarSessionRouter`: на `arm({mode:"immersive", domain})` берёт `sessionSpec` из registry;
- `EarSessionsModule`: на bind-success вызывает `sessionBegin(deviceId)` хук домена.

Contract:
```ts
interface ImmersiveDomainRegistration {
  name: string;                                  // kebab-case, домен
  sessionSpec: AgentSpec;                        // session-bound agent
  sessionBegin: (deviceId: string) => Promise<void> | void;  // entry-paint
  closeAliases?: string[];                       // additional voice triggers
}

interface ImmersiveDomainRegistry {
  register(reg: ImmersiveDomainRegistration): void;
  get(name: string): ImmersiveDomainRegistration | undefined;
  list(): string[];                              // sorted, for prompt + enum
}
```

Регистрация — в domain-module `OnApplicationBootstrap`:
```ts
this.registry.register({
  name: "shopping",
  sessionSpec: this.shoppingSessionSpec,
  sessionBegin: (deviceId) => this.paintEntry(deviceId),
});
```

**Альтернатива (статичный list-в-supervisor-promt)** — отвергнута: каждый новый immersive-домен требовал бы редактирования supervisor-spec. Registry даёт open/closed: добавил домен в свой module → top-supervisor его видит автоматом.

### Decision 3: `SessionAgentRunner` второй strategy `per-final-turn`

Текущий runner = single strategy «pause-check + terminal-check» (`continuous`/`regular` owned). Для immersive нужна другая semantics: каждый pushFinal = немедленный graph.invoke; нет pause-таймера, нет rolling-аккумуляции, нет terminal-check (close_immersive_session внутри turn'а решает release).

Внутренняя структура:
```ts
type RunnerStrategy = "continuous-finalize" | "per-final-turn";

// strategy selected from handle.mode:
//   continuous → continuous-finalize
//   immersive  → per-final-turn
```

Per-final-turn-loop:
```
pushFinal(text):
  if released: return
  if wakeWordOnly(text): return     // mirror existing filter
  setInFlight(true)
  cancel-prev-abort-if-any           // sequential, не interleave
  await agent.invoke({messages: [HumanMessage(text)]}, {ear_session: handle, ...})
  parse release from last messages (close_immersive_session → release-result)
  if release: releaseFromTool(reason)
  setInFlight(false)
```

`signalEnd(reason)` для per-final-turn НЕ запускает terminal-check (нечего finalize'ить — все мутации уже committed). Просто release с reason.

`forceTimeout()` остаётся (safety cap).

`onFinalAppend` / `onFlush` / pause-prompt — НЕ зовутся в per-final-turn.

### Decision 4: `inFlight`-aware silence timer

Silence cap 15s — про молчание пользователя, не про задержку LLM. Если agent invoke длится 3-5 сек, юзер за это время не молчит логически. Решение:

- `SessionAgentRunner` (per-final-turn strategy) экспонирует state через колбэк `onInFlightChange(inFlight: boolean)`.
- `SessionService.armSilenceTimer` для immersive-сессий учитывает: если `inFlight=true`, не запускает таймер. Когда runner сигналит `inFlight=false`, таймер взводится.
- Partial-transcripts продолжают reset'ить таймер как сейчас (`onPartial → armSilenceTimer`).

Имплементация — добавить `session.inFlight: boolean` + `setSilenceTimerInflight(sessionId, b)` API на `SessionService`. Runner вызывает на start/end invoke.

**Альтернатива (фиксированный grace 5s после finals)** — отвергнута: непредсказуемая задержка ответа из-за external LLM-latency.

### Decision 5: Новый `OverlayKind "immersive"` (не reuse `view`)

`kind: view` — пассивный list-view canvas (используется в shopping show_list/close_list_view). Immersive нужен визуально отличный stat — "I'm listening, list is live". Варианты:
- (a) переиспользовать `view` + protocol flag `live: true` — добавляет conditional в Ear render
- (b) новый `kind: immersive` — render-логика отдельная, list-view-update таргетит того же deviceId

(b) выбран: меньше conditional'ов в Ear-side render, чище intent в core-логе. List-view-update (`list_view_update`) остаётся протокол-агностиком — он живёт parallel-ом overlay-update.

### Decision 6: `close_immersive_session` — session-bound tool, не kernel-tool

Tool владеет release-логикой → должен иметь доступ к `EarSessionHandle.sessionId` через runner-context (`configurable.ear_session`). Это session-bound-tool pattern (как `finalize_note` / `discard_note` в notes-session-spec). Возвращает `SessionToolResult` с `release: true, reason: "user"`.

Размещение: в `shopping.tools.ts` (или новом `shopping.session-tools.ts`) и инжектится в `buildShoppingSessionSpec`. Каждый immersive-домен будет иметь свою копию tool'а (с одинаковой логикой) — позже можно вынести в kernel-helper `buildCloseImmersiveTool(router)`.

### Decision 7: Top-supervisor получает `open_immersive_session`

Tool регистрируется в `kernel/tools/` (как `open_continuous_session`). Schema:
```ts
const OpenImmersiveSessionDto = z.object({
  domain: z.enum([...registry.list()]),   // dynamic at module-init
  intent: z.string().optional(),
});
```

Тонкость: enum нужен в момент компиляции спека supervisor'а. Решение — supervisor-spec собирается **после** того как все domain-modules зарегистрировались в registry (`OnApplicationBootstrap` order). Если порядок неудобен — fallback: `domain: z.string()` + runtime-валидация в handler (`if (!registry.get(domain)) return {ok:false, reason:"unknown-domain"}`).

Реализация **runtime-validation** проще:
```ts
const dto = z.object({
  domain: z.string(),
  intent: z.string().optional(),
});
// handler:
const reg = registry.get(dto.domain);
if (!reg) return { ok: false, reason: "unknown-immersive-domain" };
return router.arm({ ownerSpec: reg.sessionSpec, mode: "immersive", intent: dto.intent });
```

Top-supervisor system-prompt включает блок:
```
Доступные immersive-домены (registry.list().join(", ")): shopping
Если пользователь говорит "погружаемся в X" / "давай в X" / "открой режим X" → open_immersive_session({domain: X, intent}).
```

Prompt компонуется на supervisor-bootstrap (registry уже зарегистрирован).

## ASCII Flow

```
   USER: "погружаемся в покупки"
       │
       ▼ regular session, final
   EarSessionsModule per-final → conversation.handleTurn
       │
       ▼ kernel-graph
   top-supervisor (LLM, haiku) sees intent → open_immersive_session({domain:"shopping"})
       │
       ▼
   router.arm({
     ownerSpec: registry.get("shopping").sessionSpec,
     mode: "immersive",
   })
       │
       ▼ arm_capture (terminates current short session)
   Ear → session_start (mode:immersive)
       │
       ▼ SessionService.start
        + vadEndpointSuppressed=true
        + silenceCapMs=15_000
        + isAsk=false
        + immersive=true (new flag)
        + spawns SessionAgentRunner(strategy="per-final-turn")
       │
       ▼ EarSessionsModule.bind-success
   registry.get("shopping").sessionBegin(deviceId)
        → show_list snapshot + overlay {kind:immersive}
       │
       ▼ ┌────────── IMMERSIVE LOOP ─────────────┐
         │  final "добавь молоко" →              │
         │    runner.pushFinal:                  │
         │      setInFlight(true)                │
         │      → shopping-session-spec.invoke   │
         │        → tool add_item("молоко")      │
         │           → list_view_update          │
         │           → overlay {success, ttl}    │
         │      setInFlight(false)               │
         │  silence-timer armed (15s)            │
         │                                       │
         │  final "купил молоко" →               │
         │    list_items → mark_bought → refresh │
         │                                       │
         │  final "закрой покупки" →             │
         │    close_immersive_session tool fires │
         │    → returns {release:true, reason:"user"}│
         │    → runner.releaseFromTool           │
         └───────────────────────────────────────┘
       │
       ▼ EarSessionsModule.onRunnerRelease
   sessions.terminateExternal(reason="user") → Ear session_end → idle overlay
```

## State Machine (per session)

```
 RESERVED ──── session_start ───▶ STARTED ─┐
                                            ├─▶ INFLIGHT (agent running)
                                            │       │
                                            │       └─ done ─▶ IDLE (silence timer armed)
                                            │
                       partial / new final ─┘                  │
                                                               │ silence cap 15s
                                            ◀──────────────────┘
                                            │
                                            └─▶ CLOSING ──▶ TERMINATED
                                                    ▲
                                                    │
                            close_immersive_session ┘
                            OR silence cap 15s
                            OR signalEnd (Ear-VAD timeout)
```

## Risks / Trade-offs

- **[Risk] Race: новый final приходит пока agent ещё invoke'ит предыдущий**
  → Mitigation: sequential queue. `pushFinal` ставит в FIFO; если уже inFlight — следующий тур ждёт. Простота > parallelism (shopping-команды быстрые).

- **[Risk] LLM зависает / падает в середине turn'а → inFlight остаётся true, silence-таймер не взводится → сессия живёт вечно**
  → Mitigation: hard timeout на agent.invoke (например 20s через AbortController). По timeout — `releaseWithError` + overlay error. + `forceTimeout()` safety cap (env-driven) тоже остаётся.

- **[Risk] Registry не успевает зарегистрировать домены к моменту build'а supervisor-spec'а**
  → Mitigation: `domain: z.string()` + runtime check + system-prompt компонуется в `OnApplicationBootstrap` (после registration phase). Если порядок ломается — fallback `z.string()` гарантирует не-крэш.

- **[Risk] Пользователь забывает закрыть сессию, silence cap снимает её в неожиданный момент**
  → Mitigation: overlay явно показывает immersive-state (отдельный kind). 15s — конфигурируемо через env. Если UX покажет что мало — увеличим.

- **[Risk] Wake-word не работает = нет escape-hatch если что-то идёт не так**
  → Mitigation: Ear-tap (физический жест) уже шлёт `session_end{reason:"user"}` → runner.signalEnd("user") → release. Это и есть escape.

- **[Risk] sessionBegin-hook падает → entry-paint не появляется**
  → Mitigation: wrap в try/catch в `EarSessionsModule.bind-handler`. Логируется, но сессия не падает.

- **[Trade-off] Wake-word внутри immersive отключён — нельзя одной фразой прыгнуть в другой домен**
  → Принято осознанно. UX-вариант (a) из обсуждения. Если потребуется (b) — добавим wake-парсинг внутри runner per-final-turn (отдельная change).

- **[Trade-off] Per-final-turn ставит LLM-call на каждый final shopping → дороже чем сейчас**
  → Сейчас supervisor-routing уже делает LLM-call на каждый final. Immersive экономит **один** call (top-supervisor) и оставляет domain-LLM-call. Чистый профит = -1 LLM-hop на турн.

## Migration Plan

- Не data-migration: режим живёт in-memory.
- Wire-change в `@vega/ear-protocol` (новый enum-variant) — Ear (Swift) и Core деплоятся согласованно (один коммит).
- Backward compat: `mode` опциональное в `session_start` — fallback "regular". Старые сессии не пересекаются с immersive.
- Rollback: revert change → `immersive` mode перестанет резервироваться (top-supervisor его не сможет вызвать); если в-полёте сессия — Ear получит unknown mode = trate as regular, silence cap defaults. Низкий риск.

## Open Questions

- Финальный config: `IMMERSIVE_SILENCE_CAP_MS` (default 15_000) — оставить в env или жёстко в коде как `CONTINUOUS_MODE_SILENCE_CAP_MS`?
  → Решение в task: env, но default const рядом с continuous.

- Per-final-turn invoke timeout — сколько ms?
  → Решение в task: 20_000 ms default, env-driven.

- Нужно ли logger.event `immersive_in_flight` в metrics?
  → Out of scope этой change; later observability pass.
