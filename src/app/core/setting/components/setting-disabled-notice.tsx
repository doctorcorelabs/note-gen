// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useEffect, useState, type ComponentType, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import {
  platform,
  type PersistenceState,
  type StoreHandleWebExtensions,
} from '@/lib/platform'
import { SettingType } from './setting-base'

/**
 * Settings sections that exist in the navigation but are not usable in the
 * web MVP, following the verified V2-27 catalogue
 * (fase1/inventaris-pengaturan.md). A gated section renders only this
 * notice: no control and no credential field from the upstream page is
 * mounted, so nothing in it can look like a working write field. The
 * upstream pages stay in the tree for later phases.
 *
 * Copy lives in the message catalogue under the coordinator-approved
 * namespaces `settings.disabled.*` and `settings.persistence.*`
 * (Q8 decision; claim file `fase1/claims/3d-29a.json`). The zh values
 * for these new strings are interim, identical to en, and recorded as
 * translation debt; no zh wording is invented (rule D-7 verbatim).
 */
export type GatedSettingSection =
  | 'canvas'
  | 'sync'
  | 'backup'
  | 'imageHosting'
  | 'ai'
  | 'webSearch'
  | 'rag'
  | 'mcp'
  | 'skills'
  | 'plugins'
  | 'prompt'
  | 'memories'
  | 'template'
  | 'imageMethod'
  | 'audio'

export function DisabledSettingSection({ section }: { section: GatedSettingSection }) {
  const t = useTranslations('settings')
  const title = section === 'ai' ? t('ai.menuTitle') : t(`${section}.title`)

  return (
    <SettingType id={section} title={title}>
      <div data-disabled-setting-section={section}>
        <Alert>
          <Info />
          <AlertDescription>{t(`disabled.${section}`)}</AlertDescription>
        </Alert>
      </div>
    </SettingType>
  )
}

function makeGatedPage(section: GatedSettingSection): ComponentType {
  function GatedPage() {
    return <DisabledSettingSection section={section} />
  }
  GatedPage.displayName = `Gated${section}SettingPage`
  return GatedPage
}

export const gatedSettingPages: Record<GatedSettingSection, ComponentType> = {
  canvas: makeGatedPage('canvas'),
  sync: makeGatedPage('sync'),
  backup: makeGatedPage('backup'),
  imageHosting: makeGatedPage('imageHosting'),
  ai: makeGatedPage('ai'),
  webSearch: makeGatedPage('webSearch'),
  rag: makeGatedPage('rag'),
  mcp: makeGatedPage('mcp'),
  skills: makeGatedPage('skills'),
  plugins: makeGatedPage('plugins'),
  prompt: makeGatedPage('prompt'),
  memories: makeGatedPage('memories'),
  template: makeGatedPage('template'),
  imageMethod: makeGatedPage('imageMethod'),
  audio: makeGatedPage('audio'),
}

/** Short disabled notice used inside partially active sections. */
export function DisabledFeatureNote({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <Alert>
      <Info />
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  )
}

/**
 * Honest persistence status for the settings frame. It subscribes to the
 * web StoreAdapter handle through the web-only persistence extension,
 * reached only after a capability check, so the Tauri handle (which has
 * no such extension) renders nothing. The initial state is seeded from
 * the pending counts, which stay non-zero until the server confirms a
 * flush, and later updates come from the adapter itself. Nothing is
 * rendered until the handle resolves, so no status is claimed before
 * the adapter is known. "All changes saved" means this handle has no
 * unconfirmed write, not that every device holds the newest copy.
 */
export function SettingsPersistenceStatus() {
  const t = useTranslations('settings.persistence')
  const [state, setState] = useState<PersistenceState | null>(null)

  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void platform.store.load('store.json')
      .then((handle) => {
        if (disposed) return
        const extensions = handle as unknown as Partial<StoreHandleWebExtensions>
        if (typeof extensions.onPersistenceChange !== 'function') return
        const pendingKeys = typeof extensions.pendingCount === 'function'
          ? extensions.pendingCount()
          : 0
        const error = typeof extensions.lastFlushError === 'function'
          ? extensions.lastFlushError()
          : null
        if (error !== null && pendingKeys > 0) {
          setState({ status: 'error', pendingKeys, error })
        } else if (pendingKeys > 0) {
          setState({ status: 'dirty', pendingKeys })
        } else {
          setState({ status: 'clean' })
        }
        unlisten = extensions.onPersistenceChange((next) => {
          if (!disposed) setState(next)
        })
      })
      .catch(() => {
        // No status claim when the store handle is unavailable.
      })

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  if (state === null) return null

  const text = state.status === 'clean'
    ? t('saved')
    : state.status === 'error'
      ? t('failed')
      : t('saving')

  return (
    <p
      role="status"
      aria-live="polite"
      data-persistence-status={state.status}
      className="relative z-20 shrink-0 border-t bg-sidebar px-3 py-2 text-xs text-muted-foreground"
    >
      {text}
    </p>
  )
}
