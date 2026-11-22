import { platform } from '@/lib/platform'
import type { CustomThemeColors } from '@/types/theme'
import type { Tag } from '@/db/tags'

export const QUICK_RECORD_WINDOW = 'quick-record'

export async function hideQuickRecordWindow(): Promise<void> {
  await platform.invoke.invoke('hide_quick_record_window')
}

export interface QuickRecordContext {
  tags: Tag[]
  selectedTagId: number | null
  autoReadClipboard: boolean
  uiScale: number
  appFontFamily: string
  customThemeColors: CustomThemeColors
}

export interface QuickRecordRequest {
  id: string
  action: 'prepare' | 'save' | 'createTag'
  tagName?: string
  text?: string
  tagId?: number
}

export interface QuickRecordResponse {
  id: string
  context?: QuickRecordContext
  saved?: boolean
  createdTag?: Tag
  error?: 'invalid' | 'failed'
}

export async function requestQuickRecord(request: QuickRecordRequest): Promise<QuickRecordResponse> {
  let unlisten: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<QuickRecordResponse>((resolve, reject) => {
      void (async () => {
        unlisten = await platform.window.getCurrentWindow().listen<QuickRecordResponse>('quick-record-response', event => {
          if (event.payload.id === request.id) resolve(event.payload)
        })
        timer = setTimeout(() => reject(new Error('timeout')), 15000)
        await platform.event.emitTo('main', 'quick-record-request', request)
      })().catch(reject)
    })
  } finally {
    unlisten?.()
    clearTimeout(timer)
  }
}
