'use client'

// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Workspace file trash panel (F-05-01). Web-only surface over the
// existing server trash routes: list with cursor paging, restore,
// permanent delete per entry, and empty trash. Every failure is
// shown through userErrorMessage; nothing is swallowed. Restores
// refresh the file tree so the workspace view stays consistent.

import { useCallback, useEffect, useRef, useState } from 'react'
import { File, Folder, LoaderCircle, RotateCcw, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { ScrollArea } from '@/components/ui/scroll-area'
import { toast } from '@/hooks/use-toast'
import { platform } from '@/lib/platform'
import { useUserErrorMessage } from '@/lib/use-user-error-message'
import type {
  EmptyWorkspaceTrashResult,
  ListWorkspaceTrashResult,
  WorkspaceTrashEntry,
} from '@/lib/platform/invoke/workspace-trash-handler'
import useArticleStore from '@/stores/article'
import { appendTrashPage, formatTrashSize, removeTrashEntries } from './trash-panel-model'

const PAGE_LIMIT = 50

interface TrashPanelProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function TrashPanel({ open, onOpenChange }: TrashPanelProps) {
  const t = useTranslations('article.file.trash')
  const userErrorMessage = useUserErrorMessage()
  const loadFileTree = useArticleStore(state => state.loadFileTree)
  const [entries, setEntries] = useState<WorkspaceTrashEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [totalCount, setTotalCount] = useState(0)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [emptying, setEmptying] = useState(false)
  const generationRef = useRef(0)

  const loadFirstPage = useCallback(async () => {
    const generation = ++generationRef.current
    setLoading(true)
    setLoadFailed(false)
    try {
      const result = await platform.invoke.invoke<ListWorkspaceTrashResult>(
        'list_workspace_trash',
        { limit: PAGE_LIMIT },
      )
      if (generation !== generationRef.current) return
      setEntries(result.entries)
      setNextCursor(result.nextCursor)
      setTotalCount(result.totalCount)
    } catch (error) {
      if (generation !== generationRef.current) return
      setLoadFailed(true)
      const message = userErrorMessage(error)
      if (message) toast({ title: t('loadError'), description: message, variant: 'destructive' })
    } finally {
      if (generation === generationRef.current) setLoading(false)
    }
  }, [t, userErrorMessage])

  useEffect(() => {
    if (open) {
      void loadFirstPage()
    } else {
      generationRef.current++
    }
  }, [open, loadFirstPage])

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await platform.invoke.invoke<ListWorkspaceTrashResult>(
        'list_workspace_trash',
        { limit: PAGE_LIMIT, cursor: nextCursor },
      )
      setEntries(current => appendTrashPage(current, result.entries))
      setNextCursor(result.nextCursor)
      setTotalCount(result.totalCount)
    } catch (error) {
      const message = userErrorMessage(error)
      if (message) toast({ title: t('loadError'), description: message, variant: 'destructive' })
    } finally {
      setLoadingMore(false)
    }
  }

  async function handleRestore(entry: WorkspaceTrashEntry) {
    if (busyId) return
    setBusyId(entry.id)
    try {
      await platform.invoke.invoke('restore_workspace_trash_entry', { id: entry.id })
      setEntries(current => removeTrashEntries(current, new Set([entry.id])))
      setTotalCount(current => Math.max(0, current - 1))
      toast({ title: t('restored', { name: entry.name }) })
      await loadFileTree({ skipRemoteSync: true })
    } catch (error) {
      const message = userErrorMessage(error)
      if (message) toast({ title: t('restoreFailed'), description: message, variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  async function handlePurge(entry: WorkspaceTrashEntry) {
    if (busyId) return
    const confirmed = await platform.dialog.ask(t('confirmPurge', { name: entry.name }), {
      title: entry.name,
      kind: 'warning',
    })
    if (!confirmed) return
    setBusyId(entry.id)
    try {
      await platform.invoke.invoke('purge_workspace_trash_entry', { id: entry.id })
      setEntries(current => removeTrashEntries(current, new Set([entry.id])))
      setTotalCount(current => Math.max(0, current - 1))
      toast({ title: t('purged', { name: entry.name }) })
    } catch (error) {
      const message = userErrorMessage(error)
      if (message) toast({ title: t('purgeFailed'), description: message, variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  async function handleEmptyTrash() {
    if (emptying || totalCount === 0) return
    const confirmed = await platform.dialog.ask(t('confirmEmpty', { count: totalCount }), {
      title: t('title'),
      kind: 'warning',
    })
    if (!confirmed) return
    setEmptying(true)
    try {
      const result = await platform.invoke.invoke<EmptyWorkspaceTrashResult>(
        'empty_workspace_trash',
        { confirm: true },
      )
      if (result.failed > 0) {
        toast({
          title: t('emptied'),
          description: t('emptiedPartialDesc', { purged: result.purged, failed: result.failed }),
          variant: 'destructive',
        })
      } else {
        toast({ title: t('emptied'), description: t('emptiedDesc', { purged: result.purged }) })
      }
      await loadFirstPage()
    } catch (error) {
      const message = userErrorMessage(error)
      if (message) toast({ title: t('emptyFailed'), description: message, variant: 'destructive' })
    } finally {
      setEmptying(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            {t('loading')}
          </div>
        ) : loadFailed ? (
          <div className="flex flex-col items-center gap-3 py-10 text-sm text-muted-foreground">
            <span>{t('loadError')}</span>
            <Button variant="outline" size="sm" onClick={() => void loadFirstPage()}>
              {t('retry')}
            </Button>
          </div>
        ) : entries.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-10 text-sm text-muted-foreground">
            <span>{t('empty')}</span>
            <span className="text-xs">{t('emptyDesc')}</span>
          </div>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">{t('totalCount', { count: totalCount })}</div>
            <ScrollArea className="max-h-80">
              <div className="flex flex-col gap-1 pr-3">
                {entries.map(entry => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-2 rounded-md border px-2 py-1.5"
                  >
                    {entry.kind === 'folder'
                      ? <Folder className="size-4 shrink-0 text-muted-foreground" />
                      : <File className="size-4 shrink-0 text-muted-foreground" />}
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{entry.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {entry.originalPath}
                        {' - '}
                        {formatTrashSize(entry.size)}
                        {' - '}
                        {t('deletedAt', { date: new Date(entry.deletedAt).toLocaleString() })}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void handleRestore(entry)}
                    >
                      {busyId === entry.id
                        ? <LoaderCircle className="size-4 animate-spin" />
                        : <RotateCcw className="size-4" />}
                      {t('restore')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId !== null}
                      onClick={() => void handlePurge(entry)}
                    >
                      <Trash2 className="size-4" />
                      {t('deletePermanently')}
                    </Button>
                  </div>
                ))}
              </div>
            </ScrollArea>
            {nextCursor ? (
              <Button variant="outline" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <LoaderCircle className="size-4 animate-spin" /> : null}
                {t('loadMore')}
              </Button>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button
            variant="destructive"
            disabled={emptying || loading || totalCount === 0}
            onClick={() => void handleEmptyTrash()}
          >
            {emptying ? <LoaderCircle className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {t('emptyTrash')}
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
