// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { highlightSnippetSegments, type SearchSnippetMatch } from '@/lib/web/search-client'

/**
 * Search result snippet with server-provided match highlighting
 * (Fase 1, V3-28). The offsets come from the keyword search
 * response (`snippetMatches`, offsets inside the snippet, V1-14
 * 8.2); this component only renders them and never recomputes
 * matches from the query, so it cannot disagree with the server
 * about what matched. Shared by the sidebar search and the search
 * dialog so both surfaces highlight snippets identically.
 */
export function SearchSnippet({ snippet, matches }: { snippet: string; matches: readonly SearchSnippetMatch[] }) {
  const segments = highlightSnippetSegments(snippet, matches)
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="rounded bg-primary/15 px-0.5 text-foreground">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  )
}
