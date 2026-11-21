// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-08): classify a failed STT connection check. The
// check sends 100 zero bytes as test.webm; a provider that is
// reachable with a valid key and model rejects the audio format
// (HTTP 400), which proves route, model, and auth all work.
// Every other failure (401/403 auth, 404 route/model, 5xx incl.
// the web-mode 501 not-implemented rejection, network errors)
// must surface as a failed check instead of a false success.
// Provider errors arrive as message strings (tauri-client
// toAbortError), so classification is text based, matching the
// existing 401/403 pattern in model-card.tsx.

export function isSttFormatRejection(error: unknown): boolean {
  if (
    typeof error === "object" && error !== null && "name" in error
    && (error as { name: unknown }).name === "AbortError"
  ) {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return message.includes("400")
}
