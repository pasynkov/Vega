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
  ) {}

  private get client(): ReturnType<typeof createClient> {
    if (!this.sdk) this.sdk = createClient(this.env.deepgramApiKey);
    return this.sdk;
  }

  open(callbacks: DeepgramSessionCallbacks, sampleRate: number): DeepgramSession {
    this.logger.info(
      {
        language: this.env.deepgramLanguage,
        model: "nova-2",
        encoding: "linear16",
        sampleRate,
      },
      "Opening Deepgram live session",
    );

    const live = this.client.listen.live({
      language: this.env.deepgramLanguage,
      model: "nova-2",
      encoding: "linear16",
      sample_rate: sampleRate,
      channels: 1,
      interim_results: true,
      // Match the Ear's local VAD endSilenceMs (3 s) so Deepgram doesn't
      // cut a session mid-phrase on a normal pause between words. The Ear
      // still owns the authoritative endpoint via its silence detector.
      utterance_end_ms: 3_000,
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
      const speechFinal: boolean = !!data?.speech_final;
      this.logger.debug(
        { text, isFinal, speechFinal, confidence, bytesSentSoFar: bytesSent },
        "Deepgram transcript event",
      );
      if (!text) return;
      if (isFinal) {
        this.logger.info({ text, confidence }, "Deepgram final");
        callbacks.onFinal(text, confidence);
      } else {
        this.logger.info({ text }, "Deepgram partial");
        callbacks.onPartial(text);
      }
    });

    live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      this.logger.info({ bytesSent, framesSent }, "Deepgram: UtteranceEnd");
      callbacks.onUtteranceEnd();
    });

    live.on(LiveTranscriptionEvents.Error, (err: any) => {
      const detail = err?.message ?? String(err);
      this.logger.warn({ err }, "Deepgram error");
      callbacks.onError(detail);
    });

    live.on(LiveTranscriptionEvents.Close, (event: any) => {
      this.logger.info({ event, bytesSent, framesSent }, "Deepgram live socket closed");
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
