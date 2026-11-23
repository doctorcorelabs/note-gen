// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Writer stage (F2-2, wave G-F2-2e): writes the selected
// candidates of one Deep Search job into F2-1 data.
//
// Per candidate (creation order): a structured record through
// the same service calls the G-F2-1b route orchestrates
// (deterministic sourceId, DOI/PMID dedupe, metadata conflict
// rejected with its reason, never a silent merge). Per fact
// candidate: a facts row; mapped facts with at least one
// supporting written candidate also create references and
// fact_references links, which assigns stable numbers in order
// of appearance (fact order, then candidate order inside the
// fact). Unmapped facts, and mapped facts without a supporting
// written candidate, are written unmapped and never receive a
// marker.
//
// Idempotency (decision 8): a candidate that already carries a
// recordMarkId and a fact candidate that already carries a
// factId are not written again; a fact whose text already
// exists in the project links to the existing row without
// modifying it or its mappings, so human decisions are never
// overwritten. Each record/fact write is its own repository
// transaction: a failure mid-stage leaves earlier writes valid
// and a retry resumes from the write-back links.
//
// The fact -> candidate support links come from the assessor
// evidence rows (candidateId + factCandidateId); fact candidate
// rows themselves carry no candidate id. Every outcome is also
// recorded as an evidence row (note writer ...), so the job
// trail shows exactly what was written, deduplicated, or
// rejected and why.

import { ApiError } from '../../plugins/envelope.js';
import type { CitationsRepository } from '../citations/repository.js';
import type { FactRow, ReferenceRow } from '../citations/represent.js';
import { deriveSourceId } from '../citations/source-id.js';
import {
  parseUpsertBibliographyBody,
  type BibliographicInput,
} from '../citations/validation.js';
import type { RecordsRepository } from '../records/repository.js';
import {
  conflictingBibliographyFields,
  deriveRecordUrl,
} from '../records/structured.js';
import { validateUrlShape } from '../records/validation.js';
import type {
  SearchCandidateRow,
  SearchFactCandidateRow,
  SearchJobRow,
} from './represent.js';
import type {
  CandidateWrittenUpdate,
  DeepSearchRepository,
  NewEvidence,
} from './repository.js';

export interface WriterDeps {
  deepSearch: DeepSearchRepository;
  records: RecordsRepository;
  citations: CitationsRepository;
}

export interface WriterSummary {
  candidatesAccepted: number;
  candidatesDuplicate: number;
  candidatesRejected: number;
  factsWritten: number;
  factsMapped: number;
  factsUnmapped: number;
  referencesCreated: number;
}

interface WrittenCandidate {
  row: SearchCandidateRow;
  recordMarkId: number;
  bibliography: BibliographicInput;
}

function isValidationError(error: unknown): boolean {
  return error instanceof ApiError && error.statusCode === 400;
}

function candidateBibliographyBody(
  candidate: SearchCandidateRow,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (candidate.title !== null) body['title'] = candidate.title;
  if (candidate.authors !== null) body['authors'] = candidate.authors;
  if (candidate.journal !== null) body['journal'] = candidate.journal;
  if (candidate.year !== null) body['year'] = candidate.year;
  if (candidate.doi !== null) body['doi'] = candidate.doi;
  if (candidate.pmid !== null) body['pmid'] = candidate.pmid;
  if (candidate.pmcid !== null) body['pmcid'] = candidate.pmcid;
  if (candidate.url !== null) body['url'] = candidate.url;
  if (candidate.oaFlag !== null) body['oaFlag'] = candidate.oaFlag;
  return body;
}

function candidateEvidence(
  job: SearchJobRow,
  candidate: SearchCandidateRow,
  update: CandidateWrittenUpdate,
): NewEvidence {
  return {
    candidateId: candidate.id,
    factCandidateId: null,
    queryText: job.topic,
    sourceKind: candidate.sourceKind,
    httpStatus: null,
    note:
      `writer disposition=${update.disposition}` +
      (update.recordMarkId !== null ? ` recordMarkId=${update.recordMarkId}` : '') +
      (update.rejectReason !== null ? ` reason=${update.rejectReason}` : ''),
  };
}

