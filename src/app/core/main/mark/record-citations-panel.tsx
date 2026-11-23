'use client'

// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Minimal citations panel for the record detail view (F2-1 wave
// G-F2-1e). Read-only display over the G-F2-1b cookie-auth
// citations routes, through citations-client.ts:
//
// - the bibliographic companion row of the open record, when it
//   has one (structured records from G-F2-1b);
// - the numbered reference list of one project (project key typed
//   by the user; there is no project discovery endpoint in F2-1);
// - the facts of that project with their mapped/unmapped status
//   and, for mapped facts only, their citation markers from the
//   citation map. Unmapped facts render "No marker" by rule.
//
// The panel writes nothing: no create, map, or patch call exists
// in the client, and this component only issues the GET reads.
// Every visible state is a function of a request outcome (loading,
// loaded, empty, error); nothing waits on a fixed sleep.

import React, { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { defaultApiClient } from "@/lib/web/api-client"
import {
  factMarkerNumbers,
  getProjectCitationMap,
  getProjectFacts,
  getProjectReferences,
  getRecordBibliography,
  normalizeProjectKey,
  sortCitationReferences,
  type CitationFact,
  type CitationMapEntry,
  type CitationReference,
  type MarkBibliography,
} from "@/lib/web/citations-client"
import { useUserErrorMessage } from "@/lib/use-user-error-message"

type LoadStatus = "idle" | "loading" | "loaded" | "error"

interface BibliographyState {
  status: LoadStatus
  bibliography: MarkBibliography | null
  error: string | null
}

interface ProjectState {
  status: LoadStatus
  references: CitationReference[]
  facts: CitationFact[]
  entries: CitationMapEntry[]
  error: string | null
}

function BibliographyLines({ bibliography }: { bibliography: MarkBibliography }) {
  const t = useTranslations()
  const lines: Array<{ label: string; value: string }> = []
  if (bibliography.title) {
    lines.push({ label: t('record.mark.citations.titleLabel'), value: bibliography.title })
  }
  if (bibliography.authors) {
    lines.push({ label: t('record.mark.citations.authors'), value: bibliography.authors })
  }
  if (bibliography.journal) {
    lines.push({ label: t('record.mark.citations.journal'), value: bibliography.journal })
  }
  if (bibliography.year !== null) {
    lines.push({ label: t('record.mark.citations.year'), value: String(bibliography.year) })
  }
  if (bibliography.doi) {
    lines.push({ label: t('record.mark.citations.doi'), value: bibliography.doi })
  }
  if (bibliography.pmid) {
    lines.push({ label: t('record.mark.citations.pmid'), value: bibliography.pmid })
  }
  if (bibliography.pmcid) {
    lines.push({ label: t('record.mark.citations.pmcid'), value: bibliography.pmcid })
  }
  if (lines.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t('record.mark.citations.noBibliography')}
      </p>
    )
  }
  return (
    <dl className="flex min-w-0 flex-col gap-1">
      {lines.map((line) => (
        <div key={line.label} className="flex min-w-0 items-baseline gap-2">
          <dt className="shrink-0 text-xs text-muted-foreground/70">{line.label}</dt>
          <dd className="min-w-0 break-all text-xs">{line.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function ReferenceItem({
  reference,
  isThisRecord,
}: {
  reference: CitationReference
  isThisRecord: boolean
}) {
  const t = useTranslations()
  const meta = [reference.authors, reference.journal, reference.year !== null ? String(reference.year) : null]
    .filter((part): part is string => part !== null && part !== "")
    .join(" - ")
  const identifiers = [
    reference.doi ? `${t('record.mark.citations.doi')}: ${reference.doi}` : null,
    reference.pmid ? `${t('record.mark.citations.pmid')}: ${reference.pmid}` : null,
    reference.pmcid ? `${t('record.mark.citations.pmcid')}: ${reference.pmcid}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" - ")
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Badge variant={reference.number !== null ? "secondary" : "outline"} className="shrink-0">
        {reference.number !== null
          ? `[${reference.number}]`
          : t('record.mark.citations.unnumbered')}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-xs">
          {reference.title ?? t('record.mark.citations.untitled')}
          {isThisRecord ? (
            <Badge variant="info" className="ml-2">
              {t('record.mark.citations.thisRecord')}
            </Badge>
          ) : null}
        </p>
        {meta ? <p className="min-w-0 break-words text-xs text-muted-foreground">{meta}</p> : null}
        {identifiers ? (
          <p className="min-w-0 break-all text-xs text-muted-foreground">{identifiers}</p>
        ) : null}
      </div>
    </li>
  )
}

function FactItem({
  fact,
  entries,
}: {
  fact: CitationFact
  entries: CitationMapEntry[]
}) {
  const t = useTranslations()
  const markers = factMarkerNumbers(entries, fact.id)
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Badge
        variant={fact.status === "mapped" ? "success" : "warning"}
        className="shrink-0"
      >
        {fact.status === "mapped"
          ? t('record.mark.citations.mapped')
          : t('record.mark.citations.unmapped')}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-xs">{fact.text}</p>
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {t('record.mark.citations.score', { score: fact.score })}
          {" - "}
          {markers.length > 0
            ? markers.map((number) => `[${number}]`).join(" ")
            : t('record.mark.citations.noMarker')}
        </p>
      </div>
    </li>
  )
}

export function RecordCitationsPanel({ markId }: { markId: number }) {
  const t = useTranslations()
  const userErrorMessage = useUserErrorMessage()
  const [bibliographyState, setBibliographyState] = useState<BibliographyState>({
    status: "loading",
    bibliography: null,
    error: null,
  })
  const [projectKeyInput, setProjectKeyInput] = useState("")
  const [projectKeyError, setProjectKeyError] = useState<string | null>(null)
  const [projectState, setProjectState] = useState<ProjectState>({
    status: "idle",
    references: [],
    facts: [],
    entries: [],
    error: null,
  })
  const bibliographyRunRef = useRef(0)
  const projectRunRef = useRef(0)

  useEffect(() => {
    const runId = bibliographyRunRef.current + 1
    bibliographyRunRef.current = runId
    setBibliographyState({ status: "loading", bibliography: null, error: null })
    const controller = new AbortController()
    void (async () => {
      try {
        const bibliography = await getRecordBibliography(defaultApiClient, markId, {
          signal: controller.signal,
        })
        if (bibliographyRunRef.current !== runId) {
          return
        }
        setBibliographyState({ status: "loaded", bibliography, error: null })
      } catch (error) {
        if (bibliographyRunRef.current !== runId) {
          return
        }
        const message = userErrorMessage(error)
        if (message === null) {
          return
        }
        setBibliographyState({ status: "error", bibliography: null, error: message })
      }
    })()
    return () => {
      controller.abort()
    }
  }, [markId, userErrorMessage])

  const loadProject = useCallback(async () => {
    const projectKey = normalizeProjectKey(projectKeyInput)
    if (projectKey === null) {
      setProjectKeyError(t('record.mark.citations.invalidProjectKey'))
      return
    }
    setProjectKeyError(null)
    const runId = projectRunRef.current + 1
    projectRunRef.current = runId
    setProjectState({
      status: "loading",
      references: [],
      facts: [],
      entries: [],
      error: null,
    })
    try {
      const [references, facts, entries] = await Promise.all([
        getProjectReferences(defaultApiClient, projectKey),
        getProjectFacts(defaultApiClient, projectKey),
        getProjectCitationMap(defaultApiClient, projectKey),
      ])
      if (projectRunRef.current !== runId) {
        return
      }
      setProjectState({
        status: "loaded",
        references: sortCitationReferences(references),
        facts,
        entries,
        error: null,
      })
    } catch (error) {
      if (projectRunRef.current !== runId) {
        return
      }
      const message = userErrorMessage(error)
      if (message === null) {
        return
      }
      setProjectState({
        status: "error",
        references: [],
        facts: [],
        entries: [],
        error: message,
      })
    }
  }, [projectKeyInput, t, userErrorMessage])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('record.mark.citations.bibliography')}
        </h3>
        {bibliographyState.status === "loading" ? (
          <p className="text-xs text-muted-foreground">{t('record.mark.citations.loading')}</p>
        ) : bibliographyState.status === "error" ? (
          <p className="text-xs text-destructive">
            {bibliographyState.error ?? t('record.mark.citations.loadFailed')}
          </p>
        ) : bibliographyState.bibliography === null ? (
          <p className="text-xs text-muted-foreground">
            {t('record.mark.citations.noBibliography')}
          </p>
        ) : (
          <BibliographyLines bibliography={bibliographyState.bibliography} />
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor="record-citations-project-key" className="shrink-0 text-xs text-muted-foreground/70">
            {t('record.mark.citations.projectKeyLabel')}
          </label>
          <Input
            id="record-citations-project-key"
            value={projectKeyInput}
            maxLength={128}
            placeholder={t('record.mark.citations.projectKeyPlaceholder')}
            onChange={(event) => setProjectKeyInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void loadProject()
              }
            }}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void loadProject()}
            disabled={projectState.status === "loading"}
          >
            {t('record.mark.citations.load')}
          </Button>
        </div>
        {projectKeyError ? (
          <p className="text-xs text-destructive">{projectKeyError}</p>
        ) : null}
        {projectState.status === "loading" ? (
          <p className="text-xs text-muted-foreground">{t('record.mark.citations.loading')}</p>
        ) : projectState.status === "error" ? (
          <p className="text-xs text-destructive">
            {projectState.error ?? t('record.mark.citations.loadFailed')}
          </p>
        ) : projectState.status === "loaded" ? (
          <div className="flex min-w-0 flex-col gap-4">
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('record.mark.citations.references')}
              </h3>
              {projectState.references.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('record.mark.citations.noReferences')}
                </p>
              ) : (
                <ul className={cn("flex min-w-0 flex-col gap-2")}>
                  {projectState.references.map((reference) => (
                    <ReferenceItem
                      key={reference.id}
                      reference={reference}
                      isThisRecord={reference.sourceRecordId === markId}
                    />
                  ))}
                </ul>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t('record.mark.citations.facts')}
              </h3>
              {projectState.facts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('record.mark.citations.noFacts')}
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                  {projectState.facts.map((fact) => (
                    <FactItem key={fact.id} fact={fact} entries={projectState.entries} />
                  ))}
                </ul>
              )}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
