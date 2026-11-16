'use client'

import { useEffect, useState } from 'react'
import { platform } from '@/lib/platform'
import { Power } from 'lucide-react'
import { useTranslations } from 'next-intl'

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

export function CloseBehaviorGuard() {
  const t = useTranslations('settings.general.behavior.closePrompt')
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const unlistenPromise = platform.event.listen('close-behavior-requested', () => {
      setOpen(true)
    })

    return () => {
      void unlistenPromise.then((unlisten) => unlisten())
    }
  }, [])

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogMedia><Power /></AlertDialogMedia>
          <AlertDialogTitle>{t('title')}</AlertDialogTitle>
          <AlertDialogDescription>{t('desc')}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant="outline"
            onClick={() => void platform.window.getCurrentWindow().hide()}
          >
            {t('minimize')}
          </AlertDialogAction>
          <AlertDialogAction
            variant="destructive"
            onClick={() => void platform.process.exit(0)}
          >
            {t('quit')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
