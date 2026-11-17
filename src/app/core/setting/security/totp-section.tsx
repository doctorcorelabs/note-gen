// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useEffect, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Copy, Loader2, ShieldCheck } from 'lucide-react'
import { toast } from 'sonner'
import { platform } from '@/lib/platform'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { SettingSection } from '../components/setting-base'
import { useSettingsDialogStore } from '@/stores/settings-dialog'
import {
  classifySecurityError,
  createShowOnce,
  isRecoveryCodeInput,
  isTotpCode,
  securityErrorMessageKey,
  type RecoveryCodeSet,
  type SecuritySettingsApi,
  type TotpEnrollStart,
} from '@/lib/web/security-settings'

type TotpPhase = 'idle' | 'enrolling' | 'justEnrolled' | 'codes'

/**
 * TOTP section of the security settings page: enroll, disable, and
 * recovery code regeneration.
 *
 * Show-once guarantee: the staged secret and the recovery codes
 * live only in ShowOnce holders in memory. They are destroyed when
 * the user dismisses the panel, cancels the flow, leaves the
 * security section, or closes the settings dialog, and they are
 * never written to any storage API. The server offers no endpoint
 * that returns them again, so a dismissed set can never reappear.
 */
export function TotpSection({
  api,
  totpEnabled,
  runSensitive,
  onTotpChanged,
}: {
  api: SecuritySettingsApi
  totpEnabled: boolean
  runSensitive: <T>(action: () => Promise<T>) => Promise<T | null>
  onTotpChanged: () => Promise<void>
}) {
  const t = useTranslations('settings.security.totp')
  const errorT = useTranslations('settings.security.errors')
  const sectionActive = useSettingsDialogStore(
    (state) => state.open && state.activeSection === 'security',
  )

  const enrollHolder = useRef(createShowOnce<TotpEnrollStart>()).current
  const codesHolder = useRef(createShowOnce<RecoveryCodeSet>()).current
  const [, setRevealTick] = useState(0)
  const [phase, setPhase] = useState<TotpPhase>('idle')
  const [busy, setBusy] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [enrollCode, setEnrollCode] = useState('')
  const [disableOpen, setDisableOpen] = useState(false)
  const [disableBusy, setDisableBusy] = useState(false)
  const [disableError, setDisableError] = useState<string | null>(null)
  const [proofKind, setProofKind] = useState<'code' | 'recoveryCode'>('code')
  const [disableCode, setDisableCode] = useState('')
  const [disableRecovery, setDisableRecovery] = useState('')
  const [regenerateOpen, setRegenerateOpen] = useState(false)
  const [regenerateBusy, setRegenerateBusy] = useState(false)
  const [regenerateError, setRegenerateError] = useState<string | null>(null)
  const [regenerateCode, setRegenerateCode] = useState('')

  const enrollPayload = enrollHolder.peek()
  const codesPayload = codesHolder.peek()

  function clearSecrets() {
    enrollHolder.dismiss()
    codesHolder.dismiss()
    setRevealTick((tick) => tick + 1)
  }

  function resetFlow() {
    clearSecrets()
    setPhase('idle')
    setPanelError(null)
    setEnrollCode('')
    setDisableCode('')
    setDisableRecovery('')
    setRegenerateCode('')
  }

  // The settings dialog keeps mounted sections alive when the user
  // switches sections, so unmount alone cannot be trusted to clear
  // secrets. Clear them the moment this section stops being active.
  useEffect(() => {
    if (!sectionActive) {
      resetFlow()
      setDisableOpen(false)
      setRegenerateOpen(false)
    }
    // resetFlow is intentionally local-only; it must not re-run.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionActive])

  useEffect(() => resetFlow, [])

  function errorMessage(error: unknown): string {
    return errorT(securityErrorMessageKey(classifySecurityError(error)))
  }

  async function copyText(value: string) {
    try {
      await platform.clipboard.writeText(value)
      toast.success(t('copied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  async function handleStartEnroll() {
    setBusy(true)
    setPanelError(null)
    try {
      const started = await runSensitive(() => api.startTotpEnroll())
      if (started === null) return
      enrollHolder.set(started)
      setRevealTick((tick) => tick + 1)
      setPhase('enrolling')
    } catch (error) {
      setPanelError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleConfirmEnroll() {
    if (!isTotpCode(enrollCode)) return
    setBusy(true)
    setPanelError(null)
    try {
      const confirmed = await runSensitive(() =>
        api.confirmTotpEnroll(enrollCode),
      )
      if (confirmed === null) return
      clearSecrets()
      setEnrollCode('')
      setPhase('justEnrolled')
      toast.success(t('enrollSuccess'))
      await onTotpChanged()
    } catch (error) {
      setPanelError(errorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function handleDisable() {
    const proof =
      proofKind === 'code'
        ? { kind: 'code' as const, code: disableCode }
        : { kind: 'recoveryCode' as const, recoveryCode: disableRecovery }
    setDisableBusy(true)
    setDisableError(null)
    try {
      const disabled = await runSensitive(() => api.disableTotp(proof))
      if (disabled === null) return
      setDisableOpen(false)
      setDisableCode('')
      setDisableRecovery('')
      toast.success(t('disabledSuccess'))
      await onTotpChanged()
    } catch (error) {
      setDisableError(errorMessage(error))
    } finally {
      setDisableBusy(false)
    }
  }

  async function handleRegenerate() {
    if (!isTotpCode(regenerateCode)) return
    setRegenerateBusy(true)
    setRegenerateError(null)
    try {
      const set = await runSensitive(() =>
        api.regenerateRecoveryCodes(regenerateCode),
      )
      if (set === null) return
      codesHolder.set(set)
      setRevealTick((tick) => tick + 1)
      setRegenerateCode('')
      setRegenerateOpen(false)
      setPhase('codes')
    } catch (error) {
      setRegenerateError(errorMessage(error))
    } finally {
      setRegenerateBusy(false)
    }
  }

  const disableProofValid =
    proofKind === 'code'
      ? isTotpCode(disableCode)
      : isRecoveryCodeInput(disableRecovery)

  return (
    <SettingSection title={t('title')} desc={t('desc')}>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <ShieldCheck className="size-5 text-muted-foreground" />
            <Badge variant={totpEnabled ? 'default' : 'secondary'}>
              {totpEnabled ? t('enabled') : t('disabled')}
            </Badge>
            <div className="ml-auto flex flex-wrap gap-2">
              {totpEnabled ? (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || phase !== 'idle'}
                    onClick={() => {
                      setRegenerateError(null)
                      setRegenerateOpen(true)
                    }}
                  >
                    {t('regenerate')}
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    disabled={busy || phase !== 'idle'}
                    onClick={() => {
                      setDisableError(null)
                      setDisableOpen(true)
                    }}
                  >
                    {t('disable')}
                  </Button>
                </>
              ) : (
                <Button
                  type="button"
                  disabled={busy || phase !== 'idle'}
                  onClick={handleStartEnroll}
                >
                  {busy && phase === 'idle' ? (
                    <Loader2 className="animate-spin" />
                  ) : null}
                  {t('setup')}
                </Button>
              )}
            </div>
          </div>

          {!totpEnabled && phase === 'idle' ? (
            <p className="text-sm text-muted-foreground">{t('setupDesc')}</p>
          ) : null}
          {totpEnabled && phase === 'idle' ? (
            <p className="text-sm text-muted-foreground">{t('regenerateDesc')}</p>
          ) : null}

          {panelError ? (
            <p role="alert" className="text-sm text-destructive">{panelError}</p>
          ) : null}

          {phase === 'enrolling' && enrollPayload ? (
            <div className="flex flex-col gap-4 border-t pt-4">
              <div className="flex flex-col gap-1">
                <h4 className="font-medium">{t('secretTitle')}</h4>
                <p className="text-sm text-muted-foreground">{t('secretHelp')}</p>
              </div>
              <div className="flex flex-col gap-2">
                <Label>{t('secretLabel')}</Label>
                <div className="flex items-center gap-2">
                  <code className="flex-1 break-all rounded-md bg-muted px-3 py-2 font-mono text-sm">
                    {enrollPayload.secret}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => copyText(enrollPayload.secret)}
                  >
                    <Copy />
                    {t('copy')}
                  </Button>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <Label>{t('otpauthLabel')}</Label>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
                    {enrollPayload.otpauthUrl}
                  </code>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => copyText(enrollPayload.otpauthUrl)}
                  >
                    <Copy />
                    {t('copy')}
                  </Button>
                </div>
              </div>
              <form
                className="flex flex-col gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  void handleConfirmEnroll()
                }}
              >
                <Label htmlFor="security-enroll-code">{t('codeLabel')}</Label>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="security-enroll-code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    className="w-40"
                    disabled={busy}
                    value={enrollCode}
                    placeholder={t('codePlaceholder')}
                    onChange={(event) =>
                      setEnrollCode(
                        event.target.value.replace(/\D/g, '').slice(0, 6),
                      )
                    }
                  />
                  <Button
                    type="submit"
                    disabled={busy || !isTotpCode(enrollCode)}
                  >
                    {busy ? <Loader2 className="animate-spin" /> : null}
                    {t('confirmEnroll')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={resetFlow}
                  >
                    {t('cancelEnroll')}
                  </Button>
                </div>
              </form>
            </div>
          ) : null}

          {phase === 'justEnrolled' ? (
            <div className="flex flex-col gap-3 border-t pt-4">
              <p className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="size-4 text-emerald-600" />
                {t('enrollSuccess')}
              </p>
              <p className="text-sm text-muted-foreground">{t('afterEnroll')}</p>
              <div>
                <Button
                  type="button"
                  onClick={() => {
                    setRegenerateError(null)
                    setRegenerateOpen(true)
                  }}
                >
                  {t('generateCodes')}
                </Button>
              </div>
            </div>
          ) : null}

          {phase === 'codes' && codesPayload ? (
            <div className="flex flex-col gap-3 border-t pt-4">
              <div className="flex flex-col gap-1">
                <h4 className="font-medium">{t('codesTitle')}</h4>
                <p className="text-sm text-muted-foreground">{t('codesWarning')}</p>
              </div>
              <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {codesPayload.codes.map((code) => (
                  <code
                    key={code}
                    className="rounded-md bg-muted px-3 py-2 font-mono text-sm"
                  >
                    {code}
                  </code>
                ))}
              </div>
              <p className="text-sm text-muted-foreground">{t('acknowledgeHint')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyText(codesPayload.codes.join('\n'))}
                >
                  <Copy />
                  {t('copyAll')}
                </Button>
                <Button type="button" onClick={resetFlow}>
                  {t('acknowledge')}
                </Button>
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Dialog
        open={disableOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !disableBusy) setDisableOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('disableTitle')}</DialogTitle>
            <DialogDescription>{t('disableDesc')}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (disableProofValid && !disableBusy) void handleDisable()
            }}
          >
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
                <Label htmlFor="security-disable-code">{t('codeLabel')}</Label>
                <Input
                  id="security-disable-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  disabled={disableBusy}
                  value={disableCode}
                  placeholder={t('codePlaceholder')}
                  onChange={(event) =>
                    setDisableCode(
                      event.target.value.replace(/\D/g, '').slice(0, 6),
                    )
                  }
                />
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                <Label htmlFor="security-disable-recovery">{t('recoveryCodeLabel')}</Label>
                <Input
                  id="security-disable-recovery"
                  autoComplete="off"
                  disabled={disableBusy}
                  value={disableRecovery}
                  placeholder={t('recoveryCodePlaceholder')}
                  onChange={(event) => setDisableRecovery(event.target.value)}
                />
              </div>
            )}
            {disableError ? (
              <p role="alert" className="text-sm text-destructive">{disableError}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={disableBusy}
                onClick={() => setDisableOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={!disableProofValid || disableBusy}
              >
                {disableBusy ? <Loader2 className="animate-spin" /> : null}
                {t('disableConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={regenerateOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !regenerateBusy) setRegenerateOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('regenerateTitle')}</DialogTitle>
            <DialogDescription>{t('regenerateDialogDesc')}</DialogDescription>
          </DialogHeader>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              if (isTotpCode(regenerateCode) && !regenerateBusy) {
                void handleRegenerate()
              }
            }}
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor="security-regenerate-code">{t('codeLabel')}</Label>
              <Input
                id="security-regenerate-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                autoFocus
                disabled={regenerateBusy}
                value={regenerateCode}
                placeholder={t('codePlaceholder')}
                onChange={(event) =>
                  setRegenerateCode(
                    event.target.value.replace(/\D/g, '').slice(0, 6),
                  )
                }
              />
            </div>
            {regenerateError ? (
              <p role="alert" className="text-sm text-destructive">{regenerateError}</p>
            ) : null}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                disabled={regenerateBusy}
                onClick={() => setRegenerateOpen(false)}
              >
                {t('cancel')}
              </Button>
              <Button
                type="submit"
                disabled={!isTotpCode(regenerateCode) || regenerateBusy}
              >
                {regenerateBusy ? <Loader2 className="animate-spin" /> : null}
                {t('regenerateConfirm')}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </SettingSection>
  )
}
