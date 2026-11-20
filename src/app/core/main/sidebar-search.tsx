// Modified for the web fork on 2026-11-16; see FORK.md.
'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FileText, Search, SearchX, X } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { SearchSnippet } from '@/components/search-snippet'
import { useToast } from '@/hooks/use-toast'
import type { Mark } from '@/db/marks'
import { useKeywordSearch } from '@/lib/web/use-keyword-search'
import {
  SEARCH_MAX_QUERY_CHARS,
  searchResultKey,
  type KeywordSearchResult,
} from '@/lib/web/search-client'
import { cn } from '@/lib/utils'
import useArticleStore, {
  beginDeferredFileActivation,
  isDeferredFileActivationCurrent,
} from '@/stores/article'
import useMarkStore from '@/stores/mark'
import { useSidebarStore } from '@/stores/sidebar'

import { createRecordTab } from './mark/mark-record-tab'
import { getMarkTypeListBadgeClasses, MARK_TYPE_OPTIONS } from './mark/mark-type-meta'

type SidebarTab = 'files' | 'notes' | 'canvases'
type SearchType = 'article' | 'record'

const TAB_BY_TYPE: Record<SearchType, SidebarTab> = {
  article: 'files',
  record: 'notes',
}

function searchTypeOf(result: KeywordSearchResult): SearchType {
  return result.kind === 'record' ? 'record' : 'article'
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  const normalizedQuery = query.trim().toLocaleLowerCase()
  if (!normalizedQuery || !text) return <>{text}</>

  const parts: React.ReactNode[] = []
  const normalizedText = text.toLocaleLowerCase()
  let cursor = 0
  let matchIndex = normalizedText.indexOf(normalizedQuery)

  while (matchIndex !== -1) {
    if (matchIndex > cursor) parts.push(text.slice(cursor, matchIndex))
    parts.push(
      <mark key={`${matchIndex}-${cursor}`} className="rounded bg-primary/15 px-0.5 text-foreground">
        {text.slice(matchIndex, matchIndex + normalizedQuery.length)}
      </mark>
    )
    cursor = matchIndex + normalizedQuery.length
    matchIndex = normalizedText.indexOf(normalizedQuery, cursor)
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}

function SearchResultItem({
  result,
  query,
  onSelect,
}: {
  result: KeywordSearchResult
  query: string
  onSelect: (result: KeywordSearchResult) => void
}) {
  const recordTypeT = useTranslations('record.mark.type')
  const recordType = result.kind === 'record'
    && MARK_TYPE_OPTIONS.includes(result.type as Mark['type'])
    ? result.type as Mark['type']
    : null

  return (
    <CommandItem
      value={searchResultKey(result)}
      onSelect={() => onSelect(result)}
      className="block rounded-md px-2 py-2 [&>svg:last-child]:hidden"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {result.kind === 'file' ? (
            <FileText className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : null}
          {recordType ? (
            <Badge
              variant="outline"
              className={cn(getMarkTypeListBadgeClasses(recordType), 'h-4 px-1.5 text-[10px]')}
            >
              {recordTypeT(recordType)}
            </Badge>
          ) : null}
          <div className="min-w-0 truncate text-xs font-medium">
            <HighlightedText text={result.title} query={query} />
          </div>
        </div>
        <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
          <SearchSnippet snippet={result.snippet} matches={result.snippetMatches} />
        </div>
      </div>
    </CommandItem>
  )
}

function SearchResultGroup({
  label,
  results,
  query,
  onSelect,
}: {
  label: string
  results: KeywordSearchResult[]
  query: string
  onSelect: (result: KeywordSearchResult) => void
}) {
  if (results.length === 0) return null

  return (
    <div className="px-1 pb-1">
      <div className="flex items-center justify-between rounded-md bg-muted/45 px-2 py-1.5 text-xs font-medium text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{results.length}</span>
      </div>
      <CommandGroup className="p-1">
        {results.map(result => (
          <SearchResultItem
            key={searchResultKey(result)}
            result={result}
            query={query}
            onSelect={onSelect}
          />
        ))}
      </CommandGroup>
    </div>
  )
}

export function SidebarSearch({ activeTab, children }: { activeTab: SidebarTab; children: React.ReactNode }) {
  const t = useTranslations()
  const router = useRouter()
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const pendingFileRevealPath = useArticleStore(state => state.pendingFileRevealPath)

  useEffect(() => {
    if (pendingFileRevealPath) setQuery('')
  }, [pendingFileRevealPath])

  const sidebarSearchFocusRequest = useSidebarStore(state => state.sidebarSearchFocusRequest)
  const setLeftSidebarTab = useSidebarStore(state => state.setLeftSidebarTab)
  const showCenterPanel = useSidebarStore(state => state.showCenterPanel)
  const setCollapsibleList = useArticleStore(state => state.setCollapsibleList)
  const setActiveFilePath = useArticleStore(state => state.setActiveFilePath)
  const setMatchPosition = useArticleStore(state => state.setMatchPosition)
  const setPendingSearchKeyword = useArticleStore(state => state.setPendingSearchKeyword)
  const addTab = useArticleStore(state => state.addTab)
  const allMarks = useMarkStore(state => state.allMarks)
  const fetchAllMarks = useMarkStore(state => state.fetchAllMarks)
  const setActiveMarkId = useMarkStore(state => state.setActiveMarkId)

  const normalizedQuery = query.trim()
  const searching = Boolean(normalizedQuery)
  const { status, response, searchedQuery, isCurrent, isPending, hasMore, isLoadingMore, loadMoreError, searchNow, retry, loadMore } = useKeywordSearch({
    query,
    scope: 'all',
    enabled: true,
  })
  const showError = searching && status === 'error' && searchedQuery === normalizedQuery
  const currentResults = isCurrent && response ? response.results : []
  const fuzzyStatus = isCurrent && response && !response.fuzzy.available ? response.fuzzy.message : null

  useEffect(() => {
    if (!sidebarSearchFocusRequest) return
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [sidebarSearchFocusRequest])

  const orderedTypes = useMemo<SearchType[]>(() => (
    activeTab === 'notes' ? ['record', 'article'] : ['article', 'record']
  ), [activeTab])

  const groups = useMemo(() => orderedTypes.map(type => ({
    type,
    results: currentResults.filter(result => searchTypeOf(result) === type),
  })), [currentResults, orderedTypes])

  const handleSelect = useCallback(async (result: KeywordSearchResult) => {
    const activationIntent = beginDeferredFileActivation()
    const searchType = searchTypeOf(result)
    await setLeftSidebarTab(TAB_BY_TYPE[searchType])
    if (!isDeferredFileActivationCurrent(activationIntent)) return
    await showCenterPanel()
    if (!isDeferredFileActivationCurrent(activationIntent)) return
    router.push('/core/main')

    if (result.kind === 'record') {
      let mark = allMarks.find(item => item.id === result.id)
      if (!mark) {
        await fetchAllMarks()
        if (!isDeferredFileActivationCurrent(activationIntent)) return
        mark = useMarkStore.getState().allMarks.find(item => item.id === result.id)
      }
      if (!mark) {
        toast({ title: t('search.openFailed'), variant: 'destructive' })
        return
      }
      setActiveMarkId(mark.id)
      await addTab(createRecordTab(mark, t(`record.mark.type.${mark.type}`)))
      if (!isDeferredFileActivationCurrent(activationIntent)) return
      await setActiveFilePath('')
      return
    }

    const filePath = result.path
    try {
      if (!useArticleStore.getState().fileTreeInitialized) {
        await useArticleStore.getState().loadFileTree({ skipRemoteSync: true })
        if (!isDeferredFileActivationCurrent(activationIntent)) return
      }
      const parts = filePath.split('/')
      parts.pop()
      let currentPath = ''
      for (const part of parts) {
        currentPath = currentPath ? `${currentPath}/${part}` : part
        if (!isDeferredFileActivationCurrent(activationIntent)) return
        await useArticleStore.getState().loadCollapsibleFiles(currentPath, { skipRemoteSync: true })
        if (!isDeferredFileActivationCurrent(activationIntent)) return
        await setCollapsibleList(currentPath, true)
      }
      if (!isDeferredFileActivationCurrent(activationIntent)) return
      // The server snippet offsets point inside the snippet, not
      // inside the file content, so they must never be used as a
      // content match position. The editor highlights the pending
      // keyword itself.
      setMatchPosition(null)
      setPendingSearchKeyword(normalizedQuery)
      await setActiveFilePath(filePath, true, { tabOpenMode: 'preview' })
      if (useArticleStore.getState().activeFilePath !== filePath) return
      useArticleStore.getState().setPendingFileRevealPath(filePath)
      setQuery('')
    } catch (error) {
      console.error('Failed to open sidebar search result:', error)
      toast({ title: t('search.openFailed'), variant: 'destructive' })
    }
  }, [addTab, allMarks, fetchAllMarks, normalizedQuery, router, setActiveFilePath, setActiveMarkId, setCollapsibleList, setLeftSidebarTab, setMatchPosition, setPendingSearchKeyword, showCenterPanel, t, toast])

  const getTypeLabel = (type: SearchType) => t(`search.item.${type}`)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-2 py-2">
        <InputGroup focusRing="subtle" className="h-8 bg-background shadow-none">
          <InputGroupAddon className="text-muted-foreground">
            {isPending ? <Spinner /> : <Search />}
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            data-testid="search-input"
            value={query}
            maxLength={SEARCH_MAX_QUERY_CHARS}
            onChange={event => setQuery(event.target.value)}
            onKeyDown={event => {
              if (event.key === 'Escape' && query) {
                event.preventDefault()
                setQuery('')
              }
              if (event.key === 'Enter') {
                event.preventDefault()
                searchNow()
              }
            }}
            placeholder={t('search.placeholder')}
            aria-label={t('search.placeholder')}
            className="text-xs"
          />
          {query ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                size="icon-xs"
                data-testid="search-clear"
                onClick={() => setQuery('')}
                aria-label={t('search.clear')}
                title={t('search.clear')}
              >
                <X />
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
      </div>

      {!searching ? children : (
        <Command shouldFilter={false} className="min-h-0 flex-1 rounded-none">
          <CommandList data-testid="search-results" className="app-panel-scrollbar max-h-none flex-1 overflow-y-auto">
            {fuzzyStatus ? (
              <div data-testid="search-fuzzy-status" role="status" className="px-3 pb-1 pt-2 text-[11px] leading-4 text-muted-foreground">
                {fuzzyStatus}
              </div>
            ) : null}

            {showError ? (
              <div data-testid="search-error" className="px-3 py-4">
                <Empty className="min-h-32 border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
                    <EmptyTitle>{t('article.file.search.remoteError')}</EmptyTitle>
                    <EmptyDescription>
                      <Button variant="outline" size="sm" onClick={() => retry()}>
                        {t('article.file.search.retry')}
                      </Button>
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}

            {!showError && isCurrent && currentResults.length === 0 ? (
              <div data-testid="search-empty">
                <Empty className="min-h-48 border-0">
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><SearchX /></EmptyMedia>
                    <EmptyTitle>{t('search.noResults')}</EmptyTitle>
                    <EmptyDescription>{t('search.tryDifferentKeywords')}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              </div>
            ) : null}

            {!showError && currentResults.length > 0 ? (
              <div className="px-3 pb-1 pt-1 text-xs font-medium text-foreground">
                {t('search.exactMatches')}
              </div>
            ) : null}

            {!showError && groups.map(group => (
              <SearchResultGroup
                key={group.type}
                label={getTypeLabel(group.type)}
                results={group.results}
                query={normalizedQuery}
                onSelect={result => void handleSelect(result)}
              />
            ))}

            {isCurrent && currentResults.length > 0 && hasMore ? (
              <div className="flex flex-col items-center gap-2 px-3 py-3">
                {loadMoreError ? (
                  <div data-testid="search-load-more-error" className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                    <span>{t('article.file.search.remoteError')}</span>
                    <Button variant="outline" size="sm" data-testid="search-load-more-retry" onClick={() => loadMore()}>
                      {t('article.file.search.retry')}
                    </Button>
                  </div>
                ) : null}
                <Button variant="outline" size="sm" data-testid="search-load-more" disabled={isLoadingMore} onClick={() => loadMore()}>
                  {isLoadingMore ? <Spinner /> : null}
                  {isLoadingMore ? t('search.loadingMore') : t('search.loadMore')}
                </Button>
              </div>
            ) : null}

            {isPending ? (
              <div className="flex items-center justify-center gap-2 px-3 py-4 text-xs text-muted-foreground" role="status">
                <Spinner />
              </div>
            ) : null}
          </CommandList>
        </Command>
      )}
    </div>
  )
}
