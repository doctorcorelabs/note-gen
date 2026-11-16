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
import { isTotpCode } from '@/lib/web/security-settings'

/**
 * Step-up dialog: re-enter the password (plus the current TOTP
 * code when TOTP is enabled) to unlock one sensitive action. The
 * password and code live only in this dialog's state and are
 * cleared whenever the dialog closes.
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
  onSubmit: (password: string, code?: string) => void
}) {
  const t = useTranslations('settings.security.stepUp')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')

  useEffect(() => {
    if (!open) {
      setPassword('')
      setCode('')
    }
  }, [open ])

  const canSubmit =
    password.length > 0 && (!totpEnabled || isTotpCode(code))

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
            onSubmit(password, totpEnabled ? code.trim() : undefined)
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
