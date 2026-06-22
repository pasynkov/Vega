# ios-ear Specification

## Purpose
TBD - created by archiving change ios-ear-and-design-system-v1. Update Purpose after archive.
## Requirements
### Requirement: iOS application target and platform

The repository SHALL host an iOS application target at `apps/ios-ear/` implemented as an Xcode project. The target's minimum deployment SHALL be iOS 26.0. The app SHALL be a single-window SwiftUI application using the `@main App` lifecycle; there SHALL be no UIKit `AppDelegate` lifecycle in v1.

The target SHALL depend on `EarCore`, `EarUI`, and `EarProtocol` via local SPM package references (relative paths to `packages/ear-core/swift/`, `packages/ear-ui/swift/`, `packages/ear-protocol/swift/`).

Distribution SHALL be developer-sideload (signed with a personal Apple ID development team). No TestFlight, App Store Connect, or notarization workflow SHALL be added in v1.

#### Scenario: Project builds against iOS 26 simulator and device

- **WHEN** the developer opens `apps/ios-ear/ios-ear.xcodeproj` and selects an iOS 26 simulator or a connected iPhone running iOS 26+
- **THEN** the project SHALL build with no warnings about platform availability for `EarCore` and `EarUI` symbols

### Requirement: Foreground-only microphone, `.playAndRecord` session

The iOS Ear SHALL request microphone access on first launch with `NSMicrophoneUsageDescription` set to a clear Russian-language explanation (e.g., "Vega Ear слушает голосовые команды, пока приложение открыто."). It SHALL NOT include `UIBackgroundModes: audio` in the Info.plist. The microphone SHALL be active only while the app is in the `.active` scene phase.

`AVAudioSession.sharedInstance()` SHALL be configured with category `.playAndRecord`, mode `.voiceChat`, and options including `.duckOthers` and `.defaultToSpeaker`. The session SHALL be activated when the app enters `.active` and deactivated (`.notifyOthersOnDeactivation`) when entering `.background` or `.inactive`.

When the app moves to `.inactive` or `.background`, any active capture session SHALL be closed with `session_end` reason `user` and the WebSocket SHALL stay open (so reconnect on return is fast).

#### Scenario: First launch requests mic permission

- **WHEN** the user launches the app for the first time
- **THEN** the system mic permission prompt SHALL appear
- **AND** the displayed reason SHALL be the Russian-language string from Info.plist

#### Scenario: App backgrounding terminates capture

- **WHEN** the app is mid-session and the user swipes up to the home screen
- **THEN** the Ear SHALL emit `session_end` with reason `user` for the active session
- **AND** the WebSocket SHALL NOT be closed by the Ear

#### Scenario: Audio session mode permits cue playback during capture

- **WHEN** the app receives `overlay_update.state.sound = "ack_success"` during an active capture session
- **THEN** the cue SHALL play through the speaker
- **AND** capture audio SHALL continue uninterrupted

### Requirement: No wake-word; VAD-triggered sessions

The iOS Ear SHALL register with `capabilities` including `vad` and SHALL NOT include `wake` in its registration. It SHALL NOT bundle, link, or instantiate any wake-word detector; `onnxruntime-swift-package-manager` SHALL NOT be a dependency of the iOS target.

A capture session SHALL open when the in-process `SilenceDetector` reports a voice-activity onset (energy above threshold for ≥ the configured minimum-voice-duration). A session SHALL terminate when the detector reports silence offset (energy below threshold for ≥ the configured silence-hold-duration). Both parameters SHALL be readable from `UserDefaults` keys exposed in the Settings.bundle (with conservative defaults that err toward fewer false starts).

While the app is in `.active` and an `overlay_update.state.kind` is `idle`, the detector SHALL be running.

#### Scenario: iOS register payload includes `vad` and omits `wake`

- **WHEN** the iOS Ear sends `register`
- **THEN** `capabilities` SHALL include `"vad"`
- **AND** `capabilities` SHALL NOT include `"wake"`

#### Scenario: Voice activity opens a session

- **WHEN** the app is foregrounded, the overlay is `idle`, and the user speaks above the energy threshold for the minimum-voice-duration
- **THEN** the Ear SHALL emit `session_start` (without any prior `wake_detected`)
- **AND** the overlay SHALL transition to `listening` on receipt of the next `overlay_update` from Core

### Requirement: Full-screen overlay rendering

The app's root view SHALL be `EarUI.OverlayView` in `fullScreen` layout, bound to a view-model from `EarCore` driven by `overlay_update` and `list_view_update` messages. The view SHALL fill the entire screen including the safe-area insets (the background extends edge-to-edge; the morph mark and text respect a comfortable inset).

