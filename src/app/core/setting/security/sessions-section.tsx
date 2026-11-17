// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
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
import { SettingSection } from '../components/setting-base'
import {
  classifySecurityError,
  securityErrorMessageKey,
  type AuthSessionEntry,
  type SecuritySettingsApi,
} from '@/lib/web/security-settings'

/**
 * Sessions section of the security settings page: list the
 * account's signed-in sessions, revoke one session, and sign out
 * everywhere. Revoking one session needs no step-up (kontrak
 * 3.12); signing out everywhere is a sensitive action and goes
 * through runSensitive, which asks for step-up when the server
 * requires it. Revoking the current session, or signing out
 * everywhere, ends this session, so the page reports it through
 * onSignedOut instead of trying to refresh a dead session.
 *
 * No session id, hash, or token is ever rendered: rows show only
 * the device label, user agent summary, IP, and timestamps the
 * server returns for display.
 */
export function SessionsSection({
  api,
  runSensitive,
  onSignedOut,
}: {
  api: SecuritySettingsApi
  runSensitive: <T>(action: () => Promise<T>) => Promise<T | null>
  onSignedOut: () => void
}) {
  const t = useTranslations('settings.security.sessions')
  const pageT = useTranslations('settings.security')
  const errorT = useTranslations('settings.security.errors')
  const locale = useLocale()

  const [sessions, setSessions] = useState<AuthSessionEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [panelError, setPanelError] = useState<string | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<AuthSessionEntry | null>(null)
  const [revokeBusy, setRevokeBusy] = useState(false)
  const [revokeError, setRevokeError] = useState<string | null>(null)
  const [logoutAllOpen, setLogoutAllOpen] = useState(false)
  const [logoutAllBusy, setLogoutAllBusy] = useState(false)
  const [logoutAllError, setLogoutAllError] = useState<string | null>(null)

  function errorMessage(error: unknown): string {
    return errorT(securityErrorMessageKey(classifySecurityError(error)))
  }

  function formatDate(value: string): string {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return value
    return date.toLocaleString(locale)
  }

  const loadSessions = useCallback(
    async (mode: 'initial' | 'refresh' | 'silent') => {
      if (mode === 'initial') setLoading(true)
      if (mode === 'refresh') setRefreshing(true)
      if (mode !== 'silent') setPanelError(null)
      try {
        setSessions(await api.listSessions())
      } catch (error) {
        if (mode !== 'silent') setPanelError(errorMessage(error))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    // errorMessage is intentionally local-only; it must not re-run loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
  )

  useEffect(() => {
    void loadSessions('initial')
  }, [loadSessions])

  async function handleRevoke() {
    if (!revokeTarget) return
    const target = revokeTarget
    setRevokeBusy(true)
    setRevokeError(null)
    try {
      await api.revokeSession(target.id)
      if (target.isCurrent) {
        onSignedOut()
        return
      }
      setRevokeTarget(null)
      toast.success(t('revoked'))
      await loadSessions('silent')
    } catch (error) {
      if (classifySecurityError(error) === 'not_found') {
        await loadSessions('silent')
      }
      setRevokeError(errorMessage(error))
    } finally {
      setRevokeBusy(false)
    }
  }

  async function handleLogoutAll() {
    setLogoutAllBusy(true)
    setLogoutAllError(null)
    try {
      const done = await runSensitive(() => api.logoutAll())
      if (done === null) return
      onSignedOut()
    } catch (error) {
      setLogoutAllError(errorMessage(error))
    } finally {
      setLogoutAllBusy(false)
    }
  }

  const onlyCurrentSession =
    sessions.length > 0 && sessions.every((session) => session.isCurrent)

  return (
    <SettingSection
      title={t('title')}
      desc={t('desc')}
      actions={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || refreshing}
          onClick={() => void loadSessions('refresh')}
        >
          {refreshing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {pageT('refresh')}
        </Button>
      }
    >
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          {loading ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="animate-spin" />
              {pageT('loading')}
            </p>
          ) : null}

          {panelError ? (
            <p role="alert" className="text-sm text-destructive">{panelError}</p>
          ) : null}

          {!loading && sessions.length === 0 && !panelError ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : null}

          {!loading && sessions.length > 0 ? (
            <ul className="flex flex-col gap-3">
              {sessions.map((session) => (
                <li
                  key={session.id}
                  className="flex flex-wrap items-start gap-3 border-b pb-3 last:border-b-0 last:pb-0"
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="flex flex-wrap items-center gap-2 font-medium">
                      <span className="truncate">{session.deviceLabel}</span>
                      {session.isCurrent ? (
                        <Badge variant="default">{t('current')}</Badge>
                      ) : null}
                    </p>
                    {session.userAgent ? (
                      <p className="truncate text-sm text-muted-foreground">
                        {session.userAgent}
                      </p>
                    ) : null}
                    <p className="text-sm text-muted-foreground">
                      {t('lastSeen')}: {formatDate(session.lastSeenAt)}
                      {' · '}
                      {t('created')}: {formatDate(session.createdAt)}
                      {' · '}
                      {t('expires')}: {formatDate(session.absoluteExpiresAt)}
                    </p>
                    <p className="text-sm text-muted-foreground">
                      {t('ipLabel')}: {session.lastSeenIp ?? session.createdIp ?? t('unknownIp')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setRevokeError(null)
                      setRevokeTarget(session)
                    }}
                  >
                    {t('revoke')}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}

          {!loading && onlyCurrentSession ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : null}

          <div className="flex flex-wrap items-center gap-3 border-t pt-4">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">
              {t('logoutAllDesc')}
            </p>
            <Button
              type="button"
              variant="destructive"
              disabled={loading}
              onClick={() => {
                setLogoutAllError(null)
                setLogoutAllOpen(true)
              }}
            >
              {t('logoutAll')}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Dialog
        open={revokeTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !revokeBusy) setRevokeTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('revokeTitle')}</DialogTitle>
            <DialogDescription>
              {revokeTarget?.isCurrent ? t('revokeCurrentDesc') : t('revokeDesc')}
            </DialogDescription>
          </DialogHeader>
          {revokeTarget ? (
            <p className="truncate text-sm font-medium">
              {revokeTarget.deviceLabel}
            </p>
          ) : null}
          {revokeError ? (
            <p role="alert" className="text-sm text-destructive">{revokeError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={revokeBusy}
              onClick={() => setRevokeTarget(null)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={revokeBusy}
              onClick={() => void handleRevoke()}
            >
              {revokeBusy ? <Loader2 className="animate-spin" /> : null}
              {t('revokeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={logoutAllOpen}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !logoutAllBusy) setLogoutAllOpen(false)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('logoutAllTitle')}</DialogTitle>
            <DialogDescription>{t('logoutAllDialogDesc')}</DialogDescription>
          </DialogHeader>
          {logoutAllError ? (
            <p role="alert" className="text-sm text-destructive">{logoutAllError}</p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={logoutAllBusy}
              onClick={() => setLogoutAllOpen(false)}
            >
              {t('cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={logoutAllBusy}
              onClick={() => void handleLogoutAll()}
            >
              {logoutAllBusy ? <Loader2 className="animate-spin" /> : null}
              {t('logoutAllConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingSection>
  )
}
