// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// DA-3 (SET-10): sampling parameters for non-streaming AI requests.
// A user-set temperature/topP of 0 is a real value (deterministic
// output) and must reach the provider unchanged; only an unset
// value falls back to 1. The streaming path already forwards the
// raw values, so both paths now agree.

export interface SamplingConfig {
  temperature?: number
  topP?: number
}

export function resolveSamplingParams(config?: SamplingConfig): {
  temperature: number
  top_p: number
} {
  return {
    temperature: config?.temperature ?? 1,
    top_p: config?.topP ?? 1,
  }
}
