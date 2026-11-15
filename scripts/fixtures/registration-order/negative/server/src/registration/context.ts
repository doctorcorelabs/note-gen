// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fixture-only RegistrationContext stand-in for the
// check-registration-order fixtures. Not production code.

import type { FixtureApp } from '../routes/mini-app.js';

export interface RegistrationContext {
  app: FixtureApp;
  version: string;
  workspaceRoot: string;
}
