'use client'

// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Minimal Deep Search panel for the record detail view (F2-2 wave
// G-F2-2f). Over the cookie-auth Deep Search job routes through
// deep-search-client.ts:
//
// - create a job (project key typed by the user, topic, year
//   range, language, Exa budget ceiling, candidate cap);
// - list the jobs of one project with their status and recorded
//   Exa cost;
// - open one job: stage rows, collected candidates with their
//   disposition, scored fact candidates with mapped/unmapped
//   status;
// - approve-writing (the explicit human approval of decision 8),
//   cancel, and retry as explicit buttons. Nothing here approves
//   implicitly, and there is no delete control (decision 9).
//
// Every visible state is a function of a request outcome (loading,
// loaded, empty, error); nothing waits on a fixed sleep. The
// panel never shows a credential: the Exa key and the E-utilities
// identity live in server config only (design 3.4).

import React, { useCallback, useRef, useState } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { defaultApiClient } from "@/lib/web/api-client"
import {
  approveDeepSearchWriting,
  buildCreateJobBody,
  cancelDeepSearchJob,
  createDeepSearchJob,
  getDeepSearchJob,
  isDeepSearchJobActive,
  listDeepSearchCandidates,
  listDeepSearchFactCandidates,
  listDeepSearchJobs,
  normalizeDeepSearchProjectKey,
  retryDeepSearchJob,
  type DeepSearchCandidate,
  type DeepSearchFactCandidate,
  type DeepSearchJob,
  type DeepSearchJobDetail,
} from "@/lib/web/deep-search-client"
import { useUserErrorMessage } from "@/lib/use-user-error-message"

type LoadStatus = "idle" | "loading" | "loaded" | "error"

interface JobsState {
  status: LoadStatus
  jobs: DeepSearchJob[]
  error: string | null
}

interface DetailState {
  status: LoadStatus
  detail: DeepSearchJobDetail | null
  candidates: DeepSearchCandidate[]
  facts: DeepSearchFactCandidate[]
  error: string | null
}

function optionalNumber(value: string): number | undefined {
  const trimmed = value.trim()
  if (trimmed === "") {
    return undefined
  }
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : Number.NaN
}

function CandidateItem({ candidate }: { candidate: DeepSearchCandidate }) {
  const t = useTranslations()
  const meta = [
    candidate.authors,
    candidate.journal,
    candidate.year !== null ? String(candidate.year) : null,
  ]
    .filter((part): part is string => part !== null && part !== "")
    .join(" - ")
  const identifiers = [
    candidate.doi ? `${t('record.mark.citations.doi')}: ${candidate.doi}` : null,
    candidate.pmid ? `${t('record.mark.citations.pmid')}: ${candidate.pmid}` : null,
    candidate.pmcid ? `${t('record.mark.citations.pmcid')}: ${candidate.pmcid}` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" - ")
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Badge
        variant={candidate.disposition === "accepted" ? "success" : "outline"}
        className="shrink-0"
      >
        {t(`record.mark.deepSearch.disposition.${candidate.disposition}`)}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-xs">
          {candidate.title ?? t('record.mark.deepSearch.untitledCandidate')}
        </p>
        {meta ? <p className="min-w-0 break-words text-xs text-muted-foreground">{meta}</p> : null}
        {identifiers ? (
          <p className="min-w-0 break-all text-xs text-muted-foreground">{identifiers}</p>
        ) : null}
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {t(`record.mark.deepSearch.sourceKind.${candidate.sourceKind}`)}
          {candidate.rejectReason ? ` - ${candidate.rejectReason}` : ""}
        </p>
      </div>
    </li>
  )
}

function FactCandidateItem({ fact }: { fact: DeepSearchFactCandidate }) {
  const t = useTranslations()
  return (
    <li className="flex min-w-0 items-start gap-2">
      <Badge
        variant={fact.status === "mapped" ? "success" : fact.status === "unmapped" ? "warning" : "outline"}
        className="shrink-0"
      >
        {t(`record.mark.deepSearch.factStatus.${fact.status}`)}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="min-w-0 break-words text-xs">{fact.text}</p>
        <p className="min-w-0 break-words text-xs text-muted-foreground">
          {fact.score !== null
            ? t('record.mark.deepSearch.score', { score: fact.score })
            : t('record.mark.deepSearch.notScored')}
          {fact.status === "unmapped" ? ` - ${t('record.mark.deepSearch.noMarker')}` : ""}
        </p>
      </div>
    </li>
  )
}

