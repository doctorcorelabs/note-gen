'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  ResponsiveDialog as Dialog,
  ResponsiveDialogContent as DialogContent,
  ResponsiveDialogDescription as DialogDescription,
  ResponsiveDialogFooter as DialogFooter,
  ResponsiveDialogHeader as DialogHeader,
  ResponsiveDialogTitle as DialogTitle,
} from '@/components/responsive-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Spinner } from '@/components/ui/spinner'
import {
  DEFAULT_REVISION_CONFLICT_CHOICE,
  deriveCopyPath,
  type RevisionConflictChoice,
  type RevisionConflictInfo,
} from './revision-conflict'

interface RevisionConflictDialogProps {
  open: boolean
  conflict: RevisionConflictInfo
  busyChoice: RevisionConflictChoice | null
  error: string | null
  copyNameTaken: boolean
  onChoose: (choice: RevisionConflictChoice, copyPath?: string) => void
  onDismiss: () => void
}

function formatSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return '0 B'
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function formatModifiedAt(value: string, fallback: string): string {
  if (!value) return fallback
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

export function RevisionConflictDialog({
  open,
  conflict,
  busyChoice,
  error,
  copyNameTaken,
  onChoose,
  onDismiss,
}: RevisionConflictDialogProps) {
  const t = useTranslations('editor.revisionConflict')
  const [copyName, setCopyName] = useState(() =>
    deriveCopyPath(conflict.path, conflict.suggestedCopyPath),
  )

  useEffect(() => {
    setCopyName(deriveCopyPath(conflict.path, conflict.suggestedCopyPath))
  }, [conflict.path, conflict.suggestedCopyPath])

  const busy = busyChoice !== null
  const copyNameTrimmed = copyName.trim()
  const copyNameValid = copyNameTrimmed !== '' && copyNameTrimmed !== conflict.path

  const renderChoiceButton = (
    choice: RevisionConflictChoice,
    label: string,
    variant: 'default' | 'outline' | 'destructive',
    disabled: boolean,
    copyPath?: string,
  ) => (
    <Button
      type="button"
      variant={variant}
      disabled={busy || disabled}
      autoFocus={choice === DEFAULT_REVISION_CONFLICT_CHOICE}
      onClick={() => onChoose(choice, copyPath)}
      className="w-full justify-start"
    >
      {busyChoice === choice ? <Spinner className="size-4" /> : null}
      {busyChoice === choice ? t('working') : label}
    </Button>
  )

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description', { path: conflict.path })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-md border p-3">
            <p className="text-sm font-medium">{t('serverHeading')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('modifiedAt')}: {formatModifiedAt(conflict.serverModifiedAt, t('unknownDate'))}
              {' | '}
              {t('size')}: {formatSize(conflict.serverSize)}
            </p>
            {conflict.currentPreview ? (
              <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
                {conflict.currentPreview}
              </pre>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">{t('previewEmpty')}</p>
            )}
            {conflict.previewTruncated ? (
              <p className="mt-1 text-xs text-muted-foreground">{t('previewTruncated')}</p>
            ) : null}
          </div>

          <div className="space-y-1">
            {renderChoiceButton('reload', t('reloadChoice'), 'default', false)}
            <p className="text-xs text-muted-foreground">{t('reloadHint')}</p>
          </div>

          <div className="space-y-2">
            <label className="text-xs font-medium" htmlFor="revision-conflict-copy-name">
              {t('copyNameLabel')}
            </label>
            <Input
              id="revision-conflict-copy-name"
              value={copyName}
              disabled={busy}
              onChange={(event) => setCopyName(event.target.value)}
            />
            {copyNameTaken ? (
              <p className="text-xs text-destructive">{t('copyNameTaken')}</p>
            ) : null}
            {renderChoiceButton('save-copy', t('copyChoice'), 'outline', !copyNameValid, copyNameTrimmed)}
            <p className="text-xs text-muted-foreground">{t('copyHint')}</p>
          </div>

          <div className="space-y-1 rounded-md border border-destructive/30 p-3">
            {renderChoiceButton('force-overwrite', t('forceChoice'), 'destructive', false)}
            <p className="text-xs text-muted-foreground">{t('forceHint')}</p>
            <p className="text-xs font-medium text-destructive">{t('forceWarning')}</p>
          </div>

          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {t('errorLabel')} {error}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" disabled={busy} onClick={onDismiss}>
            {t('decideLater')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
