## ADDED Requirements

### Requirement: `vad` capability declares a wake-wordless entry contract

The `Capability` enum SHALL accept the value `vad` in addition to `mic`, `wake`, `speaker`, and `display`. A device that includes `vad` in `register.capabilities` SHALL be understood to open capture sessions on voice-activity detection rather than wake-word detection. A device MAY declare both `wake` and `vad` (multi-modal), only `vad` (no wake-word), or only `wake` (today's Mac default); the union of declared capabilities is the device's contract for the duration of the connection.

The TypeScript Zod validator and the Swift Codable decoder SHALL both accept `vad` as a first-class `Capability` value. Round-trip fixture coverage SHALL include a `register` payload whose `capabilities` includes `vad`.

#### Scenario: `register` accepts the `vad` capability

- **WHEN** the validator is given `{ "deviceId": "<uuid>", "deviceName": "Nikita's iPhone", "capabilities": ["mic","vad","speaker"] }`
- **THEN** validation SHALL succeed on both TypeScript and Swift sides

#### Scenario: Swift fixture round-trips `vad` capability

- **WHEN** the fixture suite encodes a `register` payload with `capabilities: ["mic", "vad", "speaker"]` and decodes it
- **THEN** the round-trip output SHALL be byte-equivalent to the input

### Requirement: VAD-capable session-entry trigger contract

A device whose `register.capabilities` includes `vad` SHALL be permitted to emit `session_start` on local voice-activity detection, without a preceding `wake_detected`. This is the explicit semantic of the `vad` capability and SHALL be documented in the protocol package's README and in the inline comments next to the `Capability` enum, so that any new client implementation reads the trigger contract from a single source.

A device that declares `wake` but not `vad` SHALL continue to use the wake-word trigger model: `session_start` follows a local `wake_detected`. Mixing the two on the same device (declaring both) is permitted; either trigger SHALL be a valid path to `session_start` for such a device.

Core MAY enforce this contract at the gateway in a future change (rejecting a `session_start` from a wake-only device without a recent `wake_detected`). The present change does NOT add such enforcement — the contract is declarative at the protocol layer and binding on the client. The protocol package's documentation SHALL state explicitly that "Core does not enforce the wake precondition today; clients SHALL still follow the contract appropriate to their capabilities."

#### Scenario: VAD-only device documents wake-wordless entry

- **WHEN** an implementor reads the `Capability` enum documentation
- **THEN** the comment block SHALL describe that a `vad`-only device opens `session_start` on voice-activity detection with no preceding `wake_detected`

#### Scenario: Wake-only device documentation is preserved

- **WHEN** an implementor reads the `Capability` enum documentation
- **THEN** the comment block SHALL describe that a `wake`-capable device opens `session_start` after a local `wake_detected` (current Mac behavior)
