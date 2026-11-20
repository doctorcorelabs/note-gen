'use client'
// Modified for the web fork on 2026-11-18; see FORK.md.

import { useEffect, useRef } from 'react'
import { Check, Loader2, TriangleAlert } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import useArticleStore from '@/stores/article'
import { toast } from '@/hooks/use-toast'

/**
 * Honest save status for one editor tab (S-P0-18 / DA-10-F07).
 *
 * Autosave failures used to be console-only, so a user could close a
 * tab believing a failed save had succeeded. This indicator reads the
 * article store status for its own path: saving while a save is
 * queued or in flight, saved after the server confirms the write,
 * and failed (persistently, until a retry succeeds or a newer edit
 * replaces the failed save) when the last commit failed. A revision
 * conflict is deliberately not shown here: the conflict dialog owns
 * that surface, and the store clears the save status for conflicts.
 *
 * A failed save also raises one destructive toast per failure, with
 * a retry action. The toast is keyed by the failure timestamp so a
 * re-render or StrictMode effect replay never duplicates it.
 */
export function ArticleSaveStatus({ filePath }: { filePath: string }) {
  const { entry, retryArticleSave } = useArticleStore(useShallow((state) => ({
    entry: state.articleSaveStatus[filePath] ?? null,
    retryArticleSave: state.retryArticleSave,
  })))
  const lastToastedFailedAtRef = useRef<number | null>(null)

  useEffect(() => {
    if (!entry || entry.status !== 'failed') return
    if (lastToastedFailedAtRef.current === entry.updatedAt) return
    lastToastedFailedAtRef.current = entry.updatedAt
    toast({
      title: 'Save failed',
      description: entry.errorMessage ?? 'The document could not be saved.',
      variant: 'destructive',
      action: {
        label: 'Retry',
        onClick: () => {
          void retryArticleSave(filePath)
        },
      },
    })
  }, [entry, filePath, retryArticleSave])

  if (!entry) return null

  if (entry.status === 'saved') {
    return (
      <div aria-live="polite" className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
        <Check className="size-3.5" aria-hidden="true" />
        <span>Saved</span>
      </div>
    )
  }

  if (entry.status === 'pending' || entry.status === 'saving') {
    return (
      <div aria-live="polite" className="flex items-center gap-1.5 px-3 py-1 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
        <span>Saving...</span>
      </div>
    )
  }

  return (
    <div role="alert" className="flex items-center gap-2 px-3 py-1 text-xs text-destructive">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate">
        Save failed
        {entry.errorCode ? ` (${entry.errorCode})` : ''}
        {entry.errorMessage ? `: ${entry.errorMessage}` : ''}
      </span>
      <button
        type="button"
        onClick={() => void retryArticleSave(filePath)}
        className="shrink-0 rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Retry
      </button>
    </div>
  )
}
