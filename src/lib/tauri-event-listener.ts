// Transition re-export (G2 to G4): the implementation moved to
// src/lib/platform/event/event-listener.tauri.ts at G2. This file is
// deleted at G4 when the Event migration completes. It must not import
// any @tauri-apps/* module.
export { listenTauriEvent } from "@/lib/platform/event/event-listener.tauri";
