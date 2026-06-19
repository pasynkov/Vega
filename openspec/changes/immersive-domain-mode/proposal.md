## Why

Сейчас каждый STT-final проходит через top-supervisor (kernel-graph + LLM-decision), который роутит реплику в нужный домен. Когда пользователь сидит в одном домене и делает серию команд («добавь молоко», «купил хлеб», «удали картошку»), верхний LLM-роутинг — лишний слой: домен уже известен, реплики однотипны. Нужен режим «погружения» — длинная Ear-сессия, привязанная к session-spec домена, в которой finals идут **напрямую** в domain-агента, минуя верхний роутер. Параллельная задача — единый паттерн для будущих доменов, где UX = «зашёл и сидишь».

## What Changes

- **Новый `SessionMode`: `immersive`** в `@vega/ear-protocol` (TS + Swift). Параллельно с `regular | continuous | ask`.
- **Новый `OverlayKind`: `immersive`** в `@vega/ear-protocol` (TS + Swift). Визуальный индикатор live-listening поверх dynamic-контента (список / live caption).
- **Kernel-tool `open_immersive_session({domain, intent?})`** — живёт у **top-supervisor**, не у domain-supervisor. Schema `domain` — `z.enum([...registry.list()])`.
- **`ImmersiveDomainRegistry`** — новый Nest-сервис. Каждый immersive-capable домен на bootstrap регистрирует `{name, sessionSpec, sessionBegin(deviceId)}`. Top-supervisor получает список доступных доменов в prompt динамически из registry.
- **`SessionAgentRunner`: второй режим `per-final-turn`**. В отличие от continuous (notes-style: flush-hook накопление + finalize-решение), каждый pushFinal = один graph.invoke над session-spec. Tools fires inline, ход заканчивается. Между finals — idle paint, sessionBegin-state.
- **Shopping: `shopping-session-spec`** (отдельный AgentSpec рядом с supervisor-spec через `buildShoppingSessionSpec`). 95% копия supervisor-prompt + правило про `close_immersive_session` («закрой покупки», «хватит», «выходим»).
- **Shopping: `close_immersive_session`** — session-bound tool, переводит runner в release → session terminates.
- **`sessionBegin(deviceId)` hook** для shopping красит entry: `show_list` snapshot + overlay `{kind: immersive}`.
- **Silence cap 15s** для immersive (полного молчания, partial обнуляет таймер). Таймер ставится на **паузу пока agent в полёте** (новый флаг `inFlight` на runner; `armSilenceTimer` его учитывает).
- **Wake-word внутри immersive не парсится** (continuous-style suppression). Выход только через `close_immersive_session` или silence cap.
- **Top-supervisor prompt extension**: правило «если пользователь сказал „погружаемся в X“ / „давай в X“ / „открой режим X“ где X — один из зарегистрированных immersive-доменов → `open_immersive_session({domain: X})`».

## Capabilities

### New Capabilities
- `immersive-mode`: новый Ear-session-режим погружения в домен. Покрывает: SessionMode/OverlayKind delta, ImmersiveDomainRegistry contract, SessionAgentRunner per-final-turn режим, exit-семантика (voice tool / silence cap / inFlight pause), kernel tool `open_immersive_session`.

### Modified Capabilities
- `shopping-domain`: добавляется session-spec (`buildShoppingSessionSpec`), tool `close_immersive_session`, sessionBegin-hook, регистрация в `ImmersiveDomainRegistry`. Supervisor-spec НЕ трогаем.
- `ear-protocol`: новый `SessionMode "immersive"`, новый `OverlayKind "immersive"`. Fixtures + RoundTripTests обновляются.
- `supervisor`: top-supervisor получает `open_immersive_session` tool и prompt-правило про immersive-intent.
- `conversation`: `SessionAgentRunner` второй режим работы, `EarSessionRouter.arm` принимает `mode: "immersive"`, `SessionService` понимает immersive (silence cap 15s по умолчанию, vadEndpointSuppressed=true как у continuous).

## Impact

- **Code**:
  - `packages/ear-protocol/src/schema.ts`, fixtures, Swift mirror, round-trip tests.
  - `apps/core/src/conversation/sessions/ear-session-router.service.ts` — поддержка `immersive` mode в `arm`.
  - `apps/core/src/conversation/sessions/session-agent-runner.service.ts` — новый mode `per-final-turn`.
  - `apps/core/src/conversation/ear/session/session.service.ts` — `immersive` mode setup (silence cap 15s, vad-suppress), `inFlight`-aware silence timer.
  - `apps/core/src/conversation/kernel/tools/open-immersive-session.{dto,tool}.ts` — новые файлы.
  - `apps/core/src/conversation/immersive/immersive-domain.registry.ts` — новый сервис (или в `sessions/`).
  - `apps/core/src/domains/shopping/shopping.agent.ts` — `buildShoppingSessionSpec`.
  - `apps/core/src/domains/shopping/shopping.tools.ts` — `close_immersive_session` tool.
  - `apps/core/src/domains/shopping/shopping-agent.service.ts` + `shopping.module.ts` — bootstrap-регистрация в registry.
  - top-supervisor spec и prompt — добавление tool + intent-rule.
- **Protocol**: новый `SessionMode` и `OverlayKind` — minor wire change, Ear (Swift) и Core должны обновиться согласованно. Не breaking, добавление enum-вариантов.
- **No data migration** — режим живёт только in-memory в session/runner state.
- **Tests**: новый e2e сценарий immersive-flow (arm → finals → tools fire → close → terminate), unit-тесты на registry + runner per-final-turn mode + inFlight-pause silence timer.
