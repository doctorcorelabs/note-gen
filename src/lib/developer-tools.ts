import { platform, isTauri } from '@/lib/platform'

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
