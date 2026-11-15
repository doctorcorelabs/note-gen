// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// CSP reports registration adapter (AD-61; desain registrasi
// programatik section 3.3, rank 150). Verbatim move of the CSP block
// of buildApp (app.ts, V3-39b; canonical contract section 3.11).
//
// Routes declared by this group (via registerCspReportRoutes,
// routes/csp-reports.ts):
// - POST /api/csp-reports (204 empty, no session)
// Deps: none; the registrar is called with no arguments, so its
// default deps apply (default rate limiter, log-only record), as in
// app.ts. No session, no CSP header set here; directive values
// belong to the hardening wave (O-07).
// K-09 behavior preserved (AD-66): unknown fields in a report are
// discarded by the pick-field allowlist in parseCspReportBody, and
// this adapter adds no unknown-field rejection. Known fields with
// a wrong type still answer 400 validation_failed in the registrar.

import type { RegistrationContext } from '../registration/context.js';
import { registerCspReportRoutes } from './csp-reports.js';

export const REGISTRATION_ID = 'csp-reports' as const;
export const REGISTRATION_ORDER = 150;

export async function registerGroup(ctx: RegistrationContext): Promise<void> {
  await registerCspReportRoutes(ctx.app);
}
