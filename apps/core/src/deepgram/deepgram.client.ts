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

  open(callbacks: DeepgramSessionCallbacks): DeepgramSession {
    const live = this.client.listen.live({
      language: this.env.deepgramLanguage,
      model: "nova-2",
      encoding: "linear16",
      sample_rate: 48_000,
      channels: 1,
      interim_results: true,
      utterance_end_ms: 1_000,
      vad_events: true,
      smart_format: true,
    }) as ListenLiveClient;

    let buffered: Uint8Array[] = [];
    let opened = false;

    live.on(LiveTranscriptionEvents.Open, () => {
      opened = true;
      for (const frame of buffered) {
        live.send(toArrayBuffer(frame));
      }
      buffered = [];
    });

    live.on(LiveTranscriptionEvents.Transcript, (data: any) => {
      const alt = data?.channel?.alternatives?.[0];
      const text = (alt?.transcript as string | undefined) ?? "";
      const confidence = (alt?.confidence as number | undefined) ?? null;
      if (!text) return;
      if (data?.is_final) {
        callbacks.onFinal(text, confidence);
      } else {
        callbacks.onPartial(text);
      }
    });

    live.on(LiveTranscriptionEvents.UtteranceEnd, () => {
      callbacks.onUtteranceEnd();
    });

    live.on(LiveTranscriptionEvents.Error, (err: any) => {
      const detail = err?.message ?? String(err);
      this.logger.warn({ err }, "Deepgram error");
      callbacks.onError(detail);
    });

    live.on(LiveTranscriptionEvents.Close, () => {
      callbacks.onClose();
    });

    return {
      send: (frame) => {
        if (!opened) {
          buffered.push(frame);
        } else {
          live.send(toArrayBuffer(frame));
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
