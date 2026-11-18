// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { Input } from '@/components/ui/input'
import { installHostDialogService } from '@/lib/platform/dialog/dialog-wiring'

/**
 * Centralized in-app dialog for the web shell.
 *
 * One provider and one host serve the whole core shell, and one
 * provider and one host serve the mobile shell: any component
 * inside WebDialogProvider opens a dialog through useWebDialog instead of
 * mounting its own dialog state. The host renders the adaptive
 * ResponsiveDialog, so the same call shows a dialog on wide viewports and
 * a drawer on narrow viewports.
 *
 * Two APIs share one queue. The legacy fire-and-forget `openDialog`
 * shows a notice with a single Close button. The promise-based
 * `confirmDialog`, `askDialog`, `messageDialog`, and `promptDialog`
 * resolve with the user's answer: confirm/ask resolve true only when
 * the user presses the confirm button (dismissal, Escape, and the
 * cancel button all resolve false), prompt resolves the entered text
 * or null on cancel/dismissal, and message resolves when the user
 * dismisses it. Requests queue FIFO; only the head renders, and each
 * answer settles exactly the request it was shown for, so a double
 * click can never answer the next queued dialog.
 *
 * The platform dialog adapter reaches this host through the glue in
 * WebDialogHost: on mount, the host installs a DialogService backed
 * by these promise methods as the module default read by the web
 * dialog adapter (see `src/lib/platform/dialog/dialog-wiring.ts`).
 * That closes the wiring gap that left confirm/ask/message/prompt
 * throwing on production wiring: the adapter delegates to the
 * installed service, and the service delegates here. No method in
 * this module falls back to `window.confirm`, `window.alert`, or
 * `window.prompt`.
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

/** Severity of a dialog. Only `error` changes rendering (red title). */
export type WebDialogKind = 'info' | 'warning' | 'error'

export type WebDialogConfirmOptions = {
  /** Dialog title. Defaults to the app name when omitted or blank. */
  title?: string
  kind?: WebDialogKind
  /** Label of the confirm button. Defaults to the common Confirm label. */
  okLabel?: string
  /** Label of the cancel button. Defaults to the common Cancel label. */
  cancelLabel?: string
}

export type WebDialogMessageOptions = {
  /** Dialog title. Defaults to the app name when omitted or blank. */
  title?: string
  kind?: WebDialogKind
  /** Label of the dismiss button. Defaults to the common Close label. */
  okLabel?: string
}

export type WebDialogPromptOptions = {
  /** Dialog title. Defaults to the app name when omitted or blank. */
  title?: string
  /** Initial value of the text input. */
  defaultValue?: string
  /** Placeholder text for the text input. */
  placeholder?: string
  /** Accessible label for the text input. */
  inputLabel?: string
  /** Label of the confirm button. Defaults to the common Confirm label. */
  okLabel?: string
  /** Label of the cancel button. Defaults to the common Cancel label. */
  cancelLabel?: string
}

/** The queued request the host is currently showing. Read by WebDialogHost only. */
export type WebDialogRequestView = {
  id: number
  kind: 'notice' | 'message' | 'confirm' | 'ask' | 'prompt'
  title: string
  description?: string
  content?: ReactNode
  dialogKind?: WebDialogKind
  okLabel?: string
  cancelLabel?: string
  defaultValue?: string
  placeholder?: string
  inputLabel?: string
}

export type WebDialogApi = {
  openDialog: (options: WebDialogOptions) => void
  closeDialog: () => void
  isOpen: boolean
  /** Currently open dialog, or null. Read by WebDialogHost only. */
  current: WebDialogOptions | null
  /** Currently shown queued request, or null. Read by WebDialogHost only. */
  request: WebDialogRequestView | null
  /** Show a confirm dialog. Resolves true only on the confirm button. */
  confirmDialog: (
    message: string,
    options?: string | WebDialogConfirmOptions,
  ) => Promise<boolean>
  /** Show a yes/no question dialog. Resolves true only on the confirm button. */
  askDialog: (
    message: string,
    options?: string | WebDialogConfirmOptions,
  ) => Promise<boolean>
  /** Show a message dialog. Resolves when the user dismisses it. */
  messageDialog: (
    message: string,
    options?: string | WebDialogMessageOptions,
  ) => Promise<void>
  /** Show a text prompt dialog. Resolves to the text, or null on cancel. */
  promptDialog: (
    message: string,
    options?: string | WebDialogPromptOptions,
  ) => Promise<string | null>
  /**
   * Resolve the shown request with an answer. The id guards against
   * stale clicks answering a later queued request. Host only.
   */
  answerCurrent: (id: number, value: boolean | string | null) => void
  /** Dismiss the shown request with its cancel value. Host only. */
  dismissCurrent: (id: number) => void
}

