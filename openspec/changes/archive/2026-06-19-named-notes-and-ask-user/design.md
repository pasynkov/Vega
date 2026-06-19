## Context

Сегодня:

- Заметки сохраняются под безымянными timestamp-файлами; пользователь не может «открой заметку про X».
- Continuous-mode сессии для длинной диктовки уже работают (notes domain → `open_continuous_session` → `EarSessionRouter.arm` → `arm_capture` → bound sub-agent runner).
- TTS не подключён. Единственный канал «UI-вывода» — overlay (`overlay_update`) + локальные cue на Ear.
- Supervisor работает одношагово: один user turn → выбор домена → один agent invoke → конец turn'а. Кросс-turn состояния «жду ответ от пользователя» нет.

Хотим:

1. Имя в имени файла (`<slug>_<timestamp>.md`).
2. Если имя в реплике — открыть continuous сразу.
3. Если имени нет — переспросить голосом + овлей и продолжить со встречной реплики.
4. Универсальный примитив «задать вопрос с балалайки» — следующие домены тоже смогут переспрашивать.

Ограничения:

- Не разрывать существующий continuous-flow notes (он живёт и хорошо работает).
- `handleTurn` сериализован per session. Если делаем sync-в-tool ожидание ответа, ответ НЕ должен идти через `handleTurn`, иначе deadlock.
- Mac-ear уже знает про `regular` и `continuous` — добавляем третий mode без срыва обратной совместимости (SwiftCodable enum уже tolerant к unknown).

## Goals / Non-Goals

**Goals:**

- Добавить kernel-tool `ask_user(question, hint?, captureMs?)` синхронно блокирующий sub-agent turn до получения первого STT-final.
- Ввести Ear session-mode `ask` с single-final-exit и safety cap.
- Переписать notes-flow на name-aware (kill short-note tool, переименовать файлы по имени).
- Подсветить имя заметки в overlay caption во время continuous-записи.

**Non-Goals:**

- Поиск/листинг существующих заметок (`open note about X`) — отдельная фича.
- TTS / голосовой ответ агента.
- Миграция старых timestamp-only файлов.
- Использование `ask_user` другими доменами в этом change (механизм общий, но включаем только notes-flow).
- Контроль конфликтов имён через UI (timestamp гарантирует уникальность).
- Multi-question dialogs / forms (один вопрос → один ответ).

## Decisions

### D1. Sync tool с side-channel сессией vs. async pending-state через supervisor

**Решение**: sync tool. `ask_user` блокирует sub-agent turn на `Promise<AskSessionOutcome>`. Ear открывает отдельную ask-сессию, её final НЕ идёт в `handleTurn`.

**Альтернатива (отклонена)**: async через `status="awaiting"` в supervisor + pending-state. Сложнее в supervisor router prompt'е, ломает «domain-level flow», заставляет supervisor помнить про текущий slot.

**Почему sync ОК с handleTurn**: ask-session использует ту же модель owned-session, что и continuous (см. `EarSessionRouter.bindOnSessionStart` + `ownerOf`). Final роутится в session-binding handle напрямую, минуя `handleTurn` — это уже существующий путь, просто новая категория владельца («kernel ask-handle» вместо «sub-agent runner»).

### D2. Сессия ask vs reuse continuous

**Решение**: новый mode `"ask"` в `SessionModeEnum`. Семантика single-final-exit на Core (на первый final → `session_end endpoint`), suppress VAD на Ear, captureMs локальный safety cap.

**Альтернатива**: short regular session, кастомный `EarSessionsModule` хук «возьми первый final и оборви». Хуже: трудно отличить ask от обычного regular, не понятен UX для VAD/captureMs, captureMs регулярки управляется конфигом сервиса.

### D3. Расположение handle для ask

**Решение**: `EarSessionRouter.openAskSession({deviceId, captureMs}): Promise<AskSessionOutcome>`. Внутри роутер:

- Резервирует ask на deviceId (как continuous), но `ownerSpec = null`, вместо этого пишет в новую map `askHandles: Map<deviceId, Deferred<AskSessionOutcome>>`.
- Эмитит `arm_capture { mode: "ask", captureMs }`.
- На `session_start mode:"ask"` помечает ownership как ask (special-case в `bindOnSessionStart`).
- На `final_transcript` → завершает сессию `endpoint`, резолвит deferred `{kind:"answer", text}`.
- На `session_end timeout|user|vad` от Ear или Core silence cap → резолвит соответствующим outcome.
- Также setTimeout(captureMs + 2_000) как backup на случай если ничего не пришло (защита от подвисших defrred).

Public API в роутере: `openAskSession({deviceId, captureMs})`. Использовать его умеет только tool `ask_user` (один call site).

### D4. Overlay и cue для ask

**Решение**: tool сам красит overlay:

1. До `openAskSession`: `overlay.set({kind:"listening", caption:question, hint, sound:"cue_listen"})`.
2. После resolve: `overlay.set({kind:"idle"})` ровно один раз.

Локальный `cue_listen` на Ear играется ещё и в момент `arm_capture mode:"ask"` (mirror continuous→ack_continue). Это даёт мгновенный аудио feedback ДО первого `overlay_update` (которое уже Core пошлёт чуть раньше — но локальный cue гарантирует слышимый старт).

`cue_listen` добавляется в `OverlaySoundEnum`. На Ear маппим в существующий звук (например `Tink.aiff`).

### D5. Filename schema

```
<slug(name)>_<YYYY-MM-DD_HH-mm-ss>.md
```

slug:

