'use client'

import { useEffect, useState } from 'react'
import { capabilities, isTauri, platform } from '@/lib/platform'
import { AppWindow, PanelTopClose, Rocket } from 'lucide-react'
import { useTranslations } from 'next-intl'

import { toast } from '@/hooks/use-toast'
import useSettingStore, { type CloseBehavior } from '@/stores/setting'
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { SettingSection } from '../components/setting-base'

export function SystemBehaviorSettings() {
  const t = useTranslations('settings.general.behavior')
  const {
    autostartMinimized,
    closeBehavior,
    setAutostartMinimized,
    setCloseBehavior,
  } = useSettingStore()
  const [autostart, setAutostart] = useState(false)
  const [autostartLoading, setAutostartLoading] = useState(true)
  const autostartAvailable = capabilities.autostart
  const desktopApp = isTauri()

  useEffect(() => {
    let cancelled = false

    async function loadAutostartState() {
      try {
        const enabled = autostartAvailable ? await platform.autostart.isEnabled() : false
        if (!cancelled) setAutostart(enabled)
      } catch (error) {
        console.error('Failed to read autostart state:', error)
      } finally {
        if (!cancelled) setAutostartLoading(false)
      }
    }

    void loadAutostartState()

    return () => {
      cancelled = true
    }
  }, [])

  async function handleAutostartChange(enabled: boolean) {
    setAutostartLoading(true)
    try {
      if (enabled) {
        await platform.autostart.enable()
      } else {
        await platform.autostart.disable()
      }
      setAutostart(await platform.autostart.isEnabled())
    } catch (error) {
      console.error('Failed to update autostart state:', error)
      toast({
        title: t('autostart.error'),
        variant: 'destructive',
      })
    } finally {
      setAutostartLoading(false)
    }
  }

  async function handleAutostartMinimizedChange(enabled: boolean) {
    setAutostartLoading(true)
    try {
      if (enabled && autostart) {
        await platform.autostart.disable()
        await platform.autostart.enable()
      }
      await setAutostartMinimized(enabled)
    } catch (error) {
      console.error('Failed to update minimized autostart state:', error)
      try {
        setAutostart(await platform.autostart.isEnabled())
      } catch (stateError) {
        console.error('Failed to refresh autostart state:', stateError)
      }
      toast({
        title: t('autostartMinimized.error'),
        variant: 'destructive',
      })
    } finally {
      setAutostartLoading(false)
    }
  }

  return (
    <SettingSection title={t('title')} desc={t('desc')}>
      <ItemGroup className="gap-3">
        <Item variant="outline" aria-disabled={!desktopApp}>
          <ItemMedia variant="icon"><AppWindow /></ItemMedia>
          <ItemContent>
            {/* The badge text intentionally matches the autostart item in
                this file. The string is claimed for the catalogue by
                slot i18n-g5 under
                settings.general.behavior.autostart.desktopOnly; no new
                key is claimed for it here. */}
            <ItemTitle>{t('close.title')} {!desktopApp && <Badge variant="secondary">Desktop only</Badge>}</ItemTitle>
            <ItemDescription>{t('close.desc')}</ItemDescription>
          </ItemContent>
          <ItemActions className="basis-full sm:ml-auto sm:basis-auto">
            <Select
              value={closeBehavior}
              disabled={!desktopApp}
              onValueChange={(value) => void setCloseBehavior(value as CloseBehavior)}
            >
              <SelectTrigger className="w-full sm:w-[200px]" aria-label={t('close.title')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="minimize">{t('close.options.minimize')}</SelectItem>
                  <SelectItem value="quit">{t('close.options.quit')}</SelectItem>
                  <SelectItem value="ask">{t('close.options.ask')}</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </ItemActions>
        </Item>

        <Item variant="outline">
          <ItemMedia variant="icon"><Rocket /></ItemMedia>
          <ItemContent>
            <ItemTitle>{t('autostart.title')} {!autostartAvailable && <Badge variant="secondary">Desktop only</Badge>}</ItemTitle>
            <ItemDescription>{t('autostart.desc')}</ItemDescription>
          </ItemContent>
          <ItemActions className="ml-auto mobile-setting-inline-action">
            <Switch
              checked={autostart}
              disabled={!autostartAvailable || autostartLoading}
              aria-label={t('autostart.title')}
              onCheckedChange={(enabled) => void handleAutostartChange(enabled)}
            />
          </ItemActions>
        </Item>

        <Item variant="outline" aria-disabled={!autostart}>
          <ItemMedia variant="icon"><PanelTopClose /></ItemMedia>
          <ItemContent>
            <ItemTitle>{t('autostartMinimized.title')}</ItemTitle>
            <ItemDescription>{t('autostartMinimized.desc')}</ItemDescription>
          </ItemContent>
          <ItemActions className="ml-auto mobile-setting-inline-action">
            <Switch
              checked={autostartMinimized}
              disabled={!autostartAvailable || !autostart || autostartLoading}
              aria-label={t('autostartMinimized.title')}
              onCheckedChange={(enabled) => void handleAutostartMinimizedChange(enabled)}
            />
          </ItemActions>
        </Item>
      </ItemGroup>
    </SettingSection>
  )
}
