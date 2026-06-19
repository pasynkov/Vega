import { z } from "zod";

const uuid = z.string().uuid();
const iso8601 = z.string().min(20);

// Event names — the socket.io event discriminator. The wire was raw
// `ws` with a `type` literal on each JSON payload; after the socket.io
// migration the event name carries that role and the per-payload
// `type` field is gone.
export const EventName = {
  // Ear → Core
  Register: "register",
  WakeDetected: "wake_detected",
  SessionStart: "session_start",
  AudioFrame: "audio_frame",
  EarSessionEnd: "session_end",
  // Core → Ear
  Ack: "ack",
  WakeAck: "wake_ack",
  PartialTranscript: "partial_transcript",
  FinalTranscript: "final_transcript",
  OverlayUpdate: "overlay_update",
  ListViewUpdate: "list_view_update",
  SessionMode: "session_mode",
  ArmCapture: "arm_capture",
  CoreSessionEnd: "session_end",
  Exception: "exception",
} as const;
export type EventName = (typeof EventName)[keyof typeof EventName];

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
  "cue_listen",
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
  "immersive",
]);
export type OverlayKind = z.infer<typeof OverlayKindEnum>;

export const OverlayStateSchema = z.object({
  kind: OverlayKindEnum,
  hint: z.string().max(120).optional(),
  caption: z.string().max(240).optional(),
  sound: OverlaySoundEnum.optional(),
});
export type OverlayState = z.infer<typeof OverlayStateSchema>;

export const SessionModeEnum = z.enum(["regular", "continuous", "ask", "immersive"]);
export type SessionMode = z.infer<typeof SessionModeEnum>;

export const WakeActionEnum = z.enum(["proceed", "yield"]);
export type WakeAction = z.infer<typeof WakeActionEnum>;

export const CodecEnum = z.enum(["linear16", "opus"]);
export type Codec = z.infer<typeof CodecEnum>;

// ─────────────────────────────────────────────────────────────────────
// Ear → Core event payloads. The socket.io event name is the
// discriminator; payloads are plain objects with no `type` field.
// ─────────────────────────────────────────────────────────────────────

export const RegisterMessageSchema = z.object({
  deviceId: uuid,
  deviceName: z.string().min(1),
  capabilities: z.array(CapabilityEnum).min(1),
});
export type RegisterMessage = z.infer<typeof RegisterMessageSchema>;

export const WakeDetectedMessageSchema = z.object({
  deviceId: uuid,
  score: z.number().min(0).max(1),
  timestamp: iso8601,
});
export type WakeDetectedMessage = z.infer<typeof WakeDetectedMessageSchema>;

export const SessionStartMessageSchema = z.object({
  deviceId: uuid,
  sessionId: uuid,
  userId: z.string().nullable(),
  sampleRate: z.number().int().positive(),
  codec: CodecEnum,
  mode: SessionModeEnum.optional(),
});
export type SessionStartMessage = z.infer<typeof SessionStartMessageSchema>;

export const EarSessionEndMessageSchema = z.object({
  sessionId: uuid,
  reason: EarEndReasonEnum,
});
export type EarSessionEndMessage = z.infer<typeof EarSessionEndMessageSchema>;

// ─────────────────────────────────────────────────────────────────────
// Core → Ear event payloads.
// ─────────────────────────────────────────────────────────────────────

export const AckMessageSchema = z.object({
  deviceId: uuid,
});
export type AckMessage = z.infer<typeof AckMessageSchema>;

export const WakeAckMessageSchema = z.object({
  action: WakeActionEnum,
});
export type WakeAckMessage = z.infer<typeof WakeAckMessageSchema>;

export const PartialTranscriptMessageSchema = z.object({
  sessionId: uuid,
  text: z.string(),
  isFinal: z.literal(false),
});
export type PartialTranscriptMessage = z.infer<typeof PartialTranscriptMessageSchema>;

export const FinalTranscriptMessageSchema = z.object({
  sessionId: uuid,
  text: z.string(),
});
export type FinalTranscriptMessage = z.infer<typeof FinalTranscriptMessageSchema>;

// Drives the interactive overlay on the Ear: visual state + optional cue
// sound in a single atomic message. The `seq` field is strictly
// monotonic per device per connection so the Ear can drop any
// out-of-order delivery.
export const OverlayUpdateMessageSchema = z.object({
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
  seq: z.number().int().positive(),
  view: ListViewSchema,
});
export type ListViewUpdateMessage = z.infer<typeof ListViewUpdateMessageSchema>;

export const CoreSessionEndMessageSchema = z.object({
  sessionId: uuid,
  reason: CoreEndReasonEnum,
  detail: z.string().optional(),
});
export type CoreSessionEndMessage = z.infer<typeof CoreSessionEndMessageSchema>;

export const SessionModeChangeMessageSchema = z.object({
  sessionId: uuid,
  mode: SessionModeEnum,
});
export type SessionModeChangeMessage = z.infer<typeof SessionModeChangeMessageSchema>;

// Backend-initiated capture arming. Instructs the Ear to open a fresh
// capture session under the given mode without requiring a wake-word.
// The Ear plays the mode-appropriate cue, then sends its normal
// `session_start` with the same `mode` field set.
export const ArmCaptureMessageSchema = z.object({
  mode: SessionModeEnum,
  captureMs: z.number().int().positive().optional(),
});
export type ArmCaptureMessage = z.infer<typeof ArmCaptureMessageSchema>;
