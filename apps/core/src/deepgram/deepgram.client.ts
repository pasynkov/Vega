import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import WebSocket from "ws";
import { EnvConfig } from "../config/env";

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

// Direct WebSocket client to Deepgram's /v1/listen live endpoint. Avoids the
// SDK churn (the official package changed shape between 3.x and 5.x with no
// stable migration path), and gives us full visibility into close codes /
// raw error frames.

@Injectable()
export class DeepgramClient {
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

  open(callbacks: DeepgramSessionCallbacks, sampleRate: number): DeepgramSession {
    const params = new URLSearchParams({
      model: "nova-3",
      language: this.env.deepgramLanguage,
      encoding: "linear16",
      sample_rate: String(sampleRate),
      channels: "1",
      interim_results: "true",
      utterance_end_ms: "10000",
      vad_events: "true",
      smart_format: "true",
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;
    this.logger.info({ sampleRate, model: "nova-3", language: this.env.deepgramLanguage }, "Opening Deepgram live session");

    const ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.env.deepgramApiKey}` },
    });

    let buffered: Uint8Array[] = [];
    let opened = false;
    let bytesSent = 0;
    let framesSent = 0;
    let lastReportAt = Date.now();
    let closed = false;
    let keepAlive: NodeJS.Timeout | null = null;

    ws.on("open", () => {
      opened = true;
      this.logger.info({ buffered: buffered.length }, "Deepgram live socket open, flushing buffer");
      for (const frame of buffered) {
        ws.send(frame);
        bytesSent += frame.byteLength;
        framesSent++;
      }
      buffered = [];
      keepAlive = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "KeepAlive" }));
        }
      }, 5_000);
    });

    ws.on("message", (raw, isBinary) => {
      if (isBinary) return;
      let msg: any;
      try {
        msg = JSON.parse(raw.toString("utf-8"));
      } catch {
        this.logger.warn({ raw: raw.toString("utf-8").slice(0, 200) }, "Deepgram non-JSON message");
        return;
      }
      const type = msg?.type ?? "";
      if (type === "Results" || msg?.channel) {
        const alt = msg?.channel?.alternatives?.[0];
        const text = (alt?.transcript as string | undefined) ?? "";
        const confidence = (alt?.confidence as number | undefined) ?? null;
        const isFinal: boolean = !!msg?.is_final;
        if (!text) return;
        if (isFinal) {
          this.logger.info(`STT FINAL  | ${text}` + (confidence !== null ? `  (conf=${confidence.toFixed(2)})` : ""));
          callbacks.onFinal(text, confidence);
        } else {
          this.logger.info(`STT partial | ${text}`);
          callbacks.onPartial(text);
        }
      } else if (type === "UtteranceEnd") {
        this.logger.info({ bytesSent, framesSent }, "Deepgram: UtteranceEnd");
        callbacks.onUtteranceEnd();
      } else if (type === "SpeechStarted") {
        this.logger.info("Deepgram: SpeechStarted");
      } else if (type === "Metadata") {
        this.logger.info({ msg }, "Deepgram: Metadata");
      } else if (type === "Error") {
        const detail = msg?.description || msg?.message || JSON.stringify(msg).slice(0, 200);
        this.logger.warn({ msg }, `Deepgram protocol error: ${detail}`);
        callbacks.onError(detail);
      } else {
        this.logger.debug({ msg }, "Deepgram unknown message");
      }
    });

    ws.on("error", (err: Error) => {
      this.logger.warn({ err: { message: err.message, name: err.name } }, `Deepgram WS error: ${err.message}`);
      callbacks.onError(err.message);
    });

    ws.on("close", (code: number, reason: Buffer) => {
      if (closed) return;
      closed = true;
      if (keepAlive) clearInterval(keepAlive);
      this.logger.info(
        { code, reason: reason?.toString("utf-8"), bytesSent, framesSent },
        `Deepgram live socket closed (code ${code})`,
      );
      callbacks.onClose();
    });

    return {
      send: (frame) => {
        if (!opened) {
          buffered.push(frame);
          return;
        }
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(frame);
        bytesSent += frame.byteLength;
        framesSent++;
        const now = Date.now();
        if (now - lastReportAt >= 2_000) {
          this.logger.info(
            {
              framesSent,
              bytesSent,
              kBperSec: ((bytesSent / ((now - lastReportAt) / 1000)) / 1024).toFixed(1),
            },
            "PCM throughput to Deepgram",
          );
          lastReportAt = now;
          bytesSent = 0;
          framesSent = 0;
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (keepAlive) clearInterval(keepAlive);
        try {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
            ws.send(JSON.stringify({ type: "CloseStream" }));
          }
          ws.close();
        } catch (err) {
          this.logger.warn({ err }, "Failed to close Deepgram live socket cleanly");
        }
      },
    };
  }
}
