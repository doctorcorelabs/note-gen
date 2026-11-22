// Modified for the web fork on 2026-11-16; see FORK.md.
'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Empty, EmptyHeader, EmptyTitle, EmptyDescription } from '@/components/ui/empty'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Separator } from '@/components/ui/separator'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { SearchSnippet } from '@/components/search-snippet'
import { cn } from '@/lib/utils'
import { File, FolderTree, NotebookPen, SearchX, Tags } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { platform } from '@/lib/platform'
import useArticleStore, {
  beginDeferredFileActivation,
  isDeferredFileActivationCurrent,
} from '@/stores/article'
import useMarkStore from '@/stores/mark'
import useTagStore from '@/stores/tag'
import { useSidebarStore } from '@/stores/sidebar'
import { usePathname, useRouter } from 'next/navigation'
import emitter from '@/lib/emitter'
import { EmitterRecordEvents } from '@/config/emitters'
import { useKeywordSearch } from '@/lib/web/use-keyword-search'
import {
  SEARCH_MAX_QUERY_CHARS,
  recordResultTagId,
  scopeForSearchFilter,
  searchResultKey,
  type KeywordSearchResult,
  type SearchFilter,
} from '@/lib/web/search-client'

interface SearchDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  mobile?: boolean
}

export function SearchDialog({ open, onOpenChange, mobile = false }: SearchDialogProps) {
  const t = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const [searchValue, setSearchValue] = useState('')
  const [searchFilter, setSearchFilter] = useState<SearchFilter>('all')
  const { setActiveFilePath, setMatchPosition, setPendingSearchKeyword, setCollapsibleList } = useArticleStore()
  const { setPendingScrollMarkId } = useMarkStore()
  const { setCurrentTagId } = useTagStore()
  const { setLeftSidebarTab } = useSidebarStore()
  const isMobileRoute = mobile || pathname.startsWith('/mobile')
  const searchInputRef = useRef<HTMLInputElement | null>(null)

  const trimmedQuery = searchValue.trim()
  const { status, response, searchedQuery, isCurrent, isPending, hasMore, isLoadingMore, loadMoreError, searchNow, retry, loadMore } = useKeywordSearch({
    query: searchValue,
    scope: scopeForSearchFilter(searchFilter),
    enabled: open,
  })
  const searchResult = isCurrent && response ? response.results : []
  const showError = Boolean(trimmedQuery) && status === 'error' && searchedQuery === trimmedQuery
  const fuzzyStatus = isCurrent && response && !response.fuzzy.available ? response.fuzzy.message : null
  const degradedStatus = isCurrent && response?.degraded ? t('search.degraded') : null

  // 高亮搜索关键词 (titles only; snippets use server offsets)
  function highlightText(text: string, query: string) {
    if (!query.trim() || !text) return text

    // DA-6 F-15-08: highlight per term, matching the server AND
    // semantics; a whole-phrase search missed titles where the
    // terms are spread apart.
    const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    if (terms.length === 0) return text
    const lowerText = text.toLowerCase()
    const ranges: Array<{ start: number; end: number }> = []
    for (const term of terms) {
      let from = 0
      for (;;) {
        const at = lowerText.indexOf(term, from)
        if (at === -1) break
        ranges.push({ start: at, end: at + term.length })
        from = at + term.length
      }
    }
    if (ranges.length === 0) return text
    ranges.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))

    const parts: React.ReactNode[] = []
    let lastIndex = 0
    for (const range of ranges) {
      if (range.start < lastIndex) continue
      if (range.start > lastIndex) {
        parts.push(text.substring(lastIndex, range.start))
      }
      parts.push(
        <mark key={range.start} className="rounded bg-primary/15 px-0.5 text-foreground">
          {text.substring(range.start, range.end)}
        </mark>
      )
      lastIndex = range.end
    }
    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex))
    }

    return <>{parts}</>
  }

  function getResultMeta(item: KeywordSearchResult) {
    if (item.kind === 'record') {
      return {
        icon: Tags,
        primary: t('search.item.record'),
        secondary: item.type || null,
      }
    }

    return {
      icon: FolderTree,
      primary: item.path || t('search.item.article'),
      secondary: null,
    }
  }

  function getResultTone(item: KeywordSearchResult) {
    return item.kind === 'record'
      ? 'border border-primary/20 bg-primary/10 text-primary'
      : 'border border-border bg-muted text-muted-foreground'
  }

  async function handleSelect(item: KeywordSearchResult) {
    const activationIntent = beginDeferredFileActivation()
    // 如果是记录类型，跳转到记录页面并设置对应的 tag
    if (item.kind === 'record') {
      onOpenChange(false)
      setPendingSearchKeyword('')
      setMatchPosition(null)
      setPendingScrollMarkId(item.id)

      const tagId = recordResultTagId(item)
      if (tagId) {
        await setCurrentTagId(tagId)
        if (!isDeferredFileActivationCurrent(activationIntent)) return
      }

      if (!isMobileRoute) {
        // PC 端：切换到记录标签页
        await setLeftSidebarTab('notes')
        if (!isDeferredFileActivationCurrent(activationIntent)) return
      } else {
        // 移动端：进入记录页
        router.push('/mobile/record')
      }

      emitter.emit(EmitterRecordEvents.refreshMarks)

      return
    }

    onOpenChange(false)
    setPendingScrollMarkId(null)

    // PC 端切换到笔记标签页；移动端直接跳转写作页
    if (!isMobileRoute) {
      await setLeftSidebarTab('files')
      if (!isDeferredFileActivationCurrent(activationIntent)) return
    }

    const filePath = item.path

    const setupAndNavigate = async () => {
      if (!useArticleStore.getState().fileTreeInitialized) {
        await useArticleStore.getState().loadFileTree({ skipRemoteSync: true })
        if (!isDeferredFileActivationCurrent(activationIntent)) return
      }
      // 展开文件夹路径
      const pathParts = filePath.split('/')
      pathParts.pop()

      let currentPath = ''
      for (const part of pathParts) {
        if (currentPath) {
          currentPath += '/' + part
        } else {
          currentPath = part
        }

        if (currentPath) {
          if (!isDeferredFileActivationCurrent(activationIntent)) return
          await useArticleStore.getState().loadCollapsibleFiles(currentPath, { skipRemoteSync: true })
          if (!isDeferredFileActivationCurrent(activationIntent)) return
          await setCollapsibleList(currentPath, true)
        }
      }
      if (!isDeferredFileActivationCurrent(activationIntent)) return

      // The server snippet offsets point inside the snippet, not
      // inside the file content, so they must never be used as a
      // content match position. The editor highlights the pending
      // keyword itself.
      setMatchPosition(null)
      setPendingSearchKeyword(searchValue.trim())

      // 设置活动文件路径
      await setActiveFilePath(
        filePath,
        true,
        isMobileRoute ? undefined : { tabOpenMode: 'preview' },
      )
      if (useArticleStore.getState().activeFilePath !== filePath) return
      if (!isMobileRoute) {
        useArticleStore.getState().setPendingFileRevealPath(filePath)
      }

      // 跳转到对应平台页面
      router.push(isMobileRoute ? '/mobile/writing' : '/core/main')
    }

    void setupAndNavigate().catch(error => {
      console.error('Failed to open search result:', error)
    })
  }

  useEffect(() => {
    const loadSearchFilter = async () => {
      const store = await platform.store.load('store.json')
      const savedFilter = await store.get<SearchFilter>('globalSearchFilter')
      if (savedFilter === 'all' || savedFilter === 'record' || savedFilter === 'article') {
        setSearchFilter(savedFilter)
      }
    }

    loadSearchFilter()
  }, [])

  useEffect(() => {
    const persistSearchFilter = async () => {
      const store = await platform.store.load('store.json')
      await store.set('globalSearchFilter', searchFilter)
    }

    persistSearchFilter()
  }, [searchFilter])

  useEffect(() => {
    if (!open || isMobileRoute) return
    const timer = setTimeout(() => {
      searchInputRef.current?.focus()
    }, 60)
    return () => clearTimeout(timer)
  }, [open, isMobileRoute])

  const handleDrawerAnimationEnd = useCallback((drawerOpen: boolean) => {
    if (!drawerOpen) return

    searchInputRef.current?.focus()
  }, [])

  const searchContent = (
    <>
      <div
        className={cn(
          "flex border-b border-border/70 px-4 py-3",
          isMobileRoute
            ? "flex-col items-stretch gap-2"
            : "items-center gap-3"
        )}
      >
        <div className="min-w-0 flex-1">
          <CommandInput
            ref={searchInputRef}
            data-testid="search-dialog-input"
            autoFocus={!isMobileRoute}
            placeholder={t('search.placeholder')}
            value={searchValue}
            maxLength={SEARCH_MAX_QUERY_CHARS}
            onValueChange={setSearchValue}
            onKeyDown={event => {
              if (event.key === 'Enter') searchNow()
            }}
            className="h-10 text-base font-medium"
          />
        </div>
        <div
          className={cn(
            "flex shrink-0 items-center gap-3",
            isMobileRoute && "justify-end px-1"
          )}
        >
          {!isMobileRoute ? (
            <>
              <div className="text-sm font-semibold tracking-tight text-foreground/90">
                {t('search.results', { count: hasMore ? `${searchResult.length}+` : searchResult.length })}
              </div>
              <Separator orientation="vertical" className="h-5" />
            </>
          ) : null}
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            value={searchFilter}
            onValueChange={(value) => value && setSearchFilter(value as SearchFilter)}
          >
            <ToggleGroupItem value="all" aria-label={t('common.all')}>
              {t('common.all')}
            </ToggleGroupItem>
            <ToggleGroupItem value="record" aria-label={t('search.item.record')}>
              {t('search.item.record')}
            </ToggleGroupItem>
            <ToggleGroupItem value="article" aria-label={t('search.item.article')}>
              {t('search.item.article')}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <CommandList className={isMobileRoute ? "h-[64vh] max-h-[64vh]" : "min-h-0 flex-1 max-h-none"}>
        {fuzzyStatus ? (
          <div data-testid="search-dialog-fuzzy-status" role="status" className="px-5 pb-1 pt-3 text-xs leading-5 text-muted-foreground">
            {fuzzyStatus}
          </div>
        ) : null}
        {degradedStatus ? (
          <div data-testid="search-dialog-degraded" role="status" className="px-5 pb-1 pt-3 text-xs leading-5 text-muted-foreground">
            {degradedStatus}
          </div>
        ) : null}
        {!searchValue && (
          <Empty className="border-0">
            <EmptyHeader>
              <SearchX className="size-10 text-muted-foreground" />
              <EmptyTitle>{t('search.placeholder')}</EmptyTitle>
              <EmptyDescription>
                {t('search.tryDifferentKeywords')}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        )}
        {showError && (
          <div data-testid="search-dialog-error">
            <Empty className="border-0">
              <EmptyHeader>
                <SearchX className="size-10 text-muted-foreground" />
                <EmptyTitle>{t('article.file.search.remoteError')}</EmptyTitle>
                <EmptyDescription>
                  <Button variant="outline" size="sm" data-testid="search-dialog-retry" onClick={() => retry()}>
                    {t('article.file.search.retry')}
                  </Button>
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
        {!showError && searchResult.length === 0 && searchValue && isCurrent && (
          <div data-testid="search-dialog-empty">
            <Empty className="border-0">
              <EmptyHeader>
                <SearchX className="size-10 text-muted-foreground" />
                <EmptyTitle>{t('search.noResults')}</EmptyTitle>
                <EmptyDescription>
                  {t('search.tryDifferentKeywords')}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          </div>
        )}
        {isPending && searchValue && !isCurrent ? (
          <div className="flex items-center justify-center gap-2 px-5 py-4 text-xs text-muted-foreground" role="status">
            <Spinner />
          </div>
        ) : null}
        {searchResult.length > 0 && (
          <CommandGroup>
            <div className="flex flex-col divide-y divide-border/60">
              {searchResult.map((item) => {
              const resultMeta = getResultMeta(item)
              const MetaIcon = resultMeta.icon
              return (
                <CommandItem
                  key={searchResultKey(item)}
                  value={`${searchResultKey(item)} ${item.title}`}
                  onSelect={() => handleSelect(item)}
                  className="group flex flex-col items-start gap-0 rounded-none bg-transparent p-0 text-left data-[selected=true]:bg-muted/30"
                >
                    <div className="w-full py-3">
                      <div className="flex items-start gap-3 px-2 py-2 transition-colors group-data-[selected=true]:bg-muted/30">
                        <div className={cn("mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg", getResultTone(item))}>
                          {item.kind === 'record' ? (
                            <NotebookPen className="size-3.5" />
                          ) : (
                            <File className="size-3.5" />
                          )}
                        </div>

                        <div className="flex min-w-0 flex-1 flex-col gap-2.5">
                          <div className="flex min-w-0 items-start justify-between gap-4">
                            <div className="min-w-0 flex-1">
                              {item.title && (
                                <div className="truncate text-[14px] font-semibold tracking-tight text-foreground">
                                  {highlightText(item.title, searchValue)}
                                </div>
                              )}
                            </div>

                            <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5">
                                {item.kind === 'record' && item.type ? (
                                  <Badge variant="outline" className="rounded-full px-2 py-0.5 text-[10px] capitalize">
                                    {item.type}
                                  </Badge>
                                ) : null}
                                <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                                  <MetaIcon className="size-3 shrink-0" />
                                  <span className="max-w-[180px] truncate">{resultMeta.primary}</span>
                                </div>
                            </div>
                          </div>

                          <div className="line-clamp-2 text-[12px] leading-5 text-muted-foreground">
                            <SearchSnippet snippet={item.snippet} matches={item.snippetMatches} />
                          </div>
                        </div>
                      </div>
                    </div>
                </CommandItem>
              )
            })}
            </div>
          </CommandGroup>
        )}
        {isCurrent && searchResult.length > 0 && hasMore && (
          <div className="flex flex-col items-center gap-2 px-5 py-3">
            {loadMoreError ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <span>{t('article.file.search.remoteError')}</span>
                <Button variant="outline" size="sm" data-testid="search-dialog-load-more-retry" onClick={() => loadMore()}>
                  {t('article.file.search.retry')}
                </Button>
              </div>
            ) : null}
            <Button variant="outline" size="sm" data-testid="search-dialog-load-more" disabled={isLoadingMore} onClick={() => loadMore()}>
              {isLoadingMore ? <Spinner /> : null}
              {isLoadingMore ? t('search.loadingMore') : t('search.loadMore')}
            </Button>
          </div>
        )}
      </CommandList>
    </>
  )

  if (isMobileRoute) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange} onAnimationEnd={handleDrawerAnimationEnd}>
        <DrawerContent className="h-[88vh] rounded-t-[28px] border-border/70 bg-background p-0 shadow-2xl">
          <div className="min-h-0 flex-1 px-3 pb-3 pt-3">
        <Command
          shouldFilter={false}
          className={cn(
            "h-full rounded-[22px] border border-border/70 bg-background shadow-sm",
            "[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:py-3 [&_[cmdk-group-heading]]:text-sm [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-tight [&_[cmdk-group-heading]]:text-foreground/85",
                "[&_[cmdk-group]]:px-0 [&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:bg-transparent [&_[cmdk-input-wrapper]]:px-0",
                "[&_[cmdk-input-wrapper]_svg]:size-5 [&_[cmdk-input-wrapper]_svg]:text-muted-foreground",
                "[&_[cmdk-input]]:h-10 [&_[cmdk-input]]:text-base [&_[cmdk-input]]:font-medium [&_[cmdk-input]]:tracking-tight [&_[cmdk-input]]:placeholder:text-muted-foreground/60",
                "[&_[cmdk-list]]:px-0 [&_[cmdk-list]]:py-2 [&_[cmdk-item]]:rounded-2xl [&_[cmdk-item]]:px-0 [&_[cmdk-item]]:py-0"
              )}
            >
              {searchContent}
            </Command>
          </div>
        </DrawerContent>
      </Drawer>
    )
  }

  return (
      <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="h-[56vh] max-h-[56vh] max-w-4xl overflow-hidden p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">{t('search.placeholder')}</DialogTitle>
        <Command
          shouldFilter={false}
          className={cn(
            "h-full bg-transparent",
            "[&_[cmdk-group-heading]]:px-5 [&_[cmdk-group-heading]]:py-3 [&_[cmdk-group-heading]]:text-base [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-tight [&_[cmdk-group-heading]]:text-foreground/85",
            "[&_[cmdk-group]]:px-0 [&_[cmdk-input-wrapper]]:border-0 [&_[cmdk-input-wrapper]]:bg-transparent [&_[cmdk-input-wrapper]]:px-0",
            "[&_[cmdk-input-wrapper]_svg]:size-4 [&_[cmdk-input-wrapper]_svg]:text-muted-foreground",
            "[&_[cmdk-input]]:h-10 [&_[cmdk-input]]:text-base [&_[cmdk-input]]:font-medium [&_[cmdk-input]]:tracking-tight [&_[cmdk-input]]:placeholder:text-muted-foreground/60",
            "[&_[cmdk-list]]:px-0 [&_[cmdk-list]]:py-2"
          )}
        >
          {searchContent}
        </Command>
      </DialogContent>
    </Dialog>
  )
}
