// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useCallback, type ReactNode } from 'react'
import { CircleSlash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getFeatureFlag, type WebFeatureId } from './feature-flags'
import { useFeatureFlag } from './use-feature-flag'
import { useFeatureText, useWebChromeText } from './web-chrome-messages'
import { useWebDialog } from './web-dialog'

/**
 * Explicit disabled state for features outside the Phase 1 scope.
 *
 * Every surface that names a disabled feature must render through this
 * module: a panel that replaces the feature UI, an inline notice, or a
 * button that explains itself on click. A disabled feature never renders
 * a control that looks working, never spins, and never fails silently.
 * When a flag is later enabled, DisabledFeature renders nothing, so stale
 * disabled states cannot survive a flag flip.
 */

export function useDisabledFeatureDialog() {
  const { openDialog } = useWebDialog()
  const resolveText = useWebChromeText()

  const showDisabledFeature = useCallback(
    (featureId: WebFeatureId) => {
      const flag = getFeatureFlag(featureId)
      openDialog({
        title: resolveText(flag.labelKey, flag.fallbackLabel),
        description: resolveText(flag.messageKey, flag.fallbackMessage),
      })
    },
    [openDialog, resolveText],
  )

  return { showDisabledFeature }
}

export type DisabledFeatureProps = {
  feature: WebFeatureId
  variant?: 'panel' | 'inline'
  title?: string
  message?: string
  className?: string
}

export function DisabledFeature({
  feature,
  variant = 'panel',
  title,
  message,
  className,
}: DisabledFeatureProps) {
  const { enabled, flag } = useFeatureFlag(feature)
  const text = useFeatureText(feature)

  if (enabled) return null

  const heading = title ?? text.label
  const body = message ?? text.message
  const phaseNote = flag.targetPhase === 'None' ? null : `Planned for ${flag.targetPhase}.`

  if (variant === 'inline') {
    return (
      <div
        role="status"
        data-web-feature={feature}
        data-web-feature-state="disabled"
        className={cn('flex items-start gap-2 text-sm text-muted-foreground', className)}
      >
        <CircleSlash className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <span className="font-medium text-foreground">{heading}</span>{' '}
          <span>{body}</span>
        </p>
      </div>
    )
  }

  return (
    <Empty
      data-web-feature={feature}
      data-web-feature-state="disabled"
      className={className}
    >
      <EmptyHeader>
        <CircleSlash className="size-8 text-muted-foreground" aria-hidden="true" />
        <EmptyTitle>{heading}</EmptyTitle>
        <EmptyDescription>{body}</EmptyDescription>
      </EmptyHeader>
      {phaseNote ? (
        <EmptyContent>
          <p className="text-sm text-muted-foreground">{phaseNote}</p>
        </EmptyContent>
      ) : null}
    </Empty>
  )
}

export type DisabledFeatureButtonProps = {
  feature: WebFeatureId
  /** Icon rendered inside the button. */
  icon: ReactNode
  /** Accessible label. Defaults to the feature label. */
  label?: string
  className?: string
}

/**
 * Toolbar-style button for a disabled feature.
 *
 * The button stays focusable and clickable: activating it opens the
 * centralized dialog with the full explanation. It carries
 * aria-disabled and a dimmed style so it never reads as a working
 * action, and its tooltip states the disabled fact up front.
 */
export function DisabledFeatureButton({ feature, icon, label, className }: DisabledFeatureButtonProps) {
  const text = useFeatureText(feature)
  const { showDisabledFeature } = useDisabledFeatureDialog()
  const buttonLabel = label ?? text.label

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          type="button"
          aria-disabled="true"
          aria-label={buttonLabel}
          className={cn('size-8 opacity-50', className)}
          onClick={() => showDisabledFeature(feature)}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>{`${buttonLabel} is not available in this build.`}</p>
      </TooltipContent>
    </Tooltip>
  )
}
