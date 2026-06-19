import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AckMessageSchema,
  ArmCaptureMessageSchema,
  CoreSessionEndMessageSchema,
  EarSessionEndMessageSchema,
  EventName,
  FinalTranscriptMessageSchema,
  ListViewSchema,
  ListViewUpdateMessageSchema,
  OverlayStateSchema,
  OverlayUpdateMessageSchema,
  PartialTranscriptMessageSchema,
  RegisterMessageSchema,
  SessionModeChangeMessageSchema,
  SessionStartMessageSchema,
  WakeAckMessageSchema,
  WakeDetectedMessageSchema,
} from "../src/index";

const fixturesPath = join(__dirname, "..", "fixtures", "examples.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf-8")) as Record<string, unknown>;

const cases = [
  { name: "register", schema: RegisterMessageSchema, key: "register" },
  { name: "wake_detected", schema: WakeDetectedMessageSchema, key: "wake_detected" },
  { name: "session_start", schema: SessionStartMessageSchema, key: "session_start" },
  { name: "ear_session_end", schema: EarSessionEndMessageSchema, key: "ear_session_end" },
  { name: "ack", schema: AckMessageSchema, key: "ack" },
  { name: "wake_ack proceed", schema: WakeAckMessageSchema, key: "wake_ack" },
  { name: "wake_ack yield", schema: WakeAckMessageSchema, key: "wake_ack_yield" },
  { name: "partial_transcript", schema: PartialTranscriptMessageSchema, key: "partial_transcript" },
  { name: "final_transcript", schema: FinalTranscriptMessageSchema, key: "final_transcript" },
  { name: "overlay listening", schema: OverlayUpdateMessageSchema, key: "overlay_update_listening" },
  { name: "overlay capturing", schema: OverlayUpdateMessageSchema, key: "overlay_update_capturing" },
  { name: "overlay thinking", schema: OverlayUpdateMessageSchema, key: "overlay_update_thinking" },
  { name: "overlay processing", schema: OverlayUpdateMessageSchema, key: "overlay_update_processing" },
  { name: "overlay success", schema: OverlayUpdateMessageSchema, key: "overlay_update_success" },
  { name: "overlay error", schema: OverlayUpdateMessageSchema, key: "overlay_update_error" },
  { name: "overlay idle", schema: OverlayUpdateMessageSchema, key: "overlay_update_idle" },
  { name: "overlay view", schema: OverlayUpdateMessageSchema, key: "overlay_update_view" },
  { name: "list_view open", schema: ListViewUpdateMessageSchema, key: "list_view_update_open" },
  { name: "list_view empty", schema: ListViewUpdateMessageSchema, key: "list_view_update_empty" },
  { name: "list_view close", schema: ListViewUpdateMessageSchema, key: "list_view_update_close" },
  { name: "core session_end", schema: CoreSessionEndMessageSchema, key: "core_session_end" },
  { name: "core session_end with detail", schema: CoreSessionEndMessageSchema, key: "core_session_end_with_detail" },
  { name: "session_mode continuous", schema: SessionModeChangeMessageSchema, key: "session_mode_continuous" },
  { name: "arm_capture continuous", schema: ArmCaptureMessageSchema, key: "arm_capture_continuous" },
  { name: "arm_capture ask", schema: ArmCaptureMessageSchema, key: "arm_capture_ask" },
  { name: "overlay listening ask", schema: OverlayUpdateMessageSchema, key: "overlay_update_listening_ask" },
  { name: "session_start ask", schema: SessionStartMessageSchema, key: "session_start_ask" },
  { name: "session_start immersive", schema: SessionStartMessageSchema, key: "session_start_immersive" },
  { name: "arm_capture immersive", schema: ArmCaptureMessageSchema, key: "arm_capture_immersive" },
  { name: "session_mode immersive", schema: SessionModeChangeMessageSchema, key: "session_mode_immersive" },
  { name: "overlay immersive", schema: OverlayUpdateMessageSchema, key: "overlay_update_immersive" },
] as const;

describe("per-event round-trip", () => {
  for (const { name, schema, key } of cases) {
    it(`${name} round-trips`, () => {
      const payload = fixtures[key];
      expect(payload).toBeTruthy();
      const parsed = schema.parse(payload);
      const reserialized = JSON.parse(JSON.stringify(parsed));
      expect(reserialized).toEqual(payload);
    });
  }
});

describe("EventName catalog", () => {
  it("declares the expected event names", () => {
    expect(EventName.Register).toBe("register");
    expect(EventName.WakeDetected).toBe("wake_detected");
    expect(EventName.OverlayUpdate).toBe("overlay_update");
    expect(EventName.ListViewUpdate).toBe("list_view_update");
    expect(EventName.AudioFrame).toBe("audio_frame");
  });
});

describe("overlay bounds and rules", () => {
  it("accepts every overlay kind including view and immersive", () => {
    const kinds = ["idle", "listening", "capturing", "thinking", "processing", "success", "error", "view", "immersive"];
    for (const kind of kinds) {
      expect(OverlayStateSchema.safeParse({ kind }).success).toBe(true);
    }
  });

  it("rejects wake in state.sound", () => {
    expect(OverlayStateSchema.safeParse({ kind: "listening", sound: "wake" }).success).toBe(false);
  });

  it("accepts cue_listen in state.sound", () => {
    expect(OverlayStateSchema.safeParse({ kind: "listening", sound: "cue_listen" }).success).toBe(true);
  });

  it("rejects hint > 120 chars", () => {
    expect(OverlayStateSchema.safeParse({ kind: "thinking", hint: "x".repeat(121) }).success).toBe(false);
  });

  it("rejects non-positive seq", () => {
    expect(OverlayUpdateMessageSchema.safeParse({ seq: 0, state: { kind: "idle" } }).success).toBe(false);
  });
});

describe("list_view bounds", () => {
  it("rejects items array > 200", () => {
    const items = Array.from({ length: 201 }, (_, i) => ({ id: `${i}`, label: `i${i}`, done: false }));
    expect(ListViewSchema.safeParse({ items, open: true }).success).toBe(false);
  });

  it("rejects label > 240 chars", () => {
    expect(
      ListViewSchema.safeParse({
        items: [{ id: "a", label: "x".repeat(241), done: false }],
        open: true,
      }).success,
    ).toBe(false);
  });

  it("accepts empty items array", () => {
    expect(ListViewSchema.safeParse({ items: [], open: true }).success).toBe(true);
  });
});

describe("session_start requires userId", () => {
  it("fails when userId is omitted", () => {
    const bad = { ...(fixtures.session_start as Record<string, unknown>) };
    delete (bad as Record<string, unknown>).userId;
    expect(SessionStartMessageSchema.safeParse(bad).success).toBe(false);
  });
});
