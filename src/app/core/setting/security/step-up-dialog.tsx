// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  isRecoveryCodeInput,
  isTotpCode,
  type StepUpProof,
} from '@/lib/web/security-settings'

/**
 * Step-up dialog: re-enter the password (plus exactly one second
 * factor when TOTP is enabled: the current TOTP code or one unused
 * recovery code) to unlock one sensitive action. The password and
 * the second factor live only in this dialog's state and are
 * cleared whenever the dialog closes. The proof choice mirrors
 * the disable dialog in totp-section.tsx: one input is shown at
 * a time and only the selected proof is submitted, so the wire
 * body never carries both factors.
 */
export function StepUpDialog({
  open,
  totpEnabled,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  open: boolean
  totpEnabled: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (password: string, proof?: StepUpProof) => void
}) {
  const t = useTranslations('settings.security.stepUp')
  const [password, setPassword] = useState('')
  const [proofKind, setProofKind] = useState<'code' | 'recoveryCode'>('code')
  const [code, setCode] = useState('')
  const [recoveryCode, setRecoveryCode] = useState('')

  useEffect(() => {
    if (!open) {
      setPassword('')
      setProofKind('code')
      setCode('')
      setRecoveryCode('')
    }
  }, [open ])

  const proofValid =
    proofKind === 'code'
      ? isTotpCode(code)
      : isRecoveryCodeInput(recoveryCode)
  const canSubmit =
    password.length > 0 && (!totpEnabled || proofValid)

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('desc')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit || busy) return
            const proof: StepUpProof | undefined = !totpEnabled
              ? undefined
              : proofKind === 'code'
                ? { kind: 'code', code: code.trim() }
                : { kind: 'recoveryCode', recoveryCode: recoveryCode.trim() }
            onSubmit(password, proof)
          }}
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="security-step-up-password">{t('passwordLabel')}</Label>
            <Input
              id="security-step-up-password"
              type="password"
              autoComplete="current-password"
              autoFocus
              disabled={busy}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {totpEnabled ? (
            <>
              <div className="flex flex-col gap-2">
                <Label>{t('proofChoice')}</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant={proofKind === 'code' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setProofKind('code')}
                  >
                    {t('proofCode')}
                  </Button>
                  <Button
                    type="button"
                    variant={proofKind === 'recoveryCode' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setProofKind('recoveryCode')}
                  >
                    {t('proofRecovery')}
                  </Button>
                </div>
              </div>
              {proofKind === 'code' ? (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="security-step-up-code">{t('codeLabel')}</Label>
                  <Input
                    id="security-step-up-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    disabled={busy}
                    value={code}
                    placeholder="123456"
                    onChange={(event) =>
                      setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    }
                  />
                  <p className="text-sm text-muted-foreground">{t('codeHelp')}</p>
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  <Label htmlFor="security-step-up-recovery">{t('recoveryCodeLabel')}</Label>
                  <Input
                    id="security-step-up-recovery"
                    autoComplete="off"
                    disabled={busy}
                    value={recoveryCode}
                    placeholder={t('recoveryCodePlaceholder')}
                    onChange={(event) => setRecoveryCode(event.target.value)}
                  />
                  <p className="text-sm text-muted-foreground">{t('recoveryCodeHelp')}</p>
                </div>
              )}
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-sm text-destructive">{error}</p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={!canSubmit || busy}>
              {busy ? <Loader2 className="animate-spin" /> : null}
              {t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
