// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.
//
// Keyword search hook (Fase 1, V3-28). One hook serves both search
// surfaces (the sidebar search and the search dialog) so both go
// through the same server endpoint, the same debounce, and the same
// state machine. The hook owns no input element and no result
// rendering; components own their inputs and open-result wiring.
//
// Anti-flaky contract (fase1/desain-pengujian.md section 4.3): the
// 300 ms debounce only coalesces keystrokes. Nothing in this hook
// or in the components waits on a fixed sleep to decide what to
// show: every visible state (results, explicit empty state, error
// state, fuzzy status line) is a function of the request outcome,
// and E2E tests wait on those observable states with Playwright
// assertions, never on a fixed-duration wait. Pressing Enter calls
// searchNow for an immediate search without waiting for the
// debounce. A superseded request is aborted and its outcome is
// ignored by run id, so a slow earlier query can never overwrite a
// newer result or empty state.

import { useCallback, useEffect, useRef, useState } from "react";

import { defaultApiClient, type ApiClient } from "./api-client";
import type { ApiError } from "./errors";
import {
  normalizeSearchQuery,
  searchKeyword,
  type KeywordSearchResponse,
  type SearchScope,
} from "./search-client";

export type KeywordSearchStatus = "idle" | "loading" | "loaded" | "error";

export interface UseKeywordSearchOptions {
  /** Raw input value; trimmed and bounded inside the hook. */
  query: string;
  scope: SearchScope;
  /** False while the surface is closed; aborts in-flight work. */
  enabled: boolean;
  /** API client; defaults to the shared unwired client (GET needs no CSRF). */
  client?: ApiClient;
  /** Keystroke coalescing delay in milliseconds; defaults to 300. */
  debounceMs?: number;
}

export interface UseKeywordSearchResult {
  status: KeywordSearchStatus;
  /** Last completed response; check isCurrent before rendering it. */
  response: KeywordSearchResponse | null;
  /** Last failure; meaningful only when status is "error". */
  error: ApiError | null;
  /** Query of the last started run (completed, failed, or in flight). */
  searchedQuery: string;
  /** True when the response matches the current query and scope. */
  isCurrent: boolean;
  /** True when a search for the current query is scheduled or in flight. */
  isPending: boolean;
  /** Run the current query immediately, cancelling the debounce. */
  searchNow: () => void;
  /** Re-run the current query immediately (error-state retry). */
  retry: () => void;
}

export const KEYWORD_SEARCH_DEBOUNCE_MS = 300;

export function useKeywordSearch(options: UseKeywordSearchOptions): UseKeywordSearchResult {
  const { query, scope, enabled } = options;
  const client = options.client ?? defaultApiClient;
  const debounceMs = options.debounceMs ?? KEYWORD_SEARCH_DEBOUNCE_MS;
  const normalized = normalizeSearchQuery(query);

  const [status, setStatus] = useState<KeywordSearchStatus>("idle");
  const [response, setResponse] = useState<KeywordSearchResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [searchedQuery, setSearchedQuery] = useState("");
  const runRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const execute = useCallback(
    async (queryToSearch: string, scopeToSearch: SearchScope) => {
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      const runId = ++runRef.current;
      setStatus("loading");
      setError(null);
      setSearchedQuery(queryToSearch);
      try {
        const page = await searchKeyword(
          client,
          { query: queryToSearch, scope: scopeToSearch },
          { signal: controller.signal },
        );
        if (runId !== runRef.current) {
          return;
        }
        setResponse(page);
        setStatus("loaded");
      } catch (caught) {
        if (runId !== runRef.current) {
          return;
        }
        setError(caught as ApiError);
        setStatus("error");
      }
    },
    [client],
  );

  useEffect(() => {
    if (!enabled || normalized === null) {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      runRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
      setStatus("idle");
      setResponse(null);
      setError(null);
      setSearchedQuery("");
      return;
    }
    const timer = setTimeout(() => {
      timerRef.current = null;
      void execute(normalized, scope);
    }, debounceMs);
    timerRef.current = timer;
    return () => {
      clearTimeout(timer);
      if (timerRef.current === timer) {
        timerRef.current = null;
      }
      runRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [debounceMs, enabled, execute, normalized, scope]);

  useEffect(
    () => () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      runRef.current += 1;
      controllerRef.current?.abort();
    },
    [],
  );

  const searchNow = useCallback(() => {
    if (!enabled || normalized === null) {
      return;
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    void execute(normalized, scope);
  }, [enabled, execute, normalized, scope]);

  const isCurrent =
    status === "loaded" &&
    response !== null &&
    response.query === normalized &&
    response.scope === scope;
  const isPending =
    enabled &&
    normalized !== null &&
    !isCurrent &&
    !(status === "error" && searchedQuery === normalized);

  return {
    status,
    response,
    error,
    searchedQuery,
    isCurrent,
    isPending,
    searchNow,
    retry: searchNow,
  };
}
