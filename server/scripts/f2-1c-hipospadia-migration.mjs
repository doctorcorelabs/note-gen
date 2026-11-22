// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Hipospadia demo-data migration CLI (Fase 2, wave G-F2-1c).
// Design: fase1/evidence/fase2/rancangan-f2-1.md sections 2.2 and 6.
//
// Runs OUTSIDE the SQL migrations, following the M8 data-procedure
// pattern (server/scripts/m8-data-procedure.mjs): the planner logic
// lives in the compiled citations service
// (dist/services/citations/hipospadia-migration.js, built by
// `npm run build` in server/), and this script owns file reading,
// read-only checks, and the gated apply. DATABASE_URL comes from the
// environment only; it is never printed, and no secret value is ever
// printed. Output is counts, ids, and the mapping report only.
//
// Modes:
//   plan    Offline. Reads --research, --map, --marks files, prints
//           the mapping report. Never connects to a database.
//   dry-run Plan plus read-only database checks (workspace, project
//           emptiness, mark existence). Never writes. Exit 2 when
//           the project already holds citation rows, because apply
//           would refuse.
//   apply   Writes the plan in one transaction with fail-closed
//           prechecks. Refuses (exit 2, writes nothing) when the
//           project is non-empty with different counts. A rerun
//           whose counts already match the plan is a no-op success.
//           Numbers are preserved from research.md; unused
//           references are inserted unnumbered.
//
// Required flags: --research <path> --map <path> --marks <path>.
// Optional: --project-key <key> (default deck-hipospadia),
// --workspace-id <uuid> (default: the single workspace, refused when
// ambiguous), --bibliography-out <path>, --apply-report-out <path>.
//
// Exit codes: 0 success, 2 fail-closed refusal, 1 unexpected error.

import { readFile, writeFile } from 'node:fs/promises';
import postgres from 'postgres';
import {
  HIPOSPADIAS_PROJECT_KEY,
  buildMigrationPlan,
  formatPlanReport,
  parseCitationMap,
  parseResearchReferences,
  plannedBibliographyText,
} from '../dist/services/citations/hipospadia-migration.js';

function parseArgs(argv) {
  const args = { mode: argv[2] };
  for (let i = 3; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === '--research') args.research = value;
    else if (flag === '--map') args.map = value;
    else if (flag === '--marks') args.marks = value;
    else if (flag === '--project-key') args.projectKey = value;
    else if (flag === '--workspace-id') args.workspaceId = value;
    else if (flag === '--bibliography-out') args.bibliographyOut = value;
    else if (flag === '--apply-report-out') args.applyReportOut = value;
    else throw new Error(`unknown flag: ${flag}`);
    i += 1;
  }
  if (!['plan', 'dry-run', 'apply'].includes(args.mode)) {
    throw new Error('mode must be plan, dry-run, or apply');
  }
  for (const key of ['research', 'map', 'marks']) {
    if (typeof args[key] !== 'string' || args[key] === '') {
      throw new Error(`--${key} <path> is required`);
    }
  }
  args.projectKey = args.projectKey ?? HIPOSPADIAS_PROJECT_KEY;
  return args;
}

async function readMarks(path) {
  const text = await readFile(path, 'utf8');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to first-line JSON (psql -At output shape).
  }
  const firstLine = text.split('\n')[0] ?? '';
  const parsed = JSON.parse(firstLine);
  if (!Array.isArray(parsed)) throw new Error('marks file does not hold a JSON array');
  return parsed;
}

async function buildPlan(args) {
  const researchText = await readFile(args.research, 'utf8');
  const mapJson = JSON.parse(await readFile(args.map, 'utf8'));
  const marks = await readMarks(args.marks);
  const refs = parseResearchReferences(researchText);
  const facts = parseCitationMap(mapJson);
  return buildMigrationPlan({
    projectKey: args.projectKey,
    references: refs.references,
    facts: facts.facts,
    marks,
    parseIssues: [...refs.issues, ...facts.issues],
  });
}

function connect() {
  const url = process.env.DATABASE_URL;
  if (typeof url !== 'string' || url === '') {
    throw new Error('DATABASE_URL is required in the environment for this mode');
  }
  return postgres(url, { max: 1 });
}

async function resolveWorkspace(sql, requested) {
  if (typeof requested === 'string' && requested !== '') {
    const rows = await sql`SELECT id FROM workspaces WHERE id = ${requested}`;
    if (rows.length !== 1) return null;
    return rows[0].id;
  }
  const rows = await sql`SELECT id FROM workspaces ORDER BY created_at`;
  if (rows.length !== 1) return null;
  return rows[0].id;
}

async function projectCounts(sql, workspaceId, projectKey) {
  const refs = await sql`
    SELECT count(*)::int AS n FROM "references"
    WHERE workspace_id = ${workspaceId} AND project_key = ${projectKey}`;
  const facts = await sql`
    SELECT count(*)::int AS n FROM facts
    WHERE workspace_id = ${workspaceId} AND project_key = ${projectKey}`;
  const bib = await sql`
    SELECT count(*)::int AS n FROM mark_bibliography WHERE workspace_id = ${workspaceId}`;
  return { references: refs[0].n, facts: facts[0].n, bibliography: bib[0].n };
}

