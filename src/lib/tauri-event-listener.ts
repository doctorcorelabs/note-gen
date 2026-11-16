// Transition re-export (G2 to 3D): the implementation moved to
// src/lib/platform/event/event-listener.tauri.ts at G2. This file is
// deleted at 3D when the registry-surface decision for listenTauriEvent
// lands (AD-91). It must not import any @tauri-apps/* module.
// eslint-disable-next-line no-restricted-imports -- AD-91: deletion deferred to 3D; remove together with this file
export { listenTauriEvent } from "@/lib/platform/event/event-listener.tauri";
