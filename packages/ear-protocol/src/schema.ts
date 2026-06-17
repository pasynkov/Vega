import { z } from "zod";

const uuid = z.string().uuid();
const iso8601 = z.string().min(20);

export const CapabilityEnum = z.enum(["mic", "wake", "speaker", "display"]);
export type Capability = z.infer<typeof CapabilityEnum>;

export const EarEndReasonEnum = z.enum(["user", "timeout", "vad"]);
export type EarEndReason = z.infer<typeof EarEndReasonEnum>;

export const CoreEndReasonEnum = z.enum(["endpoint", "timeout", "stt_error", "user"]);
export type CoreEndReason = z.infer<typeof CoreEndReasonEnum>;

export const CueEnum = z.enum([
  "wake",
  "endpoint",
  "error",
  "ack_done",
  "ack_continue",
  "ack_thinking",
  "ack_success",
  "ack_error",
]);
export type Cue = z.infer<typeof CueEnum>;

export const SessionModeEnum = z.enum(["regular", "long_note"]);
export type SessionMode = z.infer<typeof SessionModeEnum>;

export const WakeActionEnum = z.enum(["proceed", "yield"]);
export type WakeAction = z.infer<typeof WakeActionEnum>;

export const CodecEnum = z.enum(["linear16", "opus"]);
export type Codec = z.infer<typeof CodecEnum>;

// Ear -> Core
export const RegisterMessageSchema = z.object({
  type: z.literal("register"),
  deviceId: uuid,
  deviceName: z.string().min(1),
  capabilities: z.array(CapabilityEnum).min(1),
});
export type RegisterMessage = z.infer<typeof RegisterMessageSchema>;

export const WakeDetectedMessageSchema = z.object({
  type: z.literal("wake_detected"),
  deviceId: uuid,
  score: z.number().min(0).max(1),
  timestamp: iso8601,
});
export type WakeDetectedMessage = z.infer<typeof WakeDetectedMessageSchema>;

export const SessionStartMessageSchema = z.object({
  type: z.literal("session_start"),
  deviceId: uuid,
  sessionId: uuid,
  userId: z.string().nullable(),
  sampleRate: z.number().int().positive(),
  codec: CodecEnum,
  mode: SessionModeEnum.optional(),
});
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;

// `audio_frame` is sent as a binary WebSocket frame. We expose a control envelope
// for tooling (logging, debugging) but the wire form is binary; see binary-frame.ts.
export const AudioFrameEnvelopeSchema = z.object({
  type: z.literal("audio_frame"),
  sessionId: uuid,
  byteLength: z.number().int().nonnegative(),
});
export type AudioFrameEnvelope = z.infer<typeof AudioFrameEnvelopeSchema>;

export const EarSessionEndMessageSchema = z.object({
  type: z.literal("session_end"),
  sessionId: uuid,
  reason: EarEndReasonEnum,
});
export type EarSessionEndMessage = z.infer<typeof EarSessionEndMessageSchema>;

export const EarToCoreMessageSchema = z.discriminatedUnion("type", [
  RegisterMessageSchema,
  WakeDetectedMessageSchema,
  SessionStartMessageSchema,
  EarSessionEndMessageSchema,
]);
export type EarToCoreMessage = z.infer<typeof EarToCoreMessageSchema>;

// Core -> Ear
export const AckMessageSchema = z.object({
  type: z.literal("ack"),
  deviceId: uuid,
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const WakeAckMessageSchema = z.object({
  type: z.literal("wake_ack"),
  action: WakeActionEnum,
});
export type WakeAckMessage = z.infer<typeof WakeAckMessageSchema>;

export const PartialTranscriptMessageSchema = z.object({
  type: z.literal("partial_transcript"),
  sessionId: uuid,
  text: z.string(),
  isFinal: z.literal(false),
});
export type PartialTranscriptMessage = z.infer<typeof PartialTranscriptMessageSchema>;

export const FinalTranscriptMessageSchema = z.object({
  type: z.literal("final_transcript"),
  sessionId: uuid,
  text: z.string(),
});
export type FinalTranscriptMessage = z.infer<typeof FinalTranscriptMessageSchema>;

export const PlayCueMessageSchema = z.object({
  type: z.literal("play_cue"),
  cue: CueEnum,
});
export type PlayCueMessage = z.infer<typeof PlayCueMessageSchema>;

export const CoreSessionEndMessageSchema = z.object({
  type: z.literal("session_end"),
  sessionId: uuid,
  reason: CoreEndReasonEnum,
  detail: z.string().optional(),
});
export type CoreSessionEndMessage = z.infer<typeof CoreSessionEndMessageSchema>;

export const SessionModeChangeMessageSchema = z.object({
  type: z.literal("session_mode"),
  sessionId: uuid,
  mode: SessionModeEnum,
});
export type SessionModeChangeMessage = z.infer<typeof SessionModeChangeMessageSchema>;

// Backend-initiated capture arming. Instructs the Ear to open a fresh
// capture session under the given mode without requiring a wake-word.
// The Ear plays the mode-appropriate cue, then sends its normal
// `session_start` with the same `mode` field set.
export const ArmCaptureMessageSchema = z.object({
  type: z.literal("arm_capture"),
  mode: SessionModeEnum,
});
export type ArmCaptureMessage = z.infer<typeof ArmCaptureMessageSchema>;

export const CoreToEarMessageSchema = z.discriminatedUnion("type", [
  AckMessageSchema,
  WakeAckMessageSchema,
  PartialTranscriptMessageSchema,
  FinalTranscriptMessageSchema,
  PlayCueMessageSchema,
  SessionModeChangeMessageSchema,
  ArmCaptureMessageSchema,
  CoreSessionEndMessageSchema,
]);
export type CoreToEarMessage = z.infer<typeof CoreToEarMessageSchema>;
