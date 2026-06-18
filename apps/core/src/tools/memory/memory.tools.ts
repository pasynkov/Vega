import { makeTool } from "../../conversation/kernel/tool-factory";
import type { AgentTool } from "../../conversation/kernel/agent.types";
import {
  MemoryDeleteDto,
  MemorySearchDto,
  MemoryUpdateDto,
  MemoryWriteDto,
} from "./memory.dtos";
import type { MemoryService } from "./memory.service";

export function buildMemoryTools(svc: MemoryService): AgentTool[] {
  const searchTool = makeTool({
    dto: MemorySearchDto,
    name: "memory_search",
    description: "Find existing facts matching the query. Use BEFORE writing to avoid duplicates.",
    handler: async (dto) => {
      const rows = await svc.search(dto.query, { type: dto.type });
      return {
        found: rows.length,
        items: rows.map((r) => ({ id: r.id, content: r.content, type: r.type, tags: r.tags })),
      };
    },
  });

  const writeTool = makeTool({
    dto: MemoryWriteDto,
    name: "memory_write",
    description: "Persist a NEW fact. Call memory_search first; prefer memory_update if a near-duplicate exists.",
    handler: async (dto) => {
      const result = await svc.write(dto.content, dto.type, dto.tags);
      return result;
    },
  });

  const updateTool = makeTool({
    dto: MemoryUpdateDto,
    name: "memory_update",
    description: "Replace the content of an existing fact (use when revising an outdated entry).",
    handler: async (dto) => {
      const updated = await svc.update(dto.id, dto.content);
      return { id: updated.id, content: updated.content };
    },
  });

  const deleteTool = makeTool({
    dto: MemoryDeleteDto,
    name: "memory_delete",
    description: "Remove a fact by id (rare; use only when the user explicitly asks to forget).",
    handler: async (dto) => {
      await svc.delete(dto.id);
      return { id: dto.id, deleted: true };
    },
  });

  return [searchTool, writeTool, updateTool, deleteTool];
}
