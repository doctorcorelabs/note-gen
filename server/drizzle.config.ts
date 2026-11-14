// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// drizzle-kit configuration for the API server package.
//
// Generate a new versioned migration after editing the Drizzle schema:
//
//   cd server
//   pnpm db:generate
//
// Generated SQL in server/drizzle/ is never edited by hand. If generated
// output is wrong, fix the schema and generate again before the migration
// has been applied anywhere; after that, the fix is a new migration.
// The journal file server/drizzle/meta/_journal.json is committed with
// the SQL and is never edited by hand either.
//
// DATABASE_URL is read from the environment. Generation itself needs no
// live database; the migrator in src/db/migrate.ts is what applies the
// SQL to a real database.

import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  verbose: true,
  strict: true,
});
