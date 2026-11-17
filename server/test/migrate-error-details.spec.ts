// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Tests for the structured migration-error contract
// (db/migrate.ts; PREDEPLOY finding F-01, AD-131). The boot log may
// carry only validated codes, families, and migration tags, never
// an error message: these tests pin the reader that extracts those
// details from an error and its cause chain, and the machine codes
// the manifest reader attaches to its own failures. The apply
// wrapper claims no migration tag (the post-failure journal state
// does not identify the failing migration), so no helper derives
// one. Live-database proof that a failed apply run logs the driver
// code with no tag claim and no SQL belongs to the merge gate on
// muse-2, which has Postgres; no database runs in this file.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isSafeMigrationErrorCode,
  isSafeMigrationTag,
  MIGRATION_MANIFEST_CODE,
  readMigrationErrorDetails,
  readMigrationManifest,
} from '../src/db/migrate.js';

describe('readMigrationErrorDetails', () => {
  it('reads a top-level code and tag', () => {
    const error = new Error('Failed query: SELECT 1') as Error & { code: string; migrationTag: string };
    error.code = '42P01';
    error.migrationTag = '0002_m8-tighten';
    expect(readMigrationErrorDetails(error)).toEqual({ code: '42P01', migrationTag: '0002_m8-tighten' });
  });

  it('walks the cause chain and prefers the outermost valid value', () => {
    const inner = new Error('inner') as Error & { code: string; migrationTag: string };
    inner.code = '42P07';
    inner.migrationTag = '0001_inner';
    const outer = new Error('outer') as Error & { cause: Error; migrationTag: string };
    outer.cause = inner;
    outer.migrationTag = '0002_outer';
    expect(readMigrationErrorDetails(outer)).toEqual({ code: '42P07', migrationTag: '0002_outer' });
  });

  it('rejects code and tag values that fail validation', () => {
    const error = new Error('boom') as Error & { code: string; migrationTag: string };
    error.code = '42P01; DROP TABLE users';
    error.migrationTag = '../escape';
    expect(readMigrationErrorDetails(error)).toEqual({});
    expect(isSafeMigrationErrorCode('ECONNREFUSED')).toBe(true);
    expect(isSafeMigrationErrorCode('')).toBe(false);
    expect(isSafeMigrationErrorCode('has space')).toBe(false);
    expect(isSafeMigrationTag('0002_m8-tighten')).toBe(true);
    expect(isSafeMigrationTag('')).toBe(false);
    expect(isSafeMigrationTag('/abs/path')).toBe(false);
  });

  it('keeps only validated missing tags, capped at twenty', () => {
    const error = new Error('drift') as unknown as Record<string, unknown>;
    error.code = 'MIGRATION_DRIFT';
    error.missingTags = ['0003_ok', '../bad', ...Array.from({ length: 25 }, (_, i) => `tag-${i}`)];
    const details = readMigrationErrorDetails(error);
    expect(details.code).toBe('MIGRATION_DRIFT');
    expect(details.missingTags).toHaveLength(20);
    expect(details.missingTags?.[0]).toBe('0003_ok');
    expect(details.missingTags).not.toContain('../bad');
  });

  it('terminates on a cyclic cause chain and on non-object input', () => {
    const cyclic = new Error('loop') as unknown as Record<string, unknown>;
    cyclic.cause = cyclic;
    expect(readMigrationErrorDetails(cyclic)).toEqual({});
    expect(readMigrationErrorDetails('a string')).toEqual({});
    expect(readMigrationErrorDetails(null)).toEqual({});
    expect(readMigrationErrorDetails(undefined)).toEqual({});
  });
});

describe('readMigrationManifest error codes', () => {
  it('attaches the manifest code when the journal is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-manifest-'));
    try {
      let caught: unknown;
      try {
        await readMigrationManifest(dir);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(readMigrationErrorDetails(caught).code).toBe(MIGRATION_MANIFEST_CODE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('attaches the manifest code and the tag when a named SQL file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'migrate-manifest-'));
    try {
      await mkdir(join(dir, 'meta'), { recursive: true });
      await writeFile(
        join(dir, 'meta', '_journal.json'),
        JSON.stringify({ entries: [{ idx: 0, tag: '0002_m8-tighten' }] }),
        'utf8',
      );
      let caught: unknown;
      try {
        await readMigrationManifest(dir);
      } catch (error: unknown) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect(readMigrationErrorDetails(caught)).toEqual({
        code: MIGRATION_MANIFEST_CODE,
        migrationTag: '0002_m8-tighten',
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
