import { invoke } from '@tauri-apps/api/core'
import { isTauri, platform } from '@/lib/platform'

export function supportsNativeDeveloperTools(): boolean {
  if (typeof window === 'undefined' || !isTauri()) return false
  try {
    const currentPlatform = platform.os.platform()
    return currentPlatform !== 'android' && currentPlatform !== 'ios'
  } catch {
    return false
  }
}

export async function openDeveloperTools(): Promise<void> {
  if (!supportsNativeDeveloperTools()) return
  await invoke('open_developer_tools')
}

export async function closeDeveloperTools(): Promise<void> {
  if (!supportsNativeDeveloperTools()) return
  await invoke('close_developer_tools')
}

export async function isDeveloperToolsOpen(): Promise<boolean> {
  if (!supportsNativeDeveloperTools()) return false
  return invoke<boolean>('is_developer_tools_open')
}
