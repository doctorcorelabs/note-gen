// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// E2E-S4: archive download. An export archive is produced and
// downloaded as a file through the browser. Design sources:
// fase1/desain-backup-hardening.md (V1-17) section 2.2 and
// fase1/kontrak-api-kanonis.md section 3.10 (backup and export):
// POST /api/backups/export answers 202 with a job, the job is polled
// at GET /api/backups/jobs/:jobId, and the finished job carries a
// downloadUrl of the form GET /api/backups/downloads/:downloadToken
// (single-use token in the path, short expiry). An existing backup
// can also be downloaded at GET /api/backups/:id/download. Archives
// use the notegen-web-backup v1 format, extension .ngwbackup,
// AES-256-GCM encrypted; the client never receives a decrypted
// archive.
//
// Status: TODO. This test fails explicitly with "fitur belum mendarat"
// until the feature lands. Do not convert it to skip/fixme and do not
// add placeholder assertions. This spec carries the @scaffold tag, not
// @smoke: it is outside the six @smoke flows of desain-pengujian
// section 4, and its justification is recorded in tests/e2e/README.md
// as section 4.4 requires. Note also that desain-pengujian section
// 4.4 excludes "impor/ekspor massal" from MVP E2E; this spec covers
// the single-archive download the recovery brief lists as critical,
// not bulk import/export, and the distinction is recorded in the
// README justification.
//
// SELECTOR STATUS: NOT VERIFIABLE. No web backup/export UI exists:
// the upstream backup settings page (backup-settings.tsx) is a
// desktop directory-based UI (choose a local directory through a
// Tauri dialog, scheduled local backups), which has no web
// equivalent. There are deliberately no archive locators in
// harness/selectors.ts. The flow author must NOT guess a button or a
// page: the UI owner ships the export trigger first, and the flow
// author derives the locator from that shipped UI.
//
// Intended steps (replace the notYetLanded call when the feature lands):
// 1. Open the shipped backup/export UI and trigger one export. The
//    trigger is whatever the shipped UI provides; until it ships,
//    this step cannot be written.
// 2. Wait for the export job EFFECT by observation: poll the job
//    status through the API request context until status is
//    "succeeded" (expect.poll with a timeout derived from the stated
//    job bound), never by a fixed sleep. A failed job fails the test
//    with the job error attached.
// 3. Start the download through the UI and capture it with the
//    Playwright download event (page.waitForEvent('download')).
//    Assert the suggested filename ends in .ngwbackup.
// 4. Save the download to the test output directory and assert the
//    bytes are non-empty and the SHA-256 of the downloaded bytes
//    equals the X-Backup-SHA256 response header (kontrak 3.10).
//    Read the header from the download response via the API request
//    context against the same downloadUrl ONLY before the token is
//    consumed: the token is single-use, so a second GET answers 404
//    by design. The flow must therefore capture the header from the
//    browser download response itself, or compare against the hash
//    the job/list response reports. Do not fetch the token URL twice.
// 5. Assert the archive is NOT decrypted client-side: the downloaded
//    bytes must not contain readable workspace content (assert over
//    a fixed canary string seeded in the workspace, not over real
//    user content). Decryption and restore are out of scope: restore
//    answers 501 in the MVP (kontrak section 7).
// RATE LIMIT CAUTION: export/backup endpoints are limited to 5
// requests per 10 minutes per account (kontrak section 1, V1-08
// section 6.5). This spec triggers at most one export per run.

import { test } from '@playwright/test'

import { notYetLanded } from './harness/todo'

test('E2E-S4 @scaffold archive download: exported archive downloads with matching hash', async () => {
  notYetLanded(
    'E2E-S4',
    'the backup/export backend plus the job polling path plus a web ' +
      'export trigger UI have not landed; no archive can be produced ' +
      'or downloaded through the web UI yet.',
  )
})
