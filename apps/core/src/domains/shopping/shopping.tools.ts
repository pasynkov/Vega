import { makeTool } from "../../conversation/kernel/tool-factory";
import type { AgentTool } from "../../conversation/kernel/agent.types";
import { SessionService } from "../../conversation/ear/session/session.service";
import { OverlayService } from "../../conversation/overlay/overlay.service";
import { ListViewService } from "../../conversation/overlay/list-view.service";
import { EarRegistry } from "../../conversation/ear/ear.registry";
import { ShoppingStorageService } from "./shopping-storage.service";
import {
  AddItemDto,
  CloseImmersiveSessionDto,
  DeleteItemDto,
  MarkBoughtDto,
  ShoppingIntentDto,
} from "./shopping.dtos";
import type { ListView } from "@vega/ear-protocol";

export interface ShoppingToolBundle {
  supervisorTools: AgentTool[];
  sessionTools: AgentTool[];
}

const VIEW_TITLE = "Список покупок";

function resolveDeviceId(
  ctx: { sessionId?: string; earSession?: { deviceId?: string } },
  sessions: SessionService,
  earRegistry: EarRegistry,
): string | undefined {
  return (
    ctx.earSession?.deviceId
    ?? (ctx.sessionId ? sessions.getDeviceIdForSession(ctx.sessionId) : undefined)
    ?? earRegistry.list()[0]?.deviceId
  );
}

function buildSnapshot(
  storage: ShoppingStorageService,
  items: Awaited<ReturnType<ShoppingStorageService["listLive"]>>,
): ListView {
  return {
    title: VIEW_TITLE,
    items: items.map((it) => ({
      id: it.id,
      label: storage.formatLabel(it),
      done: it.status === "bought",
    })),
    open: true,
  };
}

// After any mutation we always refresh the list view, even if it
// wasn't open — the result of a shopping command IS the current list
// shown below the success message. The orb shows `kind: success +
// hint`; the list section shows the live snapshot.
async function refreshAlways(
  deviceId: string | undefined,
  storage: ShoppingStorageService,
  listView: ListViewService,
  origin: string,
): Promise<void> {
  if (!deviceId) return;
  const items = await storage.listLive();
  listView.refresh(deviceId, buildSnapshot(storage, items), origin);
}

