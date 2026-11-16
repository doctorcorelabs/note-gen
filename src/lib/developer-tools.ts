import { platform } from '@/lib/platform'
import { platform as osPlatform } from '@tauri-apps/plugin-os'

export function supportsNativeDeveloperTools(): boolean {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in globalThis)) return false
  try {
    const currentPlatform = osPlatform()
    return currentPlatform !== 'android' && currentPlatform !== 'ios'
  } catch {
    return false
  }
}

export async function openDeveloperTools(): Promise<void> {
  if (!supportsNativeDeveloperTools()) return
  await platform.invoke.invoke('open_developer_tools')
}

export async function closeDeveloperTools(): Promise<void> {
  if (!supportsNativeDeveloperTools()) return
  await platform.invoke.invoke('close_developer_tools')
}

export async function isDeveloperToolsOpen(): Promise<boolean> {
  if (!supportsNativeDeveloperTools()) return false
  return platform.invoke.invoke<boolean>('is_developer_tools_open')
}
