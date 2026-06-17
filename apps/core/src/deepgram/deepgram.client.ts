import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { createClient, LiveTranscriptionEvents, type ListenLiveClient } from "@deepgram/sdk";
import { EnvConfig } from "../config/env";

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  const buf = new ArrayBuffer(view.byteLength);
  new Uint8Array(buf).set(view);
  return buf;
}

export interface DeepgramSessionCallbacks {
  onPartial: (text: string) => void;
  onFinal: (text: string, confidence: number | null) => void;
  onUtteranceEnd: () => void;
  onError: (detail: string) => void;
  onClose: () => void;
}

export interface DeepgramSession {
  send(opusFrame: Uint8Array): void;
  close(): void;
}

@Injectable()
export class DeepgramClient {
  private sdk: ReturnType<typeof createClient> | null = null;

  constructor(
    @InjectPinoLogger(DeepgramClient.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
  ) {
    void this.verifyAuth();
  }

  private async verifyAuth(): Promise<void> {
    try {
      const res = await fetch("https://api.deepgram.com/v1/projects", {
        headers: { Authorization: `Token ${this.env.deepgramApiKey}` },
      });
      if (res.ok) {
        const json: any = await res.json();
        const count = Array.isArray(json?.projects) ? json.projects.length : 0;
        this.logger.info({ projects: count }, "Deepgram API key OK");
      } else {
        const body = await res.text();
        this.logger.error(
          { status: res.status, body: body.slice(0, 200) },
          "Deepgram API key check FAILED — live sessions will close immediately",
        );
      }
    } catch (err) {
      this.logger.warn({ err }, "Could not reach Deepgram for key check (network?)");
    }
  }

  private get client(): ReturnType<typeof createClient> {
    if (!this.sdk) this.sdk = createClient(this.env.deepgramApiKey);
    return this.sdk;
  }

  open(callbacks: DeepgramSessionCallbacks, sampleRate: number): DeepgramSession {
    this.logger.info(
      {
        language: this.env.deepgramLanguage,
        model: "nova-3",
        encoding: "linear16",
        sampleRate,
      },
      "Opening Deepgram live session",
    );

    const live = this.client.listen.live({
      language: this.env.deepgramLanguage,
      model: "nova-3",
      encoding: "linear16",
      sample_rate: sampleRate,
      channels: 1,
      interim_results: true,
      // Deepgram still emits UtteranceEnd as an informational event,
      // but the Ear's local SilenceDetector owns the authoritative endpoint
      // signal — Core does not terminate the session on UtteranceEnd, so
      // Deepgram's parameter only affects when those info events fire.
      utterance_end_ms: 10_000,
      vad_events: true,
      smart_format: true,
    }) as ListenLiveClient;

    let buffered: Uint8Array[] = [];
    let opened = false;
    let bytesSent = 0;
    let framesSent = 0;
    let lastReportAt = Date.now();

    live.on(LiveTranscriptionEvents.Open, () => {
      opened = true;
      this.logger.info({ buffered: buffered.length }, "Deepgram live socket open, flushing buffer");
      for (const frame of buffered) {
        live.send(toArrayBuffer(frame));
        bytesSent += frame.byteLength;
        framesSent++;
      }
      buffered = [];
    });

    live.on(LiveTranscriptionEvents.SpeechStarted, () => {
      this.logger.info("Deepgram: SpeechStarted");
    });

    live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const alt = data?.channel?.alternatives?.[0];
      const text = (alt?.transcript as string | undefined) ?? "";
      const confidence = (alt?.confidence as number | undefined) ?? null;
      const isFinal: boolean = !!data?.is_final;
      if (!text) return;
      if (isFinal) {
        this.logger.info(`STT FINAL  | ${text}` + (confidence !== null ? `  (conf=${confidence.toFixed(2)})` : ""));
        callbacks.onFinal(text, confidence);
      } else {
        this.logger.info(`STT partial | ${text}`);
        callbacks.onPartial(text);
      }
    });

    live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.logger.info({ bytesSent, framesSent }, "Deepgram: UtteranceEnd");
      callbacks.onUtteranceEnd();
    });

    live.on(LiveTranscriptionEvents.Error, (err: any) => {
      const inner = err?.error;
      const detail =
        err?.message ||
        inner?.message ||
        err?.reason ||
        `${err?.type ?? "Error"} (no message)`;
      this.logger.warn(
        {
          type: err?.type,
          innerType: inner?.type,
          innerStack: inner?.stack ? String(inner.stack).split("\n").slice(0, 3).join(" | ") : undefined,
          hint:
            inner?.type === "TypeError" && /onSocketClose/.test(String(inner?.stack))
              ? "Likely Deepgram closed the WS without a body — check DEEPGRAM_API_KEY validity and account credit"
              : undefined,
        },
        `Deepgram error: ${detail}`,
      );
      callbacks.onError(detail);
    });

    live.on(LiveTranscriptionEvents.Close, (event: any) => {
      this.logger.info(
        {
          code: event?.code,
          reason: event?.reason,
          wasClean: event?.wasClean,
          bytesSent,
          framesSent,
        },
        "Deepgram live socket closed",
      );
      callbacks.onClose();
    });

    return {
      send: (frame) => {
        if (!opened) {
          buffered.push(frame);
          return;
        }
        live.send(toArrayBuffer(frame));
        bytesSent += frame.byteLength;
        framesSent++;
        const now = Date.now();
        if (now - lastReportAt >= 2_000) {
          this.logger.info(
            { framesSent, bytesSent, kBperSec: ((bytesSent / ((now - lastReportAt) / 1000)) / 1024).toFixed(1) },
            "PCM throughput",
          );
          lastReportAt = now;
          bytesSent = 0;
          framesSent = 0;
        }
      },
      close: () => {
        try {
          live.requestClose();
        } catch (err) {
          this.logger.warn({ err }, "Failed to close Deepgram live socket cleanly");
        }
      },
    };
  }
}
