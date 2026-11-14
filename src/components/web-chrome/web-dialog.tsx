// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import {
  ResponsiveDialog,
  ResponsiveDialogContent,
  ResponsiveDialogDescription,
  ResponsiveDialogFooter,
  ResponsiveDialogHeader,
  ResponsiveDialogTitle,
} from '@/components/responsive-dialog'
import { Button } from '@/components/ui/button'

/**
 * Centralized in-app dialog for the web shell.
 *
 * One provider and one host serve the whole core shell: any component
 * inside WebDialogProvider opens a dialog through useWebDialog instead of
 * mounting its own dialog state. The host renders the adaptive
 * ResponsiveDialog, so the same call shows a dialog on wide viewports and
 * a drawer on narrow viewports.
 *
 * Scope boundary: this module covers in-app dialogs only (notices,
 * confirmations, disabled-feature explanations). File picking, folder
 * picking, and save-file flows that replace OS dialogs belong to the
 * dialog adapter in src/lib/platform/ (separate owner); this host never
 * touches the filesystem and never imports Tauri APIs.
 */

export type WebDialogOptions = {
  title: string
  description?: string
  /** Optional extra body content rendered below the description. */
  content?: ReactNode
}

export type WebDialogApi = {
  openDialog: (options: WebDialogOptions) => void
  closeDialog: () => void
  isOpen: boolean
  /** Currently open dialog, or null. Read by WebDialogHost only. */
  current: WebDialogOptions | null
}

const WebDialogContext = createContext<WebDialogApi | null>(null)

export function WebDialogProvider({ children }: { children: ReactNode }) {
  const [dialog, setDialog] = useState<WebDialogOptions | null>(null)

  const openDialog = useCallback((options: WebDialogOptions) => {
    setDialog(options)
  }, [])

  const closeDialog = useCallback(() => {
    setDialog(null)
  }, [])

  const api = useMemo<WebDialogApi>(
    () => ({ openDialog, closeDialog, isOpen: dialog !== null, current: dialog }),
    [openDialog, closeDialog, dialog],
  )

  return <WebDialogContext.Provider value={api}>{children}</WebDialogContext.Provider>
}

export function useWebDialog(): WebDialogApi {
  const api = useContext(WebDialogContext)
  if (!api) {
    throw new Error('useWebDialog must be used within WebDialogProvider')
  }
  return api
}

/**
 * The single dialog host. Mount once inside WebDialogProvider, next to the
 * top app bar in the core layout. Renders nothing visible while closed.
 */
export function WebDialogHost() {
  const { current, closeDialog } = useWebDialog()
  const t = useTranslations()

  return (
    <ResponsiveDialog
      open={current !== null}
      onOpenChange={(next) => {
        if (!next) closeDialog()
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle>{current?.title ?? ''}</ResponsiveDialogTitle>
          {current?.description ? (
            <ResponsiveDialogDescription>{current.description}</ResponsiveDialogDescription>
          ) : null}
        </ResponsiveDialogHeader>
        {current?.content ?? null}
        <ResponsiveDialogFooter>
          <Button type="button" onClick={closeDialog}>
            {t('common.close')}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
