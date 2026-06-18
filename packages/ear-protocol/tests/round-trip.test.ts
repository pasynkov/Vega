import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CoreToEarMessageSchema,
  EarToCoreMessageSchema,
  ListViewSchema,
  ListViewUpdateMessageSchema,
  OverlayStateSchema,
  OverlayUpdateMessageSchema,
  encodeAudioFrame,
  decodeAudioFrame,
  sessionShortIdFromUuid,
} from "../src/index";

const fixturesPath = join(__dirname, "..", "fixtures", "examples.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8")) as Record<string, unknown>;

const earKeys = ["register", "wake_detected", "session_start", "ear_session_end"] as const;
const coreKeys = [
  "ack",
  "wake_ack",
  "wake_ack_yield",
  "partial_transcript",
  "final_transcript",
  "overlay_update_listening",
  "overlay_update_capturing",
  "overlay_update_thinking",
  "overlay_update_processing",
  "overlay_update_success",
  "overlay_update_error",
  "overlay_update_idle",
  "overlay_update_view",
  "list_view_update_open",
  "list_view_update_empty",
  "list_view_update_close",
  "core_session_end",
  "core_session_end_with_detail",
] as const;

describe("Ear -> Core fixtures", () => {
  for (const key of earKeys) {
    it(`${key} round-trips through Zod`, () => {
      const payload = fixtures[key];
      const parsed = EarToCoreMessageSchema.parse(payload);
      const reserialized = JSON.parse(JSON.stringify(parsed));
      expect(reserialized).toEqual(payload);
    });
  }
});

describe("Core -> Ear fixtures", () => {
  for (const key of coreKeys) {
    it(`${key} round-trips through Zod`, () => {
      const payload = fixtures[key];
      const parsed = CoreToEarMessageSchema.parse(payload);
      const reserialized = JSON.parse(JSON.stringify(parsed));
      expect(reserialized).toEqual(payload);
    });
  }
});

describe("session_start userId is required", () => {
  it("fails when userId is omitted", () => {
    const bad = { ...(fixtures.session_start as Record<string, unknown>) };
    delete (bad as Record<string, unknown>).userId;
    const result = EarToCoreMessageSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe("overlay_update bounds", () => {
  it("rejects `wake` in state.sound", () => {
    const result = OverlayStateSchema.safeParse({ kind: "listening", sound: "wake" });
    expect(result.success).toBe(false);
  });

  it("accepts every overlay kind including view", () => {
    const kinds = ["idle", "listening", "capturing", "thinking", "processing", "success", "error", "view"];
    for (const kind of kinds) {
      const result = OverlayStateSchema.safeParse({ kind });
      expect(result.success).toBe(true);
    }
  });

  it("rejects hint longer than 120 chars", () => {
    const result = OverlayStateSchema.safeParse({
      kind: "thinking",
      hint: "x".repeat(121),
    });
    expect(result.success).toBe(false);
  });

  it("rejects caption longer than 240 chars", () => {
    const result = OverlayStateSchema.safeParse({
      kind: "capturing",
      caption: "x".repeat(241),
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive seq", () => {
    const result = OverlayUpdateMessageSchema.safeParse({
      type: "overlay_update",
      seq: 0,
      state: { kind: "idle" },
    });
    expect(result.success).toBe(false);
  });
});

describe("list_view_update", () => {
  it("rejects negative seq", () => {
    const result = ListViewUpdateMessageSchema.safeParse({
      type: "list_view_update",
      seq: 0,
      view: { items: [], open: false },
    });
    expect(result.success).toBe(false);
  });

  it("rejects items array longer than 200", () => {
    const items = Array.from({ length: 201 }, (_, i) => ({
      id: `${i}`,
      label: `item ${i}`,
      done: false,
    }));
    const result = ListViewSchema.safeParse({ items, open: true });
    expect(result.success).toBe(false);
  });

  it("accepts an empty open snapshot", () => {
    const result = ListViewSchema.safeParse({ items: [], open: true });
    expect(result.success).toBe(true);
  });

  it("rejects label longer than 240 chars", () => {
    const result = ListViewSchema.safeParse({
      items: [{ id: "a", label: "x".repeat(241), done: false }],
      open: true,
    });
    expect(result.success).toBe(false);
  });
});

describe("play_cue is removed", () => {
  it("does not parse as a Core->Ear message anymore", () => {
    const result = CoreToEarMessageSchema.safeParse({ type: "play_cue", cue: "endpoint" });
    expect(result.success).toBe(false);
  });
});

describe("binary audio frame", () => {
  it("encodes and decodes with the same session short id and payload", () => {
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const wire = encodeAudioFrame(sessionId, payload);
    const { sessionShortId, payload: decoded } = decodeAudioFrame(wire);
    expect(sessionShortId).toBe(sessionShortIdFromUuid(sessionId));
    expect(Array.from(decoded)).toEqual(Array.from(payload));
  });

  it("rejects a frame shorter than the header", () => {
    expect(() => decodeAudioFrame(new Uint8Array(4))).toThrow();
  });
});
