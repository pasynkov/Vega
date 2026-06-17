// Binary `audio_frame` wire format:
//   [0..8)  unsigned 64-bit little-endian session short id
//   [8..)   raw OPUS packet bytes
//
// The "session short id" is a stable, compact identifier derived from the
// session UUID (first 8 bytes of the UUID interpreted as little-endian u64).
// Mapping UUID <-> short id is symmetric on both sides; collision probability
// within a single connection's lifetime is negligible for a single user.

export const AUDIO_FRAME_HEADER_SIZE = 8;

export function sessionShortIdFromUuid(uuid: string): bigint {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`invalid UUID: ${uuid}`);
  }
  // Take the first 8 bytes (16 hex chars) of the UUID, interpret little-endian.
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    const byteHex = hex.substring(i * 2, i * 2 + 2);
    result = (result << 8n) | BigInt(parseInt(byteHex, 16));
  }
  return result;
}

export function encodeAudioFrame(sessionId: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(AUDIO_FRAME_HEADER_SIZE + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, sessionShortIdFromUuid(sessionId), true);
  out.set(payload, AUDIO_FRAME_HEADER_SIZE);
  return out;
}

export function decodeAudioFrame(
  bytes: Uint8Array,
): { sessionShortId: bigint; payload: Uint8Array } {
  if (bytes.byteLength < AUDIO_FRAME_HEADER_SIZE) {
    throw new Error(
      `audio frame too short: ${bytes.byteLength} bytes, need at least ${AUDIO_FRAME_HEADER_SIZE}`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sessionShortId = view.getBigUint64(0, true);
  const payload = bytes.subarray(AUDIO_FRAME_HEADER_SIZE);
  return { sessionShortId, payload };
}
