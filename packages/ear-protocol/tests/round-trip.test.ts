import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CoreToEarMessageSchema,
  EarToCoreMessageSchema,
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
  "play_cue_wake",
  "play_cue_endpoint",
  "play_cue_error",
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