// Write one candidate as a structured record, mirroring the
// G-F2-1b route orchestration at service level. Validation and
// identifier problems reject the candidate with a recorded
// reason; repository failures propagate and fail the stage.
async function writeCandidate(
  deps: WriterDeps,
  job: SearchJobRow,
  candidate: SearchCandidateRow,
): Promise<{ update: CandidateWrittenUpdate; bibliography: BibliographicInput | null }> {
  let bibliography: BibliographicInput;
  try {
    bibliography = parseUpsertBibliographyBody(candidateBibliographyBody(candidate));
  } catch (error) {
    if (isValidationError(error)) {
      return {
        update: {
          disposition: 'rejected',
          recordMarkId: null,
          rejectReason: 'invalid_bibliographic_data',
        },
        bibliography: null,
      };
    }
    throw error;
  }
  if (
    bibliography.doi === undefined &&
    bibliography.pmid === undefined &&
    bibliography.pmcid === undefined &&
    bibliography.url === undefined
  ) {
    return {
      update: {
        disposition: 'rejected',
        recordMarkId: null,
        rejectReason: 'no_identifier',
      },
      bibliography,
    };
  }

  const workspaceId = job.workspaceId;
  const existingBib = await deps.citations.findMarkBibliographyByIdentifier(workspaceId, {
    doi: bibliography.doi,
    pmid: bibliography.pmid,
  });
  if (existingBib !== null) {
    const conflicts = conflictingBibliographyFields(existingBib, bibliography);
    if (conflicts.length > 0) {
      return {
        update: {
          disposition: 'rejected',
          recordMarkId: null,
          rejectReason: `metadata_conflict:${conflicts.join(',')}`,
        },
        bibliography,
      };
    }
    return {
      update: {
        disposition: 'duplicate',
        recordMarkId: existingBib.markId,
        rejectReason: null,
      },
      bibliography,
    };
  }

  let url: string;
  let sourceId: string;
  try {
    url = deriveRecordUrl(bibliography);
    validateUrlShape('link', url);
    sourceId = deriveSourceId({
      doi: bibliography.doi,
      pmid: bibliography.pmid,
      pmcid: bibliography.pmcid,
      url: bibliography.url,
    });
  } catch (error) {
    if (isValidationError(error)) {
      return {
        update: {
          disposition: 'rejected',
          recordMarkId: null,
          rejectReason: 'invalid_bibliographic_data',
        },
        bibliography,
      };
    }
    throw error;
  }

  const created = await deps.records.createMark(
    workspaceId,
    {
      type: 'link',
      content: candidate.snippet ?? '',
      desc: candidate.title ?? '',
      url,
      tagId: undefined,
      tagIds: undefined,
      sourceId,
    },
    async () => false,
  );
  const currentBib = await deps.citations.getMarkBibliography(workspaceId, created.row.id);
  if (currentBib !== null) {
    const conflicts = conflictingBibliographyFields(currentBib, bibliography);
    if (conflicts.length > 0) {
      return {
        update: {
          disposition: 'rejected',
          recordMarkId: null,
          rejectReason: `metadata_conflict:${conflicts.join(',')}`,
        },
        bibliography,
      };
    }
    return {
      update: {
        disposition: 'duplicate',
        recordMarkId: created.row.id,
        rejectReason: null,
      },
      bibliography,
    };
  }
  await deps.citations.upsertMarkBibliography(workspaceId, created.row.id, bibliography);
  return {
    update: {
      disposition: created.duplicate ? 'duplicate' : 'accepted',
      recordMarkId: created.row.id,
      rejectReason: null,
    },
    bibliography,
  };
}

// Bibliography for a candidate written by an earlier run: the
// stored companion row wins; the candidate fields are the
// fallback (a record without a companion row is the documented
// interim shape of the structured route).
async function writtenBibliography(
  deps: WriterDeps,
  job: SearchJobRow,
  candidate: SearchCandidateRow,
  recordMarkId: number,
): Promise<BibliographicInput | null> {
  const stored = await deps.citations.getMarkBibliography(job.workspaceId, recordMarkId);
  if (stored !== null) {
    return {
      title: stored.title ?? undefined,
      authors: stored.authors ?? undefined,
      journal: stored.journal ?? undefined,
      year: stored.year ?? undefined,
      doi: stored.doi ?? undefined,
      pmid: stored.pmid ?? undefined,
      pmcid: stored.pmcid ?? undefined,
      url: stored.url ?? undefined,
      oaFlag: stored.oaFlag ?? undefined,
    };
  }
  try {
    return parseUpsertBibliographyBody(candidateBibliographyBody(candidate));
  } catch (error) {
    if (isValidationError(error)) {
      return null;
    }
    throw error;
  }
}

