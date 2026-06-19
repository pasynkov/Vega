## Why

Заметки сейчас сохраняются под безымянными timestamp-файлами и невозможно быстро найти «ту самую заметку про идею проекта». Также нет универсального способа домену переспросить пользователя в течение хода — TTS не подключён, а supervisor работает one-shot. Эта правка вводит именование заметок и общий kernel-level примитив `ask_user`, который позволит любому домену задать вопрос через mac-ear оверлей и получить голосовой ответ синхронно, не разрывая ход.

## What Changes

- **BREAKING**: убираем `save_short_note` tool, `SaveShortNoteDto`, `NotesStorageService.saveNote()` и ветку короткой заметки из supervisor-промпта notes-домена. Все заметки идут через continuous flow.
- **BREAKING**: `open_continuous_session` tool/DTO получают обязательное поле `name` (UTF-8 строка). Storage стартует in-progress файл со схемой `<slug>_<timestamp>.md` сразу при открытии.
- Новый global kernel tool **`ask_user`** (`apps/core/src/conversation/kernel/tools/ask-user.tool.ts`): синхронно открывает Ear ask-session, рендерит вопрос в overlay caption, ждёт первый STT-final, возвращает результат вызывающему домену. По таймауту/тапу возвращает abort-сигнал.
- Новый Ear session-mode **`"ask"`** в `@vega/ear-protocol`. Single-final exit, `captureMs` timeout (default 8000), user tap = abort. Финал не идёт в `handleTurn`, маршрутизируется внутрь ask-session-handle.
- mac-ear: обрабатывает ask-mode (mic on, отображает overlay caption + hint, обрывает по tap, прокидывает abort/timeout).
- Notes domain: supervisor-prompt переписан под name-aware flow. Если имя в реплике — вызывает `open_continuous_session(name, intent)` сразу. Если нет — сначала `ask_user("Как назвать заметку?")`, потом `open_continuous_session(name=answer, intent)`. Abort/timeout → error-overlay, continuous не открывается.
- При старте continuous notes-сессии overlay показывает `kind=capturing` + `caption=<имя заметки>`, чтобы пользователь видел, какая заметка пишется.
- Старые timestamp-only файлы не мигрируем.

## Capabilities

### New Capabilities

(нет — расширяем существующие)

### Modified Capabilities

- `kernel-session-control-tools`: добавляется global tool `ask_user`; `open_continuous_session` получает обязательный `name`-параметр; `save_short_note` удаляется.
- `ear-protocol`: новый `SessionMode = "ask"` с single-final-exit семантикой.
- `mac-ear`: обработка ask-mode (mic gating, overlay caption pinned, user-tap abort, timeout abort).
- `vega-core`: notes-домен переписан под name-aware long-note flow; короткие заметки удалены; continuous overlay включает имя заметки.

## Impact

- **Code**:
  - `apps/core/src/conversation/kernel/tools/ask-user.tool.ts` (новый), `ask-user.dto.ts` (новый)
  - `apps/core/src/conversation/kernel/tools/open-continuous-session.{tool,dto}.ts` (расширение DTO + хэндлера)
  - `apps/core/src/conversation/sessions/ear-session-router.service.ts` (`openAskSession`)
  - `apps/core/src/conversation/sessions/ear-session-handle.ts` (ask-handle лайфсайкл)
  - `apps/core/src/conversation/ear/session/session.service.ts` (ask-mode гейтинг finals)
  - `apps/core/src/domains/notes/notes-storage.service.ts` (slug + name-aware in-progress, удалить `saveNote`)
  - `apps/core/src/domains/notes/notes.{agent,tools,dtos,module}.ts` (новый flow, удалить short-note)
  - `apps/core/src/conversation/overlay/overlay.service.ts` (caption-pinned режим без TTL, если нужно)
  - `packages/ear-protocol/src/schema.ts` (`SessionModeEnum` += `"ask"`, ack-сообщения)
  - `apps/mac-ear/...` (handling ask-mode на стороне устройства)
- **Tests**: round-trip protocol tests на ask-mode; integration test name-aware flow для notes; unit для slug.
- **Docs**: обновить project memory `project_kernel_session_control_tools.md`, `project_interactive_overlay_channel.md` после ship.
- **No DB migration**; старые заметки совместимы по чтению (имена опциональны на дисковом уровне).
