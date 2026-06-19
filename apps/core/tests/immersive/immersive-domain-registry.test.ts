import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ImmersiveDomainRegistry } from "../../src/conversation/immersive/immersive-domain.registry";
import type { AgentSpec } from "../../src/conversation/kernel/agent.types";

const spec: AgentSpec = {
  name: "spec",
  description: "",
  examples: [],
  systemPrompt: "",
  tools: [],
  enabled: true,
};

describe("ImmersiveDomainRegistry", () => {
  it("register / get / list", () => {
    const reg = new ImmersiveDomainRegistry();
    reg.register({ name: "shopping", sessionSpec: spec, sessionBegin: () => {} });
    expect(reg.get("shopping")?.name).toBe("shopping");
    expect(reg.list()).toEqual(["shopping"]);
  });

  it("list is sorted", () => {
    const reg = new ImmersiveDomainRegistry();
    reg.register({ name: "todo", sessionSpec: spec, sessionBegin: () => {} });
    reg.register({ name: "alpha", sessionSpec: spec, sessionBegin: () => {} });
    reg.register({ name: "notes", sessionSpec: spec, sessionBegin: () => {} });
    expect(reg.list()).toEqual(["alpha", "notes", "todo"]);
  });

  it("duplicate name throws", () => {
    const reg = new ImmersiveDomainRegistry();
    reg.register({ name: "shopping", sessionSpec: spec, sessionBegin: () => {} });
    expect(() =>
      reg.register({ name: "shopping", sessionSpec: spec, sessionBegin: () => {} }),
    ).toThrow(/already registered/);
  });

  it("empty name rejected", () => {
    const reg = new ImmersiveDomainRegistry();
    expect(() => reg.register({ name: "", sessionSpec: spec, sessionBegin: () => {} })).toThrow();
  });

  it("get returns undefined for unknown", () => {
    const reg = new ImmersiveDomainRegistry();
    expect(reg.get("unknown")).toBeUndefined();
  });
});
