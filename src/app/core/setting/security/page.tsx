// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { SettingType } from '../components/setting-base'
import { useSettingsDialogStore } from '@/stores/settings-dialog'
import {
  classifySecurityError,
  createDefaultSecurityTransport,
  createSecuritySettingsApi,
  securityErrorMessageKey,
  type SecuritySettingsApi,
  type SecurityStatus,
  type StepUpProof,
} from '@/lib/web/security-settings'
import { SessionsSection } from './sessions-section'
import { StepUpDialog } from './step-up-dialog'
import { TotpSection } from './totp-section'

/**
 * Security settings page: TOTP enrollment/disable/recovery codes
 * plus the signed-in session list. The page owns the shared
 * security API client, the account status loaded from /me, and
 * the step-up handshake shared by every sensitive action.
 *
 * Step-up handshake (runSensitive): run the action first and let
 * the server decide. Only a 403 step_up_required opens the
 * step-up dialog; after a successful step-up the action is
 * retried exactly once. Cancelling the dialog reports null so
 * the caller leaves its state untouched, and a second
 * step_up_required is surfaced as an error instead of looping.
 *
 * Signed-out transition: revoking the current session or signing
 * out everywhere ends this session, so the page closes the
 * settings dialog and reloads. The reload re-runs the boot guard,
 * which probes /me and presents the sign-in action; the /login
 * page itself is owned by V3-03.
 */
export default function SecuritySettingsPage() {
  const t = useTranslations('settings.security')
  const errorT = useTranslations('settings.security.errors')
  const closeSettings = useSettingsDialogStore((state) => state.closeSettings)

  const apiRef = useRef<SecuritySettingsApi | null>(null)
  if (!apiRef.current) {
    apiRef.current = createSecuritySettingsApi(
      createDefaultSecurityTransport().transport,
    )
  }
  const api = apiRef.current

  const [status, setStatus] = useState<SecurityStatus | null>(null)
  const [statusLoading, setStatusLoading] = useState(true)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [stepUpOpen, setStepUpOpen] = useState(false)
  const [stepUpBusy, setStepUpBusy] = useState(false)
  const [stepUpError, setStepUpError] = useState<string | null>(null)
  const pendingStepUpRef = useRef<{ resolve: (ok: boolean) => void } | null>(null)

  function errorMessage(error: unknown): string {
    return errorT(securityErrorMessageKey(classifySecurityError(error)))
  }

  const loadStatus = useCallback(async () => {
    setStatusLoading(true)
    setStatusError(null)
    try {
      setStatus(await api.getSecurityStatus())
    } catch (error) {
      setStatusError(errorMessage(error))
    } finally {
      setStatusLoading(false)
    }
    // errorMessage is intentionally local-only; it must not re-run loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Never leave a runSensitive caller waiting when the page unmounts.
  useEffect(
    () => () => {
      pendingStepUpRef.current?.resolve(false)
      pendingStepUpRef.current = null
    },
    [],
  )

  const runSensitive = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T | null> => {
      try {
        return await action()
      } catch (error) {
        if (classifySecurityError(error) !== 'step_up_required') throw error
      }
      const confirmed = await new Promise<boolean>((resolve) => {
        pendingStepUpRef.current = { resolve }
        setStepUpError(null)
        setStepUpOpen(true)
      })
      if (!confirmed) return null
      return action()
    },
    [],
  )

  function handleStepUpCancel() {
    pendingStepUpRef.current?.resolve(false)
    pendingStepUpRef.current = null
    setStepUpOpen(false)
  }

  async function handleStepUpSubmit(password: string, proof?: StepUpProof) {
    setStepUpBusy(true)
    setStepUpError(null)
    try {
      await api.stepUp(password, proof)
      pendingStepUpRef.current?.resolve(true)
      pendingStepUpRef.current = null
      setStepUpOpen(false)
    } catch (error) {
      setStepUpError(errorMessage(error))
    } finally {
      setStepUpBusy(false)
    }
  }

  function handleSignedOut() {
    closeSettings()
    window.location.reload()
  }

  return (
    <SettingType
      id="security"
      title={t('title')}
      desc={t('desc')}
      icon={<ShieldCheck className="size-5" />}
    >
      {statusLoading && !status ? (
        <p className="text-sm text-muted-foreground">{t('loading')}</p>
      ) : null}

      {statusError && !status ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm text-destructive">{statusError}</p>
          <Button type="button" variant="outline" onClick={() => void loadStatus()}>
            {t('retry')}
          </Button>
        </div>
      ) : null}

      {status ? (
        <>
          <TotpSection
            api={api}
            totpEnabled={status.totpEnabled}
            runSensitive={runSensitive}
            onTotpChanged={loadStatus}
          />
          <SessionsSection
            api={api}
            runSensitive={runSensitive}
            onSignedOut={handleSignedOut}
          />
          <StepUpDialog
            open={stepUpOpen}
            totpEnabled={status.totpEnabled}
            busy={stepUpBusy}
            error={stepUpError}
            onCancel={handleStepUpCancel}
            onSubmit={(password, proof) => void handleStepUpSubmit(password, proof)}
          />
        </>
      ) : null}
    </SettingType>
  )
}
