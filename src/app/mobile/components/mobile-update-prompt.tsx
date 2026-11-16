'use client'

import { useEffect, useRef } from 'react'
import { platform } from '@/lib/platform'
import useSettingStore from '@/stores/setting'
import useUpdateStore, {
  ANDROID_DOWNLOAD_URL,
  IOS_TESTFLIGHT_URL,
} from '@/stores/update'

export type MobilePlatform = 'android' | 'ios'

export function getMobilePlatform(): MobilePlatform | null {
  const currentPlatform = platform.os.platform()
  return currentPlatform === 'android' || currentPlatform === 'ios'
    ? currentPlatform
    : null
}

export async function openMobileUpdatePage(currentPlatform: MobilePlatform) {
  await platform.opener.openUrl(currentPlatform === 'android' ? ANDROID_DOWNLOAD_URL : IOS_TESTFLIGHT_URL)
}

export function MobileUpdateChecker() {
  const version = useSettingStore((state) => state.version)
  const { checkForMobileUpdates, initUpdateStore } = useUpdateStore()
  const checkedVersionRef = useRef('')

  useEffect(() => {
    if (!version || checkedVersionRef.current === version) return

    const detectedPlatform = getMobilePlatform()
    if (!detectedPlatform) return

    checkedVersionRef.current = version

    async function checkOnLaunch() {
      try {
        await initUpdateStore()
        await checkForMobileUpdates(version)
      } catch (error) {
        console.error('[MobileUpdateChecker] Failed to check for updates:', error)
      }
    }

    void checkOnLaunch()
  }, [checkForMobileUpdates, initUpdateStore, version])

  return null
}
