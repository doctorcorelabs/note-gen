// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Ordered shutdown steps shared by the route-group registration
// adapters.
//
// FIX-05 wired a single Fastify onClose hook in buildApp that closes
// the auth context first and the db runner second. The registration
// refactor (AD-61) splits those two closes across two adapters that
// run at different ranks (auth-core 20, db 100), and the db deps
// instance only exists inside the db adapter. A shared registry
// keeps the single-hook, auth-then-db order: each close adapter
// appends its step, and the one onClose hook runs the steps in
// append order when the app closes.
//
// The registry is append-only and its steps run sequentially. A step
// that throws aborts the remaining steps, matching the sequential
// awaits of the FIX-05 hook body. Steps are collected during
// registration and run only at close time, so a step appended by a
// later adapter is still honored by a hook registered earlier: the
// hook reads the live step list, not a snapshot taken at
// registration time.

export type CloseStep = () => Promise<void>;

export interface CloseRegistry {
  readonly steps: readonly CloseStep[];
  append(step: CloseStep): void;
}

export function createCloseRegistry(): CloseRegistry {
  const steps: CloseStep[] = [];
  return {
    steps,
    append(step: CloseStep): void {
      steps.push(step);
    },
  };
}

export async function runCloseSteps(registry: CloseRegistry): Promise<void> {
  for (const step of registry.steps) {
    await step();
  }
}
