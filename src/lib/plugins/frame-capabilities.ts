// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Sandboxed plugin frame capabilities: no-op by design (AD-14, F8
// section 5.2 item 3, W4-SEC).
//
// Upstream, this module was the only capability channel exposed to a
// sandboxed plugin iframe: terminal sessions over backend commands.
// Terminal execution is removed permanently from the fork web: no
// phase enables it, no flag enables it, and no server equivalent may
// be built. The module therefore exposes no capability at all. It is
// kept as a file, rather than deleted, so the single caller keeps one
// explicit capability boundary and a future phase cannot silently
// resurrect terminal sessions by re-adding invoke calls here: any
// capability request receives an error reply, and this module imports
// no invoke, event, or platform adapter, so there is no path from a
// frame request to a backend command.
//
// The message channel itself is retained by the caller for host theme
// and settings updates. Only capability handling is a no-op: the
// frame can never open a session, write input, resize, or close, and
// no session state exists.

interface FrameRequest { id?: unknown; method?: unknown; sessionId?: unknown; data?: unknown; cols?: unknown; rows?: unknown }

export async function connectPluginFrameCapabilities(options: {
  port: MessagePort
}): Promise<{ handle: (request: FrameRequest) => void; dispose: () => void }> {
  const { port } = options
  let active = true
  const send = (message: Record<string, unknown>) => { if (active) port.postMessage(message) }

  const handle = (request: FrameRequest) => {
    if (!active || typeof request.id !== 'number' || !Number.isSafeInteger(request.id) || typeof request.method !== 'string') return
    // Every capability method is unavailable. The reply carries the
    // request id so the frame never waits on a pending call.
    send({ id: request.id, error: 'Capability unavailable' })
  }
  const dispose = () => {
    active = false
  }
  return { handle, dispose }
}