The view SHALL NOT integrate with Dynamic Island, Live Activities, or any ActivityKit surface in v1.

The status bar SHALL be hidden during overlay states other than `idle`; during `idle` it MAY be visible at the host shell's discretion.

#### Scenario: Background extends edge-to-edge

- **WHEN** the app is launched on a device with a Dynamic Island cutout
- **THEN** the `Theme.background` SHALL render under the status bar and to all screen edges
- **AND** the morph mark SHALL be centered within the safe area

#### Scenario: List view appears full-screen

- **WHEN** the app receives `list_view_update { open: true, view: { title: "Список покупок", items: [...] } }`
- **THEN** the list SHALL render full-screen using the `EarUI.ListView` panel layout

### Requirement: Server endpoint via Settings.bundle

The app SHALL expose a single user-configurable setting — the WebSocket server endpoint URL — via an iOS `Settings.bundle`. The setting SHALL appear under iOS Settings.app → Vega Ear as a single text field labeled "Server endpoint" (Russian: "Адрес сервера"), with a default value of `ws://localhost:3000`.

The value SHALL be read from `UserDefaults.standard.string(forKey: "server_endpoint")`. The app SHALL re-read the value on launch and on `UIApplication.didBecomeActiveNotification`. When the value changes from a previously-stored one, the app SHALL tear down the active WebSocket connection (if any) and reconnect using the new endpoint.

The app SHALL NOT expose an in-app screen for endpoint configuration in v1.

#### Scenario: Endpoint configured before first launch

- **WHEN** the user sets the endpoint to `ws://192.168.1.10:3000` before launching the app
- **THEN** the app on launch SHALL connect to `ws://192.168.1.10:3000`

#### Scenario: Endpoint changed while app is running

- **WHEN** the app is running and the user edits the endpoint in Settings.app, then returns to the app
- **THEN** the app SHALL detect the change on `didBecomeActiveNotification`
- **AND** SHALL close the existing WebSocket and reconnect to the new endpoint within 5 seconds

### Requirement: Device identity persistence and naming

The iOS Ear SHALL persist a stable `deviceId` (UUID v4) in `UserDefaults` under key `device_id`, generated on first launch. The persisted UUID SHALL be reused across app launches and across endpoint changes; it SHALL be regenerated only if the user clears the app's data or reinstalls.

The `deviceName` reported on `register` SHALL be `UIDevice.current.name`. When that returns an empty string, the fallback SHALL be `"iPhone"`.

#### Scenario: deviceId stable across launches

- **WHEN** the app launches twice in succession (terminated in between)
- **THEN** the `register` payload SHALL carry the same `deviceId` on both launches

### Requirement: WebSocket connection lifecycle

The app SHALL maintain a single WebSocket connection to the configured endpoint while it is in the `.active` scene phase, using the same `socket.io-client-swift` library as the Mac Ear (the dependency lives in `EarCore`). On disconnect the app SHALL attempt to reconnect with an exponential backoff starting at 1 s and capped at 30 s.

On `.background`, the connection SHALL be kept open as long as iOS allows (no explicit close from the Ear). On `.willEnterForeground` it SHALL verify connectivity and reconnect if dropped.

The host shell SHALL NOT layer any custom retry logic on top of what `EarCore` already provides; if the Mac shell uses `EarCore.EarSocket`'s reconnect logic, the iOS shell SHALL use the same.

#### Scenario: Reconnect uses backoff

- **WHEN** the connection drops twice in quick succession
- **THEN** the second retry delay SHALL be greater than the first
- **AND** SHALL be capped at 30 s

### Requirement: Manual verification gate on physical device

Phase 5 SHALL not be merged until the app has been built, signed for a personal development team, deployed to a physical iPhone running iOS 26+, and manually verified to pass the following checklist against a local Core:

- Cold launch shows the `idle` overlay full-screen.
- Speaking opens a session; the overlay transitions through `listening → capturing → thinking → success → idle` matching Core's emitted `overlay_update`s.
- A `list_view_update {open: true}` for shopping renders the list full-screen.
- A `list_view_update {open: false}` collapses the list.
- Backgrounding the app closes the active session cleanly.
- Changing the endpoint in Settings.app forces reconnect to the new endpoint on app return.
- Cue sounds (`ack_done`, `ack_success`, `ack_error`) play through the device speaker.

#### Scenario: All checklist items pass on device

- **WHEN** the developer runs through the seven items above on a physical iPhone with iOS 26+
- **THEN** all SHALL pass
- **AND** the result SHALL be recorded in the change's tasks file before archive

