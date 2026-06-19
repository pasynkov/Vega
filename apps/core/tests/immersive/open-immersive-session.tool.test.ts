import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { buildOpenImmersiveSessionTool } from "../../src/conversation/kernel/tools/open-immersive-session.tool";
import { ImmersiveDomainRegistry } from "../../src/conversation/immersive/immersive-domain.registry";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";

const spec: AgentSpec = {
  name: "shopping-session",
  description: "",
  examples: [],
  systemPrompt: "",
  tools: [],
  enabled: true,
};

async function runHandler(tool: ReturnType<typeof buildOpenImmersiveSessionTool>, dto: unknown): Promise<unknown> {
  const raw = await tool.invoke(dto as any);
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

describe("open_immersive_session tool", () => {
  it("returns unknown-immersive-domain when domain not registered", async () => {
    const registry = new ImmersiveDomainRegistry();
    const arm = vi.fn();
    const router = { arm } as any;
    const tool = buildOpenImmersiveSessionTool(router, registry);
    const result = (await runHandler(tool, { domain: "missing" })) as { ok: boolean; reason: string };
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("unknown-immersive-domain");
    expect(arm).not.toHaveBeenCalled();
  });

  it("known domain calls router.arm with mode=immersive + correct ownerSpec", async () => {
    const registry = new ImmersiveDomainRegistry();
    registry.register({ name: "shopping", sessionSpec: spec, sessionBegin: () => {} });
    const arm = vi.fn(() => ({ ok: true, deviceId: "dev-1", mode: "immersive" }));
    const router = { arm } as any;
    const tool = buildOpenImmersiveSessionTool(router, registry);
    const result = (await runHandler(tool, { domain: "shopping", intent: "погружение" })) as Record<string, unknown>;
    expect(arm).toHaveBeenCalledTimes(1);
    expect(arm.mock.calls[0][0]).toMatchObject({
      mode: "immersive",
      intent: "погружение",
    });
    expect(arm.mock.calls[0][0].ownerSpec).toBe(spec);
    expect(result.ok).toBe(true);
    expect(result.domain).toBe("shopping");
  });
});