async function main() {
  const args = parseArgs(process.argv);
  const plan = await buildPlan(args);
  console.log(formatPlanReport(plan));
  if (typeof args.bibliographyOut === 'string') {
    await writeFile(args.bibliographyOut, `${plannedBibliographyText(plan)}\n`, 'utf8');
    console.log(`bibliography preview written: ${args.bibliographyOut}`);
  }
  if (args.mode === 'plan') return;

  const sql = connect();
  try {
    const workspaceId = await resolveWorkspace(sql, args.workspaceId);
    if (workspaceId === null) {
      console.error('refusal: workspace not found or ambiguous; pass --workspace-id');
      process.exitCode = 2;
      return;
    }
    console.log(`workspace: ${workspaceId}`);
    const counts = await projectCounts(sql, workspaceId, plan.projectKey);
    console.log(
      `existing rows: references ${counts.references}, facts ${counts.facts}, mark_bibliography ${counts.bibliography}`,
    );
    const markIds = plan.markMatches.map((m) => m.markId);
    const found = await sql`
      SELECT id FROM marks WHERE workspace_id = ${workspaceId} AND id = ANY(${markIds}) AND deleted_at IS NULL`;
    console.log(`marks found live in workspace: ${found.length} of ${markIds.length}`);
    if (found.length !== markIds.length) {
      console.error('refusal: some planned marks are missing or deleted');
      process.exitCode = 2;
      return;
    }
    const alreadyMigrated =
      counts.references === plan.counts.references &&
      counts.facts === plan.counts.facts &&
      counts.bibliography === plan.counts.matchedMarks;
    if (args.mode === 'dry-run') {
      if (counts.references > 0 || counts.facts > 0) {
        console.error(
          alreadyMigrated
            ? 'dry-run: project already matches the plan; apply would be a no-op'
            : 'dry-run: project is non-empty with different counts; apply would refuse',
        );
        process.exitCode = 2;
      } else {
        console.log('dry-run: project empty; apply would insert the plan above');
      }
      return;
    }
    // apply
    if (alreadyMigrated) {
      console.log('apply: counts already match the plan; no-op');
      return;
    }
    if (counts.references > 0 || counts.facts > 0 || counts.bibliography > 0) {
      console.error('refusal: project or bibliography is non-empty with different counts; nothing written');
      process.exitCode = 2;
      return;
    }
    const report = { workspaceId, projectKey: plan.projectKey, references: {}, facts: {} };
    await sql.begin(async (tx) => {
      const refIdByOldNumber = new Map();
      for (const ref of plan.references) {
        const rows = await tx`
          INSERT INTO "references"
            (workspace_id, project_key, number, source_record_id, title, authors, journal, year, doi, pmid, pmcid, url, oa_flag)
          VALUES
            (${workspaceId}, ${plan.projectKey}, ${ref.number}, ${ref.sourceRecordId},
             ${ref.title ?? null}, ${ref.authors ?? null}, ${ref.journal ?? null}, ${ref.year ?? null},
             ${ref.doi ?? null}, ${ref.pmid ?? null}, ${ref.pmcid ?? null}, ${ref.url ?? null}, ${ref.oaFlag ?? null})
          RETURNING id`;
        refIdByOldNumber.set(ref.oldNumber, rows[0].id);
        report.references[ref.oldNumber] = rows[0].id;
      }
      const factIdByOldId = new Map();
      for (const fact of plan.facts) {
        const rows = await tx`
          INSERT INTO facts (workspace_id, project_key, text, score, status)
          VALUES (${workspaceId}, ${plan.projectKey}, ${fact.text}, ${fact.score}, ${fact.status})
          RETURNING id`;
        factIdByOldId.set(fact.oldId, rows[0].id);
        report.facts[fact.oldId] = rows[0].id;
      }
      let insertedLinks = 0;
      for (const fact of plan.facts) {
        for (const oldNumber of fact.linkOldNumbers) {
          await tx`
            INSERT INTO fact_references (fact_id, reference_id, workspace_id)
            VALUES (${factIdByOldId.get(fact.oldId)}, ${refIdByOldNumber.get(oldNumber)}, ${workspaceId})`;
          insertedLinks += 1;
        }
      }
      const refByOldNumber = new Map(plan.references.map((r) => [r.oldNumber, r]));
      const marksById = new Map();
      const marksRaw = await readMarks(args.marks);
      for (const mark of marksRaw) marksById.set(mark.id, mark);
      let insertedBib = 0;
      for (const match of plan.markMatches) {
        if (match.oldNumber === null) continue;
        const ref = refByOldNumber.get(match.oldNumber);
        const mark = marksById.get(match.markId);
        const url = ref.url ?? (mark && mark.type === 'link' ? mark.url : null);
        await tx`
          INSERT INTO mark_bibliography
            (mark_id, workspace_id, title, authors, journal, year, doi, pmid, pmcid, url, oa_flag)
          VALUES
            (${match.markId}, ${workspaceId}, ${ref.title ?? null}, ${ref.authors ?? null},
             ${ref.journal ?? null}, ${ref.year ?? null}, ${ref.doi ?? null}, ${ref.pmid ?? null},
             ${ref.pmcid ?? null}, ${url ?? null}, ${ref.oaFlag ?? null})`;
        insertedBib += 1;
      }
      console.log(
        `apply: inserted references ${plan.references.length}, facts ${plan.facts.length}, links ${insertedLinks}, bibliography ${insertedBib}`,
      );
    });
    if (typeof args.applyReportOut === 'string') {
      await writeFile(args.applyReportOut, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
      console.log(`apply report written: ${args.applyReportOut}`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
