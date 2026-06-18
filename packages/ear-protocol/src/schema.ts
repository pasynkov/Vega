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
  "ack_unknown",
]);
export type Cue = z.infer<typeof CueEnum>;

// Cues allowed inside `overlay_update.state.sound`. The `wake` cue is
// played locally by the Ear on wake-word detection and never flows over
// the wire in this field.
export const OverlaySoundEnum = z.enum([
  "endpoint",
  "error",
  "ack_done",
  "ack_continue",
  "ack_thinking",
  "ack_success",
  "ack_error",
  "ack_unknown",
]);
export type OverlaySound = z.infer<typeof OverlaySoundEnum>;

export const OverlayKindEnum = z.enum([
  "idle",
  "listening",
  "capturing",
  "thinking",
  "processing",
  "success",
  "error",
  "view",
]);
export type OverlayKind = z.infer<typeof OverlayKindEnum>;

export const OverlayStateSchema = z.object({
  kind: OverlayKindEnum,
  hint: z.string().max(120).optional(),
  caption: z.string().max(240).optional(),
  sound: OverlaySoundEnum.optional(),
});
export type OverlayState = z.infer<typeof OverlayStateSchema>;

export const SessionModeEnum = z.enum(["regular", "continuous"]);
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

// Drives the interactive overlay on the Ear: visual state + optional cue
// sound in a single atomic message. Replaces the removed `play_cue`. The
// `seq` field is strictly monotonic per device per connection so the Ear
// can drop any out-of-order delivery.
export const OverlayUpdateMessageSchema = z.object({
  type: z.literal("overlay_update"),
  seq: z.number().int().positive(),
  state: OverlayStateSchema,
});
export type OverlayUpdateMessage = z.infer<typeof OverlayUpdateMessageSchema>;

// Generic list-view surface rendered below the orb. Drives a domain-
// agnostic vertical list (shopping, todo, recipes, ...). The Ear renders
// `items` verbatim; `done` rows are struck-through. `open: false`
// collapses the section; the orb is unaffected (a separate
// overlay_update controls the orb).
export const ListItemSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(240),
  done: z.boolean(),
});
export type ListItem = z.infer<typeof ListItemSchema>;

export const ListViewSchema = z.object({
  title: z.string().max(120).optional(),
  items: z.array(ListItemSchema).max(200),
  open: z.boolean(),
});
export type ListView = z.infer<typeof ListViewSchema>;

export const ListViewUpdateMessageSchema = z.object({
  type: z.literal("list_view_update"),
  seq: z.number().int().positive(),
  view: ListViewSchema,
});
export type ListViewUpdateMessage = z.infer<typeof ListViewUpdateMessageSchema>;

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
  OverlayUpdateMessageSchema,
  ListViewUpdateMessageSchema,
  SessionModeChangeMessageSchema,
  ArmCaptureMessageSchema,
  CoreSessionEndMessageSchema,
]);
export type CoreToEarMessage = z.infer<typeof CoreToEarMessageSchema>;