const WebDialogContext = createContext<WebDialogApi | null>(null)

/** Fallback dialog title when the caller supplies none (the app name). */
const DEFAULT_DIALOG_TITLE = 'NoteGen'

type DialogRequestValue = boolean | string | null | undefined

type DialogRequest = WebDialogRequestView & {
  resolve: (value: DialogRequestValue) => void
}

function resolveTitle(title: string | undefined): string {
  return title !== undefined && title.trim() !== '' ? title : DEFAULT_DIALOG_TITLE
}

function requestOptions(
  options: string | { title?: string } | undefined,
): { title?: string } {
  return typeof options === 'string' ? { title: options } : (options ?? {})
}

export function WebDialogProvider({ children }: { children: ReactNode }) {
  const queueRef = useRef<DialogRequest[]>([])
  const nextIdRef = useRef(1)
  const [version, setVersion] = useState(0)
  const bump = useCallback(() => {
    setVersion((current) => current + 1)
  }, [])

  const enqueue = useCallback(
    (request: Omit<DialogRequest, 'id'>): DialogRequest => {
      const full: DialogRequest = { ...request, id: nextIdRef.current }
      nextIdRef.current += 1
      queueRef.current = [...queueRef.current, full]
      bump()
      return full
    },
    [bump],
  )

  const settleRequest = useCallback(
    (id: number, value: DialogRequestValue): void => {
      const [head, ...rest] = queueRef.current
      if (!head || head.id !== id) {
        return
      }
      queueRef.current = rest
      bump()
      head.resolve(value)
    },
    [bump],
  )

  const dismissValueFor = (kind: DialogRequest['kind']): DialogRequestValue => {
    if (kind === 'confirm' || kind === 'ask') return false
    if (kind === 'prompt') return null
    return undefined
  }

  const dismissCurrent = useCallback(
    (id: number): void => {
      const head = queueRef.current[0]
      if (!head || head.id !== id) {
        return
      }
      settleRequest(id, dismissValueFor(head.kind))
    },
    [settleRequest],
  )

  const answerCurrent = useCallback(
    (id: number, value: boolean | string | null): void => {
      settleRequest(id, value)
    },
    [settleRequest],
  )

  const openDialog = useCallback(
    (options: WebDialogOptions) => {
      enqueue({
        kind: 'notice',
        title: options.title,
        description: options.description,
        content: options.content,
        resolve: () => undefined,
      })
    },
    [enqueue],
  )

  const closeDialog = useCallback(() => {
    const head = queueRef.current[0]
    if (head) {
      dismissCurrent(head.id)
    }
  }, [dismissCurrent])

  const confirmDialog = useCallback(
    (message: string, options?: string | WebDialogConfirmOptions): Promise<boolean> => {
      const opts = requestOptions(options) as WebDialogConfirmOptions
      return new Promise<boolean>((resolve) => {
        enqueue({
          kind: 'confirm',
          title: resolveTitle(opts.title),
          description: message,
          dialogKind: opts.kind,
          okLabel: opts.okLabel,
          cancelLabel: opts.cancelLabel,
          resolve: (value) => resolve(value === true),
        })
      })
    },
    [enqueue],
  )

  const askDialog = useCallback(
    (message: string, options?: string | WebDialogConfirmOptions): Promise<boolean> => {
      const opts = requestOptions(options) as WebDialogConfirmOptions
      return new Promise<boolean>((resolve) => {
        enqueue({
          kind: 'ask',
          title: resolveTitle(opts.title),
          description: message,
          dialogKind: opts.kind,
          okLabel: opts.okLabel,
          cancelLabel: opts.cancelLabel,
          resolve: (value) => resolve(value === true),
        })
      })
    },
    [enqueue],
  )

  const messageDialog = useCallback(
    (message: string, options?: string | WebDialogMessageOptions): Promise<void> => {
      const opts = requestOptions(options) as WebDialogMessageOptions
      return new Promise<void>((resolve) => {
        enqueue({
          kind: 'message',
          title: resolveTitle(opts.title),
          description: message,
          dialogKind: opts.kind,
          okLabel: opts.okLabel,
          resolve: () => resolve(),
        })
      })
    },
    [enqueue],
  )

  const promptDialog = useCallback(
    (message: string, options?: string | WebDialogPromptOptions): Promise<string | null> => {
      const opts = requestOptions(options) as WebDialogPromptOptions
      return new Promise<string | null>((resolve) => {
        enqueue({
          kind: 'prompt',
          title: resolveTitle(opts.title),
          description: message,
          okLabel: opts.okLabel,
          cancelLabel: opts.cancelLabel,
          defaultValue: opts.defaultValue,
          placeholder: opts.placeholder,
          inputLabel: opts.inputLabel,
          resolve: (value) => resolve(typeof value === 'string' ? value : null),
        })
      })
    },
    [enqueue],
  )

  const head = queueRef.current[0] ?? null
  const api = useMemo<WebDialogApi>(
    () => ({
      openDialog,
      closeDialog,
      isOpen: head !== null,
      current: head
        ? { title: head.title, description: head.description, content: head.content }
        : null,
      request: head
        ? {
            id: head.id,
            kind: head.kind,
            title: head.title,
            description: head.description,
            content: head.content,
            dialogKind: head.dialogKind,
            okLabel: head.okLabel,
            cancelLabel: head.cancelLabel,
            defaultValue: head.defaultValue,
            placeholder: head.placeholder,
            inputLabel: head.inputLabel,
          }
        : null,
      confirmDialog,
      askDialog,
      messageDialog,
      promptDialog,
      answerCurrent,
      dismissCurrent,
    }),
    [
      openDialog,
      closeDialog,
      head,
      confirmDialog,
      askDialog,
      messageDialog,
      promptDialog,
      answerCurrent,
      dismissCurrent,
      // The queue lives in a ref; the version bump is what re-renders
      // with the new head. Referencing it here keeps the memo fresh.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      version,
    ],
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
 * top app bar in the core layout and inside the mobile shell. Renders
 * nothing visible while closed.
 *
 * On mount, the host installs the platform DialogService backed by this
 * provider, so `platform.dialog.confirm/ask/message/prompt` resolve with
 * real user answers on production wiring. The install delegates through
 * a ref so it stays valid across re-renders.
 */
export function WebDialogHost() {
  const api = useWebDialog()
  const { request, answerCurrent, dismissCurrent } = api
  const t = useTranslations()
  // Prompt draft keyed by request id: a new queued prompt starts from
  // its defaultValue, and clearing the input to '' stays distinct
  // from never typing (the id match distinguishes the two).
  const [promptDraft, setPromptDraft] = useState<{ id: number; value: string } | null>(null)
  const promptValue =
    request && promptDraft?.id === request.id
      ? promptDraft.value
      : (request?.defaultValue ?? '')

  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(() => {
    installHostDialogService({
      confirmDialog: (message, options) =>
        apiRef.current.confirmDialog(message, options),
      askDialog: (message, options) =>
        apiRef.current.askDialog(message, options),
      messageDialog: (message, options) =>
        apiRef.current.messageDialog(message, options),
      promptDialog: (message, options) =>
        apiRef.current.promptDialog(message, options),
    })
  }, [])

  const submitPrompt = () => {
    if (!request) return
    answerCurrent(request.id, promptValue)
  }

  const isChoice = request?.kind === 'confirm' || request?.kind === 'ask'
  const isPrompt = request?.kind === 'prompt'

  return (
    <ResponsiveDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next && request) dismissCurrent(request.id)
      }}
    >
      <ResponsiveDialogContent>
        <ResponsiveDialogHeader>
          <ResponsiveDialogTitle
            className={request?.dialogKind === 'error' ? 'text-destructive' : undefined}
          >
            {request?.title ?? ''}
          </ResponsiveDialogTitle>
          {request?.description ? (
            <ResponsiveDialogDescription>{request.description}</ResponsiveDialogDescription>
          ) : null}
        </ResponsiveDialogHeader>
        {request?.content ?? null}
        {isPrompt && request ? (
          <Input
            key={request.id}
            type="text"
            value={promptValue}
            onChange={(event) => {
              setPromptDraft({ id: request.id, value: event.target.value })
            }}
            placeholder={request.placeholder}
            aria-label={request.inputLabel ?? request.title}
            autoFocus
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                answerCurrent(request.id, event.currentTarget.value)
              }
            }}
          />
        ) : null}
        <ResponsiveDialogFooter>
          {isChoice || isPrompt ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => request && dismissCurrent(request.id)}
            >
              {request?.cancelLabel ?? t('common.cancel')}
            </Button>
          ) : null}
          <Button
            type="button"
            onClick={() => {
              if (!request) return
              if (isPrompt) {
                submitPrompt()
              } else if (isChoice) {
                answerCurrent(request.id, true)
              } else {
                dismissCurrent(request.id)
              }
            }}
          >
            {isChoice || isPrompt
              ? (request?.okLabel ?? t('common.confirm'))
              : (request?.okLabel ?? t('common.close'))}
          </Button>
        </ResponsiveDialogFooter>
      </ResponsiveDialogContent>
    </ResponsiveDialog>
  )
}
