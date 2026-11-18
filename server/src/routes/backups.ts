// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Minimal backup/export routes (R24-DEC2E, AD-201 item 2A). Exactly
// one route lives here:
//
//   POST /api/backups/export
//
// It answers synchronously with 200 and a plaintext JSON workspace
// export document as a file download (see
// services/workspace/export.ts for the document shape and honesty
// rules). This is a deliberate minimal subset of kontrak 3.10, and
// the deviations are stated here so no reader mistakes it for the
// full V1-17 design:
//
// - Kontrak 3.10 answers 202 with an async job, polled at
//   GET /api/backups/jobs/:jobId, downloaded at
//   GET /api/backups/downloads/:downloadToken. This route answers
//   200 with the document in the response body. No job store, worker,
//   or token store exists in this server, and an in-memory stand-in
//   would lose jobs on restart; a synchronous answer is the honest
//   minimal form. The job and download-token routes remain
//   unregistered and answer 404.
// - Kontrak 3.10 archives use the encrypted notegen-web-backup v1
//   format (.ngwbackup, AES-256-GCM). This route returns unencrypted
//   JSON ("notegen-web-export" v1). It must never be described as an
//   encrypted backup, and no restore path reads it.
// - Create/list/get/download of managed backups (POST/GET
//   /api/backups, GET /api/backups/:id, GET /api/backups/:id/download)
//   remain unregistered and answer 404. Restore stays the explicit
//   501 stub in routes/stubs.ts (Fase 2).
// - The request body, when present, must be a JSON object (the
//   contract body is {}); unknown fields are ignored, matching the
//   read-route convention for unknown parameters. The export has no
//   side effects, so no idempotency key is needed: repeating the
//   request returns a fresh snapshot.
// - Authentication comes from the frozen global auth hook
//   (middleware/auth-hook.ts): the route sets requiresAuth true, so
//   a request without a valid session answers 401 and a mutation
//   with a bad Origin or CSRF token answers 403. The response is a
//   raw-body download (kontrak 2.3 exception, like media and asset
//   downloads): success carries no envelope, while pre-body failures
//   use the error envelope through the global error handler.
//   Cache-Control is no-store and the body hash travels in the
//   X-Export-SHA256 header, mirroring the X-Backup-SHA256 download
//   convention of kontrak 3.10.

import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiError } from '../plugins/envelope.js';
import { createWorkspaceExporter } from '../services/workspace/export.js';

export const EXPORT_PATH = '/api/backups/export';

export interface BackupRouteDeps {
  workspaceRoot: string | undefined;
}

function validateExportBody(body: unknown): void {
  if (body === undefined || body === null) {
    return;
  }
  if (typeof body !== 'object' || Array.isArray(body)) {
    throw ApiError.validation('The export request body must be a JSON object.');
  }
}

export async function registerBackupRoutes(
  app: FastifyInstance,
  deps: BackupRouteDeps,
): Promise<void> {
  const exporter = createWorkspaceExporter({ workspaceRoot: deps.workspaceRoot });

  app.post(
    EXPORT_PATH,
    { config: { requiresAuth: true } },
    async (request: FastifyRequest, reply: FastifyReply) => {
      validateExportBody(request.body);
      const exportDocument = await exporter.exportWorkspace();
      const body = JSON.stringify(exportDocument);
      const bodyBytes = Buffer.from(body, 'utf8');
      const fileName = `notegen-export-${exportDocument.exportedAt.replace(/[:.]/g, '-')}.json`;
      reply.header('Content-Type', 'application/json');
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
      reply.header('Cache-Control', 'no-store');
      reply.header('X-Export-SHA256', createHash('sha256').update(bodyBytes).digest('hex'));
      reply.header('Content-Length', String(bodyBytes.length));
      return reply.code(200).send(body);
    },
  );
}