```ts
function slug(name: string): string {
  const lowered = name.toLowerCase();
  const dashed = lowered.replace(/\s+/g, "-");
  const stripped = dashed.replace(/[^\p{L}\p{N}-]+/gu, "");
  const trimmed = stripped.replace(/^-+|-+$/g, "");
  const clamped = trimmed.slice(0, 60);
  return clamped.length > 0 ? clamped : "note";
}
```

Все Unicode letters/digits проходят (важно для кириллицы). Никакой транслитерации.

Timestamp гарантирует уникальность → коллизий по имени нет, никакого `-2` суффикса.

### D6. Имя кочует через router в overlay

**Решение**: `ArmOptions` расширяется `artifactName?: string` и `intent?: string`. Внутри `arm()` overlay bridge паинт получает `caption: artifactName` для `continuous` mode. Sub-agent runner не использует `artifactName` напрямую — он живёт в `OwnedSession.artifactName` для логов/диагностики.

`NotesStorageService` тоже должен знать имя для in-progress файла. Передаём через session-bound state: после `bindOnSessionStart` runner получает `artifactName` и прокидывает в storage при первом appendChunk (или при старте). Текущий `appendChunk(sessionId, chunk)` ленив (создаёт файл при первом не-пустом chunk'е). Изменим: `notes-storage` экспортит `startNamed(sessionId, name)` который сразу пишет header + кладёт path в `inProgress`. Notes session-bound runner вызывает `startNamed` при `onPushFinal` если ещё нет path'а — name берётся из owned ownership.

Альтернатива: создавать файл из `open_continuous_session` tool до `arm` (до того, как поедет session_start). Хуже, потому что sessionId ещё неизвестен, а map в storage кодирована по sessionId.

### D7. Удаление save_short_note

Полное удаление: `save_short_note` tool, DTO, ветка из prompt'а. `NotesStorageService.saveNote()` тоже убираем. Прошлые саженные файлы остаются на диске — никто их не трогает.

Migration не требуется потому что:

- Notes — single-user, single-machine.
- Старые timestamp-only имена остаются валидными filename'ами.
- Никакой код не читает их (read-path notes ещё нет).

## Risks / Trade-offs

[Risk] Sync block sub-agent turn → если user не отвечает и captureMs пропал, agent timer'ы могут зашалить.
→ Mitigation: tool возвращает `{ok:false, reason:"timeout"}` через 8 s + 2 s backup → агент моментально продолжает; `EarSessionRouter.openAskSession` гарантированно резолвит deferred.

[Risk] Race: пока ask-session открывается, прилетает второй wake/Final.
→ Mitigation: ask-session использует тот же reservations механизм что continuous. Wake во время активной ask отрицается (одна сессия на Ear). Wake во время резервации (между tool-call и session_start) — же же window что у continuous, известный risk, не новый.

[Risk] STT-final некачественный («мм... ну запиши как-нибудь»).
→ Mitigation: agent сам валидирует ответ — он видит answer string и может ре-ask или принять как есть. Слов "отмена"/"не надо" хендлим в системном prompt'е (agent дискорнет и зовёт `update_overlay` error).

[Risk] Ask-session не подходит для batch-вопросов («имя? а ещё интент?»).
→ Mitigation: вне scope. Один tool call — один вопрос. Множественные — отдельный change.

[Risk] Filename длинная UTF-8 в кириллице → 60 chars *bytes* ≠ 60 chars *symbols* на FS.
→ Mitigation: clamp по `.slice(60)` — это **по code units (UTF-16)**, не байтам. На macOS HFS+/APFS лимит ~255 байт UTF-8; 60 UTF-16 code units → max ~180 байт, без проблем.

[Risk] Sub-agent runner на continuous-сессии не знает имя для названия файла.
→ Mitigation: D6 — имя кочует через `ownership.artifactName`. Runner прокидывает в `NotesStorageService.startNamed(sessionId, name)` ровно один раз перед первым `appendChunk`.

[Trade-off] `ask_user` блокирует supervisor pipeline (handleTurn серилизация per session). Если пользователь пол-сек думает над именем — следующая команда «вега что у меня в списке покупок» подвиснет.
→ Acceptable: captureMs ≤ 10 s, и пока ask активен пользователь не должен дергать другие команды (одна Ear, один user). Не критично.

## Migration Plan

Один atomic ship:

1. Расширить `@vega/ear-protocol` schema (`SessionMode += "ask"`, `OverlaySoundEnum += "cue_listen"`, `ArmCaptureMessage.captureMs?`).
2. Расширить `EarSessionRouter.arm` + новый `openAskSession`.
3. Добавить `buildAskUserTool` в `kernel/tools/`.
4. Расширить `buildOpenContinuousSessionTool` — обязательный `name`.
5. Переписать `notes` domain (storage, agent prompt, tools bundle); удалить `save_short_note` тулы.
6. Расширить mac-ear: `SessionMode.ask`, ArmCapture.captureMs, ask lifecycle.
7. Тесты round-trip (protocol), unit (slug), integration (named flow, ask flow).
8. Ship одним PR.

Rollback: revert PR. Никаких миграций состояния не было, старые файлы на диске не трогали.

## Open Questions

(закрыты в explore)

- ~~Timeout ask → fallback name vs abort?~~ → **abort + error overlay**.
- ~~Cancel keywords?~~ → agent сам решает на основе answer string.
- ~~ask_user намещение?~~ → `conversation/kernel/tools/ask-user.tool.ts`.
- ~~Имя в caption continuous?~~ → да, `caption: name`.
- ~~Migration old files?~~ → не делаем.
