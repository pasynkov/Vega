import type { SessionMode } from "@vega/ear-protocol";

export interface EarSessionHandle {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly mode: SessionMode;
  readonly arrivedAt: number;
}

export interface SessionToolResult {
  readonly release: true;
  readonly reason: "endpoint" | "timeout" | "stt_error" | "user";
  readonly [extra: string]: unknown;
}

export function isSessionReleaseResult(value: unknown): value is SessionToolResult {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.release !== true) return false;
  return v.reason === "endpoint" || v.reason === "timeout" || v.reason === "stt_error" || v.reason === "user";
}
