import { Injectable } from "@nestjs/common";
import { InjectPinoLogger, PinoLogger } from "nestjs-pino";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { EnvConfig } from "../../../config/env";
import { CoreEndReason } from "@vega/ear-protocol";

export interface SessionRecord {
  sessionId: string;
  deviceId: string;
  deviceName: string;
  userId: string | null;
  startedAt: string;
  endedAt: string;
  endReason: CoreEndReason;
  language: string;
  transcriptConfidence: number | null;
  wakeScore: number | null;
  partials: string[];
  finals: string[];
  audioBuffers: Buffer[];
  sampleRate: number;
}

@Injectable()
export class RecordingStore {
  constructor(
    @InjectPinoLogger(RecordingStore.name) private readonly logger: PinoLogger,
    private readonly env: EnvConfig,
  ) {}

  async persist(session: SessionRecord): Promise<void> {
    if (session.audioBuffers.length === 0) {
      this.logger.info({ sessionId: session.sessionId }, "Empty session, skipping persistence");
      return;
    }

    const dirName = session.startedAt.replace(/:/g, "-");
    const dir = join(this.env.recordingsDir, dirName);
    await mkdir(dir, { recursive: true });

    const pcm = Buffer.concat(session.audioBuffers);
    const audioPath = join(dir, "audio.ogg");
    await this.encodePcmToOggOpus(pcm, audioPath, session.sampleRate);

    const finalText = session.finals.join(" ").trim();
    const transcript = finalText.length > 0 ? finalText : session.partials.join(" ").trim();
    await writeFile(join(dir, "transcript.txt"), `${transcript}\n`, "utf-8");

    const meta = {
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      userId: session.userId,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      wakeScore: session.wakeScore,
      language: session.language,
      transcriptConfidence: session.transcriptConfidence,
      sampleRate: session.sampleRate,
    };
    await writeFile(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n", "utf-8");

    this.logger.info(
      { sessionId: session.sessionId, dir, pcmBytes: pcm.byteLength, chars: transcript.length },
      "Session persisted",
    );
  }

  // Pipe PCM (signed 16-bit LE, mono, captured sample rate) into ffmpeg, mux
  // as OGG/OPUS. Telegram's sendVoice accepts the result without re-encoding.
  private encodePcmToOggOpus(pcm: Buffer, outPath: string, sampleRate: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-hide_banner",
        "-loglevel", "warning",
        "-f", "s16le",
        "-ar", String(sampleRate),
        "-ac", "1",
        "-i", "pipe:0",
        "-c:a", "libopus",
        "-b:a", "32k",
        "-application", "voip",
        "-f", "ogg",
        "-y",
        outPath,
      ];
      const proc = spawn(ffmpegInstaller.path, args, { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });
      proc.stdin?.end(pcm);
    });
  }
}
