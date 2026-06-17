import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingStore, SessionRecord } from "../src/recording/recording-store";

class StubLogger {
  info() {}
  warn() {}
  error() {}
  debug() {}
}

function makeStore(recordingsDir: string): RecordingStore {
  const env = {
    recordingsDir,
    deepgramLanguage: "ru",
  } as any;
  return new RecordingStore(new StubLogger() as any, env);
}

// Synthesize 0.25 s of 440 Hz tone as int16 PCM at 48 kHz mono. Tiny but real
// audio so ffmpeg actually has something to encode.
function syntheticPcm(): Buffer {
  const sampleRate = 48_000;
  const seconds = 0.25;
  const samples = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16_000);
    buf.writeInt16LE(v, i * 2);
  }
  return buf;
}

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "vega-rec-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("RecordingStore", () => {
  it("writes a real OGG/OPUS audio.ogg, transcript.txt, and meta.json", async () => {
    const store = makeStore(tmp);
    const session: SessionRecord = {
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Test Mac",
      userId: null,
      startedAt: "2026-06-17T11:42:03.123Z",
      endedAt: "2026-06-17T11:42:08.123Z",
      endReason: "endpoint",
      language: "ru",
      transcriptConfidence: 0.95,
      wakeScore: null,
      partials: ["напомни купить"],
      finals: ["напомни купить молоко"],
      audioBuffers: [syntheticPcm()],
    };

    await store.persist(session);

    const entries = readdirSync(tmp);
    expect(entries.length).toBe(1);
    const dir = join(tmp, entries[0]!);

    const audio = readFileSync(join(dir, "audio.ogg"));
    expect(audio.byteLength).toBeGreaterThan(64);
    // OGG container files start with the four-byte capture pattern "OggS".
    expect(audio.subarray(0, 4).toString("ascii")).toBe("OggS");

    expect(readFileSync(join(dir, "transcript.txt"), "utf-8")).toBe("напомни купить молоко\n");
    const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf-8"));
    expect(meta.sessionId).toBe(session.sessionId);
    expect(meta.userId).toBeNull();
    expect(meta.endReason).toBe("endpoint");
    expect(meta.transcriptConfidence).toBe(0.95);
  }, 30_000);

  it("skips persistence entirely when no audio frames were received", async () => {
    const store = makeStore(tmp);
    const session: SessionRecord = {
      sessionId: "22222222-2222-4222-8222-222222222222",
      deviceId: "11111111-1111-4111-8111-111111111111",
      deviceName: "Test Mac",
      userId: null,
      startedAt: "2026-06-17T11:42:03.123Z",
      endedAt: "2026-06-17T11:42:03.500Z",
      endReason: "user",
      language: "ru",
      transcriptConfidence: null,
      wakeScore: null,
      partials: [],
      finals: [],
      audioBuffers: [],
    };
    await store.persist(session);
    expect(readdirSync(tmp)).toEqual([]);
  });
});
