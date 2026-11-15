// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Single onClose integration point for the registration adapters.
//
// registerCloseHook registers exactly one Fastify onClose hook that
// runs the shared close registry in append order (auth first, then
// db). It is called once, and only when an auth context is present,
// preserving the FIX-05 gate: without auth there is no hook and the
// db runner is not closed from this path (server.ts always supplies
// auth, so production is unaffected).
//
// In the registration form this call lives in the auth-core adapter,
// the only adapter allowed an onClose hook (desain registrasi seksi
// 3.1 butir 4). The db adapter never touches addHook: it only
// appends its step to the registry. The hook body reads the registry
// at close time, so the db step appended later by the db adapter is
// still run, after the auth step.

import type { FastifyInstance } from 'fastify';
import { runCloseSteps, type CloseRegistry } from './close-registry.js';

export function registerCloseHook(app: FastifyInstance, registry: CloseRegistry): void {
  app.addHook('onClose', async () => {
    await runCloseSteps(registry);
  });
}
