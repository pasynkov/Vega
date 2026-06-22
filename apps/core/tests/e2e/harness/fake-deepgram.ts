import type {
  DeepgramSession,
  DeepgramSessionCallbacks,
} from "../../../src/integrations/deepgram/deepgram.client";

interface OpenedSession {
  callbacks: DeepgramSessionCallbacks;
  sampleRate: number;
  bytesReceived: number;
  framesReceived: number;
  closed: boolean;
}

/**
 * Test double for DeepgramClient. Replaces the production provider via
 * `overrideProvider(DeepgramClient).useValue(new FakeDeepgram())`.
 *
 * Production code calls `open(callbacks, sampleRate)` once per session and
 * uses the returned `{send,close}` shape. We record each open() so the
 * test can drive STT events against a specific session by index, with the
 * most-recently-opened one as the default target.
 */
export class FakeDeepgram {
  readonly openSessions: OpenedSession[] = [];

  open(callbacks: DeepgramSessionCallbacks, sampleRate: number): DeepgramSession {
    const session: OpenedSession = {
      callbacks,
      sampleRate,
      bytesReceived: 0,
      framesReceived: 0,
      closed: false,
    };
    this.openSessions.push(session);
    return {
      send: (frame: Uint8Array) => {
        if (session.closed) return;
        session.bytesReceived += frame.byteLength;
        session.framesReceived += 1;
      },
      close: () => {
        if (session.closed) return;
        session.closed = true;
        try {
          session.callbacks.onClose();
        } catch {
          // swallow — production code's onClose is best-effort
        }
      },
    };
  }

  // ---------- inspection ----------

  get currentSession(): OpenedSession {
    const last = this.openSessions[this.openSessions.length - 1];
    if (!last) {
      throw new Error("FakeDeepgram: no session has been opened yet");
    }
    return last;
  }

  sessionAt(idx: number): OpenedSession {
    const s = this.openSessions[idx];
    if (!s) throw new Error(`FakeDeepgram: no session at index ${idx}`);
    return s;
  }

  bytesReceived(idx = this.openSessions.length - 1): number {
    return this.sessionAt(idx).bytesReceived;
  }

  framesReceived(idx = this.openSessions.length - 1): number {
    return this.sessionAt(idx).framesReceived;
  }

  // ---------- drivers (operate on current session by default) ----------

  simulatePartial(text: string, idx?: number): void {
    this.target(idx).callbacks.onPartial(text);
  }

  simulateFinal(text: string, confidence: number | null = null, idx?: number): void {
    this.target(idx).callbacks.onFinal(text, confidence);
  }

  simulateUtteranceEnd(idx?: number): void {
    this.target(idx).callbacks.onUtteranceEnd();
  }

  simulateError(detail: string, idx?: number): void {
    this.target(idx).callbacks.onError(detail);
  }

  simulateClose(idx?: number): void {
    const s = this.target(idx);
    if (s.closed) return;
    s.closed = true;
    s.callbacks.onClose();
  }

  private target(idx?: number): OpenedSession {
    if (typeof idx === "number") return this.sessionAt(idx);
    return this.currentSession;
  }
}
