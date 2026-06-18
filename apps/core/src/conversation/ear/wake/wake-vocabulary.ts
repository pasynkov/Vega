// Core-side wake-word vocabulary. The mac-ear OpenWakeWord detector
// emits a wake event when it recognises one of the bundled candidate
// classifiers (currently "Janet" and "edna"); the Ear keeps streaming
// audio after the wake event so the wake word itself shows up as the
// first STT final. We drop that first final at the orchestrator boundary
// so the supervisor does not see "Этна." as a user turn.
//
// Entries are compared case-insensitively against the trimmed final
// text. Russian transliterations cover the common Deepgram outputs for
// the English wake words.

const VOCAB = [
  "janet",
  "edna",
  "этна",
  "эдна",
  "джанет",
  "дженет",
  "эднa", // catches mixed-script garbage from STT (Cyrillic а)
];

export function isWakeWordFinal(text: string): boolean {
  const normalised = text.trim().toLowerCase().replace(/[.,!?]+$/u, "");
  if (normalised.length === 0) return true; // empty after strip — drop too
  if (normalised.length > 40) return false; // anything long is a real sentence
  return VOCAB.some((word) => normalised === word || normalised === word + ".");
}
