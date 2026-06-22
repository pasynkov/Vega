# Vega Ear — iOS

iPhone Ear surface. Foreground-only microphone, VAD-triggered sessions, full-screen overlay, server endpoint configured through iOS Settings.app.

## Status

Source files are committed; the Xcode project itself is **not** generated yet. You need to create it once and add it to git (or generate via XcodeGen / a similar tool).

## Bootstrap

1. Open Xcode → File → New → Project → iOS → App.
2. Product name: `VegaEariOS`. Interface: SwiftUI. Language: Swift. Bundle ID: anything personal, e.g. `me.pasynkov.VegaEar`.
3. Save the new project under `apps/ios-ear/`. Xcode will create `VegaEariOS.xcodeproj/` next to the existing `VegaEariOS/` source folder. Delete the auto-generated `VegaEariOS/` subfolder Xcode creates inside its own project and re-add the existing one (the one already committed here) as a folder reference.
4. Replace the generated `Info.plist` with the one already in `VegaEariOS/Info.plist`.
5. Add `Settings.bundle` to the target (drag it from `VegaEariOS/Settings.bundle` into the project navigator and tick the target).
6. Set deployment target to iOS 26.0.
7. Add Swift Package dependencies (local):
   - `packages/ear-protocol/swift` → product `EarProtocol`
   - `packages/ear-core` → product `EarCore`
   - `packages/ear-ui` → product `EarUI`
8. Confirm `Info.plist` includes `NSMicrophoneUsageDescription` and does NOT include `UIBackgroundModes: audio`.
9. Set the team to your personal Apple ID, plug in your iPhone, hit Run.

## What's included

- `VegaEariOSApp.swift` — `@main App`, scene wiring, status-bar hiding, lifecycle hooks.
- `AppCoordinator.swift` — top-level wiring: SessionCoordinator + iOS platform impls + VAD trigger + endpoint reconciliation on `didBecomeActive`.
- `iOSAudioCapturing.swift` — `AVAudioEngine` tap → Int16 PCM frames → SessionCoordinator sinks.
- `iOSCuePlayer.swift` — `AVAudioPlayer` cue playback (falls back to a system sound when bundled assets are missing).
- `iOSStatusController.swift` — no-op StatusControlling (iOS has no menu bar; state is logged).
- `iOSOverlayController.swift` — main-thread bridge that forwards `overlay_update` / `list_view_update` to the shared `OverlayViewModel`.
- `Info.plist` — mic-usage string, no background audio mode.
- `Settings.bundle/Root.plist` — one `PSTextFieldSpecifier` for `server_endpoint`.

## Manual verification (Phase 5 gate)

Run through this checklist on a physical iPhone with iOS 26+ before declaring the change shippable:

- [ ] Cold launch shows the `idle` overlay full-screen.
- [ ] Speaking opens a session; the overlay transitions through `listening → capturing → thinking → success → idle` matching Core's emitted overlay_updates.
- [ ] A `list_view_update {open: true}` for shopping renders the list full-screen.
- [ ] A `list_view_update {open: false}` collapses the list.
- [ ] Backgrounding the app closes the active session cleanly.
- [ ] Changing the endpoint in Settings.app forces reconnect to the new endpoint on app return.
- [ ] Cue sounds play through the device speaker.
