import "reflect-metadata";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("@langchain/anthropic", async () => {
  const m = await import("../harness/scripted-llm");
  return m.buildAnthropicMock();
});

vi.mock("@langchain/langgraph/prebuilt", async () => {
  const m = await import("../harness/scripted-llm");
  return m.buildReactAgentMock();
});

import { scenarioBoot, scenarioTeardown, type ScenarioCtx } from "../harness/boot";
import { sleep } from "../harness/waiters";
import { io as ioClient } from "socket.io-client";

describe("e2e/lifecycle", () => {
  let ctx: ScenarioCtx;

  beforeEach(async () => {
    ctx = await scenarioBoot();
  });

  afterEach(async () => {
    await scenarioTeardown(ctx);
  });

  it("register → server emits ack carrying the same deviceId", async () => {
    const ack = await ctx.ear.register();
    expect(ack.deviceId).toBe(ctx.ear.deviceId);
  });

  it("wake_detected → wake_ack(proceed) + overlay listening", async () => {
    await ctx.ear.register();
    const wakeAck = await ctx.ear.wake({ score: 0.92 });
    expect(wakeAck.action).toBe("proceed");
    const overlay = await ctx.ear.waitOverlay(
      (m) => m.state.kind === "listening",
    );
    expect(overlay.state.kind).toBe("listening");
  });

  it("audio bytes flow end-to-end through gateway → DeepgramClient.send", async () => {
    await ctx.ear.register();
    await ctx.ear.wake({ score: 0.92 });
    await ctx.ear.sessionStart({ mode: "regular" });

    // Wait for SessionService to open the Deepgram session.
    await vi.waitFor(
      () => {
        if (ctx.dg.openSessions.length < 1) throw new Error("no session yet");
      },
      { timeout: 2_000 },
    );
    expect(ctx.dg.openSessions.length).toBe(1);

    // Push 5 frames of 320-byte (10ms @ 16kHz int16) buffers.
    const frame = Buffer.alloc(320, 0);
    for (let i = 0; i < 5; i++) ctx.ear.sendAudio(frame);

    // Wait until the gateway has forwarded all 5 to FakeDeepgram.
    await vi.waitFor(
      () => {
        if (ctx.dg.framesReceived(0) < 5) throw new Error("frames not all forwarded");
      },
      { timeout: 2_000 },
    );
    expect(ctx.dg.framesReceived(0)).toBe(5);
    expect(ctx.dg.bytesReceived(0)).toBe(5 * 320);

    // The audio plumbing test does NOT exercise STT events — those are
    // covered in stt-events.test.ts. End the session cleanly here so the
    // session.service cleanup paths run.
    ctx.ear.sessionEnd({ reason: "user" });
    await sleep(50); // let the gateway process the end event
  });

  it("connecting without sending register → server disconnects after the timeout", async () => {
    const dangler = ioClient(`ws://127.0.0.1:${ctx.port}/ear`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    const disconnected = new Promise<void>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("did not disconnect within 3s")),
        3_000,
      );
      dangler.on("disconnect", () => {
        clearTimeout(t);
        resolve();
      });
    });
    await disconnected;
    dangler.disconnect();
  }, 5_000);

  it("event before register → server disconnects the socket", async () => {
    const rude = ioClient(`ws://127.0.0.1:${ctx.port}/ear`, {
      transports: ["websocket"],
      forceNew: true,
      reconnection: false,
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("did not connect")), 1_500);
      rude.once("connect", () => {
        clearTimeout(t);
        resolve();
      });
      rude.once("connect_error", (err) => reject(err));
    });
    rude.emit("wake_detected", {
      deviceId: "11111111-1111-4111-8111-111111111111",
      score: 0.9,
      timestamp: "2026-06-22T00:00:00.000Z",
    });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("not disconnected")), 1_500);
      rude.on("disconnect", () => {
        clearTimeout(t);
        resolve();
      });
    });
    rude.disconnect();
  });

  it("malformed payload → server logs warn, does not crash", async () => {
    await ctx.ear.register();
    // wake_detected with garbage payload (missing fields)
    ctx.ear.emitRaw("wake_detected", { score: "not-a-number" });
    // The connection is still alive; a follow-up valid event still works.
    await sleep(50);
    const valid = await ctx.ear.wake({ score: 0.8 });
    expect(valid.action).toBe("proceed");
  });
});