export function buildShoppingTools(
  storage: ShoppingStorageService,
  overlay: OverlayService,
  listView: ListViewService,
  sessions: SessionService,
  earRegistry: EarRegistry,
): ShoppingToolBundle {
  const addItem = makeTool({
    dto: AddItemDto,
    name: "add_item",
    description:
      "Добавить позицию в список покупок (или обновить количество/единицу/заметку существующей pending позиции с тем же именем). Использует case-insensitive matching. quantity/unit/note могут отсутствовать.",
    handler: async (dto, ctx) => {
      const saved = await storage.addOrUpdatePending({
        name: dto.name,
        quantity: dto.quantity ?? null,
        unit: dto.unit ?? null,
        note: dto.note ?? null,
      });
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      // Emit the orb success FIRST so the icon flips immediately, then
      // the list refresh — the Ear applies them in the same UI tick
      // and the user sees "Добавил" with the list already populated.
      if (deviceId) {
        overlay.set(
          deviceId,
          { kind: "success", hint: "Добавил", sound: "ack_done" },
          { ttl: 1500 },
          "shopping:add_item_success",
        );
      }
      await refreshAlways(deviceId, storage, listView, "shopping:add_item");
      return { ok: true, id: saved.id, name: saved.name };
    },
  });

  const listItems = makeTool({
    dto: ShoppingIntentDto,
    name: "list_items",
    description:
      "Вернуть текущие позиции в списке (без удалённых). Используй ПЕРЕД mark_bought/delete_item чтобы найти id по имени. intent — короткое описание зачем.",
    handler: async () => {
      const items = await storage.listLive();
      return items.map((it) => ({
        id: it.id,
        name: it.name,
        status: it.status,
        quantity: it.quantity,
        unit: it.unit,
        note: it.note,
      }));
    },
  });

  const markBought = makeTool({
    dto: MarkBoughtDto,
    name: "mark_bought",
    description:
      "Отметить позицию как купленную. Сначала вызови list_items чтобы получить id. Идемпотентен.",
    handler: async (dto, ctx) => {
      const result = await storage.markBought(dto.id);
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      if (deviceId) {
        overlay.set(
          deviceId,
          { kind: "success", hint: "Отметил", sound: "ack_done" },
          { ttl: 1500 },
          "shopping:mark_bought_success",
        );
      }
      await refreshAlways(deviceId, storage, listView, "shopping:mark_bought");
      return { ok: true, changed: result.changed };
    },
  });

  const deleteItem = makeTool({
    dto: DeleteItemDto,
    name: "delete_item",
    description:
      "Удалить позицию из списка (soft delete). Сначала вызови list_items чтобы получить id.",
    handler: async (dto, ctx) => {
      const result = await storage.softDelete(dto.id);
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      if (deviceId) {
        overlay.set(
          deviceId,
          { kind: "success", hint: "Удалил", sound: "ack_done" },
          { ttl: 1500 },
          "shopping:delete_item_success",
        );
      }
      await refreshAlways(deviceId, storage, listView, "shopping:delete_item");
      return { ok: true, changed: result.changed };
    },
  });

  const clearList = makeTool({
    dto: ShoppingIntentDto,
    name: "clear_list",
    description:
      "Очистить весь список (soft delete всех живых позиций, включая pending и bought).",
    handler: async (_dto, ctx) => {
      const result = await storage.clearAllLive();
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      if (deviceId) {
        overlay.set(
          deviceId,
          { kind: "success", hint: "Очистил список", sound: "ack_done" },
          { ttl: 1500 },
          "shopping:clear_list_success",
        );
      }
      await refreshAlways(deviceId, storage, listView, "shopping:clear_list");
      return { ok: true, cleared: result.count };
    },
  });

  const showList = makeTool({
    dto: ShoppingIntentDto,
    name: "show_list",
    description:
      "Показать пользователю список покупок (открыть list-view оверлей с текущими позициями). Используй когда пользователь просит показать что в списке.",
    handler: async (_dto, ctx) => {
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      if (!deviceId) return { ok: false, reason: "no-active-device" };
      const items = await storage.listLive();
      const snapshot = buildSnapshot(storage, items);
      const dispatched = listView.refresh(deviceId, snapshot, "shopping:show_list");
      overlay.set(deviceId, { kind: "view" }, {}, "shopping:show_list");
      return { ok: true, dispatched, items: items.length };
    },
  });

  const closeListView = makeTool({
    dto: ShoppingIntentDto,
    name: "close_list_view",
    description:
      "Закрыть list-view оверлей со списком покупок. Используй когда пользователь явно говорит закрыть/убери.",
    handler: async (_dto, ctx) => {
      const deviceId = resolveDeviceId(ctx, sessions, earRegistry);
      if (!deviceId) return { ok: false, reason: "no-active-device" };
      const dispatched = listView.close(deviceId, "tool");
      return { ok: true, dispatched };
    },
  });

  // Session-bound tool for immersive mode. Returns a SessionToolResult
  // marker so SessionAgentRunner (per-final-turn strategy) releases the
  // session via the standard tool-release path → EarSessionsModule
  // terminates externally.
  const closeImmersiveSession = makeTool({
    dto: CloseImmersiveSessionDto,
    name: "close_immersive_session",
    description:
      "Закрой текущую immersive-сессию домена и верни управление верхнему супервизору. Вызывай когда пользователь явно говорит \"закрой\" / \"хватит\" / \"выходим\" / \"закончил\" про этот домен. intent — короткое описание для логов.",
    handler: async () => ({ release: true, reason: "user" }),
  });

  return {
    supervisorTools: [addItem, listItems, markBought, deleteItem, clearList, showList, closeListView],
    sessionTools: [
      addItem,
      listItems,
      markBought,
      deleteItem,
      clearList,
      showList,
      closeListView,
      closeImmersiveSession,
    ],
  };
}