export async function writeJobResults(
  deps: WriterDeps,
  job: SearchJobRow,
): Promise<WriterSummary> {
  const workspaceId = job.workspaceId;
  const summary: WriterSummary = {
    candidatesAccepted: 0,
    candidatesDuplicate: 0,
    candidatesRejected: 0,
    factsWritten: 0,
    factsMapped: 0,
    factsUnmapped: 0,
    referencesCreated: 0,
  };

  const candidates = await deps.deepSearch.listCandidates(workspaceId, job.id);
  const factCandidates = await deps.deepSearch.listFactCandidates(workspaceId, job.id);
  const evidence = await deps.deepSearch.listJobEvidence(job.id);

  // Fact -> supporting candidates from the assessor evidence,
  // in evidence order, deduplicated.
  const supportByFact = new Map<string, string[]>();
  for (const row of evidence) {
    if (row.factCandidateId === null || row.candidateId === null) continue;
    const list = supportByFact.get(row.factCandidateId) ?? [];
    if (!list.includes(row.candidateId)) {
      list.push(row.candidateId);
    }
    supportByFact.set(row.factCandidateId, list);
  }

  // Candidate phase.
  const written = new Map<string, WrittenCandidate>();
  for (const candidate of candidates) {
    if (candidate.recordMarkId !== null) {
      const bibliography = await writtenBibliography(
        deps,
        job,
        candidate,
        candidate.recordMarkId,
      );
      if (bibliography !== null) {
        written.set(candidate.id, {
          row: candidate,
          recordMarkId: candidate.recordMarkId,
          bibliography,
        });
      }
      continue;
    }
    if (candidate.disposition === 'rejected') {
      continue;
    }
    const { update, bibliography } = await writeCandidate(deps, job, candidate);
    await deps.deepSearch.setCandidateWritten(job.id, candidate.id, update);
    await deps.deepSearch.insertEvidence(job.id, [
      candidateEvidence(job, candidate, update),
    ]);
    if (update.disposition === 'accepted') summary.candidatesAccepted += 1;
    if (update.disposition === 'duplicate') summary.candidatesDuplicate += 1;
    if (update.disposition === 'rejected') summary.candidatesRejected += 1;
    if (update.recordMarkId !== null && bibliography !== null) {
      written.set(candidate.id, {
        row: candidate,
        recordMarkId: update.recordMarkId,
        bibliography,
      });
    }
  }

  // Fact phase.
  const existingFacts = await deps.citations.listFacts(workspaceId, job.projectKey);
  const factByText = new Map<string, FactRow>();
  for (const fact of existingFacts) {
    if (!factByText.has(fact.text)) {
      factByText.set(fact.text, fact);
    }
  }

  for (const factCandidate of factCandidates) {
    const supportingIds = (supportByFact.get(factCandidate.id) ?? []).filter((id) =>
      written.has(id),
    );

    let fact: FactRow | null = null;
    let createdByWriter = false;
    if (factCandidate.factId !== null) {
      try {
        fact = await deps.citations.getFact(workspaceId, factCandidate.factId);
      } catch (error) {
        if (!(error instanceof ApiError && error.statusCode === 404)) {
          throw error;
        }
        fact = null;
      }
    }
    if (fact === null) {
      fact = factByText.get(factCandidate.text) ?? null;
    }

    // References first (still unnumbered): a mapped fact is only
    // created when at least one reference in this project can
    // actually be linked. A reference deduplicated into another
    // project cannot be mapped here and is skipped.
    const mappableReferences: ReferenceRow[] = [];
    const wantMapped = factCandidate.status === 'mapped' && supportingIds.length > 0;
    if (fact === null && wantMapped) {
      for (const candidateId of supportingIds) {
        const support = written.get(candidateId) as WrittenCandidate;
        const created = await deps.citations.createReference(workspaceId, {
          ...support.bibliography,
          projectKey: job.projectKey,
          sourceRecordId: support.recordMarkId,
        });
        if (!created.duplicate) {
          summary.referencesCreated += 1;
        }
        if (created.row.projectKey === job.projectKey) {
          mappableReferences.push(created.row);
        }
      }
    }

    if (fact === null) {
      fact = await deps.citations.createFact(workspaceId, {
        projectKey: job.projectKey,
        text: factCandidate.text,
        score: factCandidate.score ?? 0,
        status: mappableReferences.length > 0 ? 'mapped' : 'unmapped',
      });
      createdByWriter = true;
      factByText.set(fact.text, fact);
    }

    if (factCandidate.factId !== fact.id) {
      await deps.deepSearch.setFactWritten(job.id, factCandidate.id, fact.id);
      summary.factsWritten += 1;
    }

    if (createdByWriter && fact.status === 'mapped') {
      for (const reference of mappableReferences) {
        await deps.citations.mapFactToReference(workspaceId, fact.id, reference.id);
      }
    }

    if (fact.status === 'mapped') {
      summary.factsMapped += 1;
    } else {
      summary.factsUnmapped += 1;
    }

    const firstSupport =
      supportingIds.length > 0
        ? (written.get(supportingIds[0] as string) as WrittenCandidate)
        : null;
    if (firstSupport !== null) {
      await deps.deepSearch.insertEvidence(job.id, [
        {
          candidateId: firstSupport.row.id,
          factCandidateId: factCandidate.id,
          queryText: job.topic,
          sourceKind: firstSupport.row.sourceKind,
          httpStatus: null,
          note: `writer factId=${fact.id} status=${fact.status}`,
        },
      ]);
    }
  }

  return summary;
}
