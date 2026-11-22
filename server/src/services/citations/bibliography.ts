// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Bibliography formatting + citation-map construction (F2-1 design
// 2.1). Pure functions over row shapes; both repository
// implementations build the citation map through buildCitationMap so
// fake and Drizzle semantics cannot drift.
//
// Format decision (design decision 1, approved recommendation):
// Vancouver-style numbered list in order of appearance. The numbers
// come from references.number (stable, server-assigned); this module
// never renumbers. Unnumbered references (never mapped to a fact) are
// excluded from the bibliography text.

import type { CitationMapEntry, FactRow, ReferenceRow } from './represent.js';
import { sortReferences } from './represent.js';

export interface FactReferenceLink {
  factId: string;
  referenceId: string;
}

// Build the citation map: one entry per mapped fact that has at
// least one numbered reference, numbers sorted ascending. Unmapped
// facts are excluded entirely (they receive no marker by rule), and
// links to unnumbered references contribute nothing.
export function buildCitationMap(
  facts: FactRow[],
  links: FactReferenceLink[],
  references: ReferenceRow[],
): CitationMapEntry[] {
  const numberByReferenceId = new Map<string, number>();
  for (const reference of references) {
    if (reference.number !== null) {
      numberByReferenceId.set(reference.id, reference.number);
    }
  }
  const numbersByFactId = new Map<string, number[]>();
  for (const link of links) {
    const number = numberByReferenceId.get(link.referenceId);
    if (number === undefined) continue;
    const list = numbersByFactId.get(link.factId) ?? [];
    list.push(number);
    numbersByFactId.set(link.factId, list);
  }
  const entries: CitationMapEntry[] = [];
  for (const fact of facts) {
    if (fact.status !== 'mapped') continue;
    const numbers = numbersByFactId.get(fact.id);
    if (numbers === undefined || numbers.length === 0) continue;
    entries.push({ factId: fact.id, numbers: [...numbers].sort((a, b) => a - b) });
  }
  return entries;
}

function withPeriod(value: string): string {
  return value.endsWith('.') ? value : `${value}.`;
}

// One bibliography line: "3. Authors. Title. Journal. Year. doi:..."
// Missing parts are skipped; identifiers are appended when present.
export function formatBibliographyEntry(reference: ReferenceRow): string {
  if (reference.number === null) {
    throw new Error('formatBibliographyEntry requires a numbered reference.');
  }
  const parts: string[] = [];
  if (reference.authors !== null && reference.authors !== '') parts.push(withPeriod(reference.authors));
  if (reference.title !== null && reference.title !== '') parts.push(withPeriod(reference.title));
  if (reference.journal !== null && reference.journal !== '') parts.push(withPeriod(reference.journal));
  if (reference.year !== null) parts.push(`${reference.year}.`);
  if (reference.doi !== null && reference.doi !== '') parts.push(`doi:${reference.doi}`);
  if (reference.pmid !== null && reference.pmid !== '') parts.push(`PMID: ${reference.pmid}`);
  if (reference.pmcid !== null && reference.pmcid !== '') parts.push(`PMCID: ${reference.pmcid}`);
  if (parts.length === 0 && reference.url !== null && reference.url !== '') {
    parts.push(reference.url);
  }
  return `${reference.number}. ${parts.join(' ')}`.trimEnd();
}

// Full Daftar Pustaka text for a project: numbered references only,
// in number order, one entry per line.
export function formatBibliography(references: ReferenceRow[]): string {
  return sortReferences(references)
    .filter((reference) => reference.number !== null)
    .map((reference) => formatBibliographyEntry(reference))
    .join('\n');
}
