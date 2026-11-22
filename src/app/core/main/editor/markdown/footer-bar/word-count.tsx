'use client'

import { Editor } from '@tiptap/react'
import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Type } from 'lucide-react'

import {
  editorLeafText,
  getEditorStatistics,
  markdownToPlainText,
  type EditorStatistics,
} from '@/lib/editor-statistics'

interface WordCountProps {
  editor: Editor
  sourceMarkdown?: string
  compact?: boolean
}

const SOURCE_STATISTICS_DEBOUNCE_MS = 600
const SOURCE_STATISTICS_IDLE_TIMEOUT_MS = 1_500

// Visual-mode text basis: block-separated text so the count
// matches the source-mode basis (markdownToPlainText inserts a
// newline between blocks). doc.textContent joins blocks with no
// separator, which undercounts and merges words at block
// boundaries (UTANG-UJI-08). Leaf text counts mermaid code and
// image alt, which the source basis also counts, so the number
// no longer changes when switching modes (UTANG-UJI-08 putaran 2).
function visualText(editor: Editor): string {
  return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n', editorLeafText)
}

export function WordCount({ editor, sourceMarkdown, compact = false }: WordCountProps) {
  const t = useTranslations('settings.editor.stats')
  // Source mode counts synchronously at mount too (STAT-07): the
  // debounced effect below runs the same parse 600 ms later for
  // subsequent changes, so opening a note directly in source mode
  // no longer flashes "0 characters" first.
  const [statistics, setStatistics] = useState<EditorStatistics>(() => (
    sourceMarkdown === undefined
      ? getEditorStatistics(visualText(editor))
      : getEditorStatistics(markdownToPlainText(sourceMarkdown))
  ))

  useEffect(() => {
    if (sourceMarkdown === undefined) return

    let idleCallbackId: number | null = null
    const updateTimer = window.setTimeout(() => {
      const updateStatistics = () => {
        setStatistics(getEditorStatistics(markdownToPlainText(sourceMarkdown)))
      }

      if (typeof window.requestIdleCallback === 'function') {
        idleCallbackId = window.requestIdleCallback(updateStatistics, {
          timeout: SOURCE_STATISTICS_IDLE_TIMEOUT_MS,
        })
      } else {
        updateStatistics()
      }
    }, SOURCE_STATISTICS_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(updateTimer)
      if (idleCallbackId !== null) {
        window.cancelIdleCallback(idleCallbackId)
      }
    }
  }, [sourceMarkdown])

  useEffect(() => {
    if (sourceMarkdown !== undefined) return

    let updateTimer: ReturnType<typeof setTimeout> | null = null

    const updateCharacters = () => {
      if (updateTimer) {
        clearTimeout(updateTimer)
      }

      updateTimer = setTimeout(() => {
        updateTimer = null
        setStatistics(getEditorStatistics(visualText(editor)))
      }, 400)
    }

    setStatistics(getEditorStatistics(visualText(editor)))
    // 'create' never fires here (the editor exists before this
    // component mounts), so the async content load was only
    // caught when an 'update' happened to follow it. Listen to
    // 'transaction' as well: the load's setContent transaction
    // triggers the recount even without a user edit
    // (UTANG-UJI-08).
    editor.on('transaction', updateCharacters)
    editor.on('update', updateCharacters)

    return () => {
      if (updateTimer) {
        clearTimeout(updateTimer)
      }
      editor.off('transaction', updateCharacters)
      editor.off('update', updateCharacters)
    }
  }, [editor, sourceMarkdown])

  if (compact) {
    return <span className="flex items-center gap-1 text-xs"><Type className="size-3" />{t('characters', { count: statistics.characters })}</span>
  }

  return (
    <span className="flex items-center gap-1.5 text-xs">
      <Type className="size-3" />
      <span>{t('characters', { count: statistics.characters })}</span>
      <span aria-hidden="true">·</span>
      <span>{t('readingTime', { count: statistics.readingMinutes })}</span>
    </span>
  )
}