export function DeepSearchPanel() {
  const t = useTranslations()
  const userErrorMessage = useUserErrorMessage()
  const [projectKeyInput, setProjectKeyInput] = useState("")
  const [topicInput, setTopicInput] = useState("")
  const [yearFromInput, setYearFromInput] = useState("")
  const [yearToInput, setYearToInput] = useState("")
  const [languageInput, setLanguageInput] = useState("")
  const [budgetInput, setBudgetInput] = useState("")
  const [maxCandidatesInput, setMaxCandidatesInput] = useState("")
  const [formError, setFormError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [jobsState, setJobsState] = useState<JobsState>({
    status: "idle",
    jobs: [],
    error: null,
  })
  const [detailState, setDetailState] = useState<DetailState>({
    status: "idle",
    detail: null,
    candidates: [],
    facts: [],
    error: null,
  })
  const jobsRunRef = useRef(0)
  const detailRunRef = useRef(0)

  const loadJobs = useCallback(async () => {
    const projectKey = normalizeDeepSearchProjectKey(projectKeyInput)
    if (projectKey === null) {
      setFormError(t('record.mark.deepSearch.invalidProjectKey'))
      return
    }
    setFormError(null)
    const runId = jobsRunRef.current + 1
    jobsRunRef.current = runId
    setJobsState({ status: "loading", jobs: [], error: null })
    try {
      const jobs = await listDeepSearchJobs(defaultApiClient, { projectKey })
      if (jobsRunRef.current !== runId) {
        return
      }
      setJobsState({ status: "loaded", jobs, error: null })
    } catch (error) {
      if (jobsRunRef.current !== runId) {
        return
      }
      const message = userErrorMessage(error)
      if (message === null) {
        return
      }
      setJobsState({ status: "error", jobs: [], error: message })
    }
  }, [projectKeyInput, t, userErrorMessage])

  const loadDetail = useCallback(
    async (jobId: string) => {
      const runId = detailRunRef.current + 1
      detailRunRef.current = runId
      setDetailState({ status: "loading", detail: null, candidates: [], facts: [], error: null })
      try {
        const [detail, candidates, facts] = await Promise.all([
          getDeepSearchJob(defaultApiClient, jobId),
          listDeepSearchCandidates(defaultApiClient, jobId),
          listDeepSearchFactCandidates(defaultApiClient, jobId),
        ])
        if (detailRunRef.current !== runId) {
          return
        }
        setDetailState({ status: "loaded", detail, candidates, facts, error: null })
      } catch (error) {
        if (detailRunRef.current !== runId) {
          return
        }
        const message = userErrorMessage(error)
        if (message === null) {
          return
        }
        setDetailState({ status: "error", detail: null, candidates: [], facts: [], error: message })
      }
    },
    [userErrorMessage],
  )

  const createJob = useCallback(async () => {
    const body = buildCreateJobBody({
      projectKey: projectKeyInput,
      topic: topicInput,
      maxCandidates: optionalNumber(maxCandidatesInput),
      budgetExaUsd: optionalNumber(budgetInput),
      yearFrom: optionalNumber(yearFromInput),
      yearTo: optionalNumber(yearToInput),
      language: languageInput.trim() === "" ? undefined : languageInput,
    })
    if (body === null) {
      setFormError(t('record.mark.deepSearch.invalidInput'))
      return
    }
    setFormError(null)
    setBusy(true)
    try {
      const job = await createDeepSearchJob(defaultApiClient, {
        projectKey: projectKeyInput,
        topic: topicInput,
        maxCandidates: optionalNumber(maxCandidatesInput),
        budgetExaUsd: optionalNumber(budgetInput),
        yearFrom: optionalNumber(yearFromInput),
        yearTo: optionalNumber(yearToInput),
        language: languageInput.trim() === "" ? undefined : languageInput,
      })
      await loadJobs()
      await loadDetail(job.id)
    } catch (error) {
      const message = userErrorMessage(error)
      if (message !== null) {
        setFormError(message)
      }
    } finally {
      setBusy(false)
    }
  }, [
    budgetInput,
    languageInput,
    loadDetail,
    loadJobs,
    maxCandidatesInput,
    projectKeyInput,
    t,
    topicInput,
    userErrorMessage,
    yearFromInput,
    yearToInput,
  ])

  const runAction = useCallback(
    async (action: (jobId: string) => Promise<DeepSearchJob>, jobId: string) => {
      setBusy(true)
      try {
        await action(jobId)
        await loadJobs()
        await loadDetail(jobId)
      } catch (error) {
        const message = userErrorMessage(error)
        if (message !== null) {
          setFormError(message)
        }
      } finally {
        setBusy(false)
      }
    },
    [loadDetail, loadJobs, userErrorMessage],
  )

  const selected = detailState.detail?.job ?? null

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor="deep-search-project-key" className="shrink-0 text-xs text-muted-foreground/70">
            {t('record.mark.deepSearch.projectKeyLabel')}
          </label>
          <Input
            id="deep-search-project-key"
            value={projectKeyInput}
            maxLength={128}
            placeholder={t('record.mark.deepSearch.projectKeyPlaceholder')}
            onChange={(event) => setProjectKeyInput(event.target.value)}
            className="min-w-0 flex-1"
          />
          <Button type="button" variant="outline" onClick={() => void loadJobs()} disabled={busy}>
            {t('record.mark.deepSearch.loadJobs')}
          </Button>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <label htmlFor="deep-search-topic" className="shrink-0 text-xs text-muted-foreground/70">
            {t('record.mark.deepSearch.topicLabel')}
          </label>
          <Input
            id="deep-search-topic"
            value={topicInput}
            maxLength={2000}
            placeholder={t('record.mark.deepSearch.topicPlaceholder')}
            onChange={(event) => setTopicInput(event.target.value)}
            className="min-w-0 flex-1"
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Input
            aria-label={t('record.mark.deepSearch.yearFromLabel')}
            value={yearFromInput}
            inputMode="numeric"
            placeholder={t('record.mark.deepSearch.yearFromLabel')}
            onChange={(event) => setYearFromInput(event.target.value)}
            className="w-24"
          />
          <Input
            aria-label={t('record.mark.deepSearch.yearToLabel')}
            value={yearToInput}
            inputMode="numeric"
            placeholder={t('record.mark.deepSearch.yearToLabel')}
            onChange={(event) => setYearToInput(event.target.value)}
            className="w-24"
          />
          <Input
            aria-label={t('record.mark.deepSearch.languageLabel')}
            value={languageInput}
            maxLength={35}
            placeholder={t('record.mark.deepSearch.languageLabel')}
            onChange={(event) => setLanguageInput(event.target.value)}
            className="w-24"
          />
          <Input
            aria-label={t('record.mark.deepSearch.budgetLabel')}
            value={budgetInput}
            inputMode="decimal"
            placeholder={t('record.mark.deepSearch.budgetLabel')}
            onChange={(event) => setBudgetInput(event.target.value)}
            className="w-28"
          />
          <Input
            aria-label={t('record.mark.deepSearch.maxCandidatesLabel')}
            value={maxCandidatesInput}
            inputMode="numeric"
            placeholder={t('record.mark.deepSearch.maxCandidatesLabel')}
            onChange={(event) => setMaxCandidatesInput(event.target.value)}
            className="w-28"
          />
          <Button type="button" onClick={() => void createJob()} disabled={busy}>
            {t('record.mark.deepSearch.createJob')}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t('record.mark.deepSearch.budgetHint')}</p>
        {formError ? <p className="text-xs text-destructive">{formError}</p> : null}
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('record.mark.deepSearch.jobs')}
        </h3>
        {jobsState.status === "loading" ? (
          <p className="text-xs text-muted-foreground">{t('record.mark.deepSearch.loading')}</p>
        ) : jobsState.status === "error" ? (
          <p className="text-xs text-destructive">
            {jobsState.error ?? t('record.mark.deepSearch.loadFailed')}
          </p>
        ) : jobsState.status === "loaded" && jobsState.jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t('record.mark.deepSearch.noJobs')}</p>
        ) : (
          <ul className="flex min-w-0 flex-col gap-2">
            {jobsState.jobs.map((job) => (
              <li key={job.id} className="flex min-w-0 items-start gap-2">
                <Badge
                  variant={job.status === "completed" ? "success" : job.status === "failed" ? "warning" : "secondary"}
                  className="shrink-0"
                >
                  {t(`record.mark.deepSearch.status.${job.status}`)}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="min-w-0 break-words text-xs">{job.topic}</p>
                  <p className="min-w-0 break-words text-xs text-muted-foreground">
                    {t('record.mark.deepSearch.cost', { cost: job.costExaUsd })}
                    {job.budgetExaUsd !== null
                      ? ` - ${t('record.mark.deepSearch.budget', { budget: job.budgetExaUsd })}`
                      : ""}
                    {job.errorCode ? ` - ${job.errorCode}` : ""}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadDetail(job.id)}
                  disabled={busy}
                >
                  {t('record.mark.deepSearch.viewJob')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {selected !== null ? (
        <div className="flex min-w-0 flex-col gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('record.mark.deepSearch.jobDetail')}
          </h3>
          {detailState.status === "loading" ? (
            <p className="text-xs text-muted-foreground">{t('record.mark.deepSearch.loading')}</p>
          ) : detailState.status === "error" ? (
            <p className="text-xs text-destructive">
              {detailState.error ?? t('record.mark.deepSearch.loadFailed')}
            </p>
          ) : detailState.detail !== null ? (
            <>
              <ul className="flex min-w-0 flex-col gap-1">
                {detailState.detail.steps.map((step) => (
                  <li key={step.id} className="flex min-w-0 items-center gap-2">
                    <Badge variant="outline" className="shrink-0">
                      {t(`record.mark.deepSearch.stepStatus.${step.status}`)}
                    </Badge>
                    <span className="min-w-0 break-words text-xs">
                      {t(`record.mark.deepSearch.step.${step.step}`)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('record.mark.deepSearch.summary', {
                  candidates: detailState.detail.summary.candidates,
                  accepted: detailState.detail.summary.acceptedCandidates,
                  facts: detailState.detail.summary.factCandidates,
                  mapped: detailState.detail.summary.mappedFacts,
                  unmapped: detailState.detail.summary.unmappedFacts,
                })}
              </p>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void loadDetail(selected.id)}
                  disabled={busy}
                >
                  {t('record.mark.deepSearch.refresh')}
                </Button>
                {!selected.input.writingApproved && selected.status !== "completed" ? (
                  <Button
                    type="button"
                    onClick={() =>
                      void runAction(
                        (jobId) => approveDeepSearchWriting(defaultApiClient, jobId),
                        selected.id,
                      )
                    }
                    disabled={busy}
                  >
                    {t('record.mark.deepSearch.approveWriting')}
                  </Button>
                ) : null}
                {isDeepSearchJobActive(selected) && selected.status !== "writing" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void runAction(
                        (jobId) => cancelDeepSearchJob(defaultApiClient, jobId),
                        selected.id,
                      )
                    }
                    disabled={busy}
                  >
                    {t('record.mark.deepSearch.cancel')}
                  </Button>
                ) : null}
                {selected.status === "failed" ? (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void runAction(
                        (jobId) => retryDeepSearchJob(defaultApiClient, jobId),
                        selected.id,
                      )
                    }
                    disabled={busy}
                  >
                    {t('record.mark.deepSearch.retry')}
                  </Button>
                ) : null}
              </div>
              <h4 className="text-xs font-medium text-muted-foreground">
                {t('record.mark.deepSearch.candidates')}
              </h4>
              {detailState.candidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('record.mark.deepSearch.noCandidates')}
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                  {detailState.candidates.map((candidate) => (
                    <CandidateItem key={candidate.id} candidate={candidate} />
                  ))}
                </ul>
              )}
              <h4 className="text-xs font-medium text-muted-foreground">
                {t('record.mark.deepSearch.facts')}
              </h4>
              {detailState.facts.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('record.mark.deepSearch.noFacts')}
                </p>
              ) : (
                <ul className="flex min-w-0 flex-col gap-2">
                  {detailState.facts.map((fact) => (
                    <FactCandidateItem key={fact.id} fact={fact} />
                  ))}
                </ul>
              )}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
