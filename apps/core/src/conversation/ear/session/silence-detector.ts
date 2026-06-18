// Server-side VAD that mirrors the Ear's adaptive silence detector.
// First `calibrationMs` of each session estimate the noise floor (75th
// percentile of observed RMS); afterwards speech is detected when RMS
// rises ≥ `speechMargin` above the floor, silence when it sits within
// `silenceMargin` of the floor. Endpoint fires after `endSilenceMs` of
// sustained silence following observed speech.

export interface SilenceDetectorOptions {
  endSilenceMs: number;
  graceMs: number;
  calibrationMs: number;
  speechMargin: number;
  silenceMargin: number;
  fallbackNoiseFloor: number;
}

export const DEFAULT_SILENCE_OPTS: SilenceDetectorOptions = {
  endSilenceMs: 5_000,
  graceMs: 500,
  calibrationMs: 600,
  speechMargin: 300,
  silenceMargin: 100,
  fallbackNoiseFloor: 100,
};

export type SilenceDecision = "waiting" | "ongoing" | "endpoint";

export class SilenceDetector {
  private readonly startedAt = Date.now();
  private noiseFloorRms = 0;
  private calibrationSamples: number[] = [];
  private sawSpeech = false;
  private silenceStartedAt: number | null = null;
  private calibrationLogged = false;
  private speechLogged = false;

  constructor(
    private readonly opts: SilenceDetectorOptions = DEFAULT_SILENCE_OPTS,
    private readonly onLog?: (msg: string, meta?: Record<string, unknown>) => void,
  ) {}

  feed(pcm: Uint8Array): SilenceDecision {
    const nowMs = Date.now() - this.startedAt;
    const rms = SilenceDetector.computeRms(pcm);

    if (nowMs < this.opts.calibrationMs) {
      this.calibrationSamples.push(rms);
      return "waiting";
    }

    if (this.noiseFloorRms === 0) {
      if (this.calibrationSamples.length === 0) {
        this.noiseFloorRms = this.opts.fallbackNoiseFloor;
      } else {
        const sorted = [...this.calibrationSamples].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75));
        this.noiseFloorRms = Math.max(this.opts.fallbackNoiseFloor, sorted[idx]);
      }
      if (!this.calibrationLogged) {
        this.calibrationLogged = true;
        this.onLog?.(
          `VAD calibrated`,
          {
            noiseFloor: Math.round(this.noiseFloorRms),
            speechThr: Math.round(this.noiseFloorRms + this.opts.speechMargin),
            silenceThr: Math.round(this.noiseFloorRms + this.opts.silenceMargin),
          },
        );
      }
    }

    if (nowMs < this.opts.graceMs) {
      return "waiting";
    }

    const speechThr = this.noiseFloorRms + this.opts.speechMargin;
    const silenceThr = this.noiseFloorRms + this.opts.silenceMargin;

    if (rms >= speechThr) {
      if (!this.sawSpeech && !this.speechLogged) {
        this.speechLogged = true;
        this.onLog?.(`VAD speech detected`, { rms: Math.round(rms), threshold: Math.round(speechThr) });
      }
      this.sawSpeech = true;
      this.silenceStartedAt = null;
      return "ongoing";
    }

    if (!this.sawSpeech) return "waiting";

    if (rms <= silenceThr) {
      if (this.silenceStartedAt === null) {
        this.silenceStartedAt = Date.now();
        this.onLog?.(`VAD silence started`, { rms: Math.round(rms), threshold: Math.round(silenceThr) });
      }
      if (Date.now() - this.silenceStartedAt >= this.opts.endSilenceMs) {
        this.onLog?.(`VAD endpoint reached`, { silenceMs: this.opts.endSilenceMs });
        return "endpoint";
      }
    } else {
      if (this.silenceStartedAt !== null) {
        this.onLog?.(`VAD silence broken`, { rms: Math.round(rms) });
      }
      this.silenceStartedAt = null;
    }
    return "ongoing";
  }

  get currentNoiseFloor(): number {
    return this.noiseFloorRms;
  }

  private static computeRms(pcm: Uint8Array): number {
    const count = Math.floor(pcm.byteLength / 2);
    if (count === 0) return 0;
    const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    let sumSquares = 0;
    for (let i = 0; i < count; i++) {
      const s = view.getInt16(i * 2, true);
      sumSquares += s * s;
    }
    return Math.sqrt(sumSquares / count);
  }
}
