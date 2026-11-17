// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useTranslations } from 'next-intl'
import {
  EDITOR_DISABLED_CATALOG_NAMESPACE,
  editorDisabledMessageKeys,
  type SurfacedEditorDisabledFeature,
} from '@/lib/editor-disabled'
import { cn } from '@/lib/utils'

export interface EditorDisabledNoticeProps {
  feature: SurfacedEditorDisabledFeature
  /** inline: one line in a toolbar or menu area. card: bordered box in a tab. page: full route page. */
  variant?: 'inline' | 'card' | 'page'
  className?: string
}

/**
 * Honest disabled marker for an editor surface (Fase 1, V3-24,
 * AD-20). Copy comes from the editor.disabled.* catalog keys, so
 * the marker text is identical everywhere the feature is gated.
 * Render this instead of hiding a gated surface; never render an
 * empty box, a spinner, or a clickable control that does nothing.
 */
export function EditorDisabledNotice({ feature, variant = 'card', className }: EditorDisabledNoticeProps) {
  const t = useTranslations(EDITOR_DISABLED_CATALOG_NAMESPACE)
  const { titleKey, messageKey } = editorDisabledMessageKeys(feature)
  const badge = t('badge')
  const title = t(titleKey)
  const message = t(messageKey)

  if (variant === 'inline') {
    return (
      <p
        role="status"
        data-testid="editor-disabled-notice"
        data-disabled-feature={feature}
        className={cn('text-xs text-muted-foreground', className)}
      >
        <span className="font-medium text-foreground">{title}</span>
        {' '}
        {message}
      </p>
    )
  }

  const body = (
    <div
      role="status"
      data-testid="editor-disabled-notice"
      data-disabled-feature={feature}
      className={cn(
        'flex flex-col gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm',
        className,
      )}
    >
      <span className="w-fit rounded-full border border-border bg-background px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {badge}
      </span>
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground">{message}</p>
    </div>
  )

  if (variant === 'page') {
    return (
      <main className="flex min-h-screen items-center justify-center p-8">
        <div className="w-full max-w-md">{body}</div>
      </main>
    )
  }

  return body
}

export default EditorDisabledNotice
