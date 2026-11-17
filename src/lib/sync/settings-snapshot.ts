import { normalizeSpeechMode } from '@/lib/speech/preferences'
import { filterSyncData, type SyncExclusionOptions } from '@/config/sync-exclusions'
import { DEFAULT_EDITOR_CONTENT_WIDTH, normalizeEditorContentWidth, normalizeEditorLineHeight, normalizeEditorViewMode } from '@/lib/editor-layout-styles'
import { normalizeOutlinePosition } from '@/lib/outline-preferences'
import { normalizeRecordSortMode, normalizeRecordViewMode } from '@/lib/record-display-preferences'
import { normalizeRecordCompletionBehavior, normalizeRecordSaveTargetMode, normalizeRecordTagId } from '@/lib/record-save-preferences'
import { normalizeCanvasGridGap, normalizeCanvasGridStyle, normalizeCanvasInsertBehavior, normalizeCanvasManagerSortMode, normalizeCanvasManagerViewMode, normalizeCanvasWheelBehavior, normalizeCanvasZoom } from '@/lib/canvas/preferences'
import { isManagedAgentSystemPrompt } from '@/lib/ai/system-prompt'

// Sponsor-gateway purge (AD-15). Structural twin of isSponsorGatewayConfig
// in src/stores/setting.ts: same three checks, applied to untyped snapshot
// records. Keep both copies in sync. The hostname literal below is a purge
// predicate only: it is never used to build a request URL.
const SPONSOR_GATEWAY_HOST = 'api.notegen.top'
const SPONSOR_GATEWAY_MODEL_IDS = new Set([
  'note-gen-chat',
  'note-gen-embedding',
  'note-gen-stt',
])

function isSponsorGatewayRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  let hostname = ''
  try {
    hostname = new URL(String(record.baseURL ?? '')).hostname.toLowerCase()
  } catch {
    hostname = ''
  }
  if (hostname === SPONSOR_GATEWAY_HOST) return true
  if (record.templateKey === 'note-gen-free') return true
  if (Array.isArray(record.models) && record.models.some(
    (model) => model && typeof model === 'object' && SPONSOR_GATEWAY_MODEL_IDS.has(String((model as Record<string, unknown>).id ?? '')),
  )) return true
  return false
}

/** Pure equivalent of persisted preference migrations, before preview or writes.
 * Defaults come from getInitialState(), never from this device's live choices. */
export function normalizeSettingsSnapshot(value: Record<string, unknown>, defaults: Record<string, unknown>, options: SyncExclusionOptions = { excludeSensitiveConfig: true }) {
  const filtered = (input: Record<string, unknown>) => filterSyncData(Object.fromEntries(
    Object.entries(input).filter(([, item]) => typeof item !== 'function' && item !== undefined)
  ), options)
  const result: Record<string, unknown> = { ...filtered(defaults), ...filtered(value) }
  result.editorContentWidth = normalizeEditorContentWidth(value.editorContentWidth
    ?? (value.centeredContent === true ? 'standard' : DEFAULT_EDITOR_CONTENT_WIDTH))
  const normalizers: Record<string, (value: unknown) => unknown> = {
    textToSpeechMode: normalizeSpeechMode, speechToTextMode: normalizeSpeechMode,
    editorLineHeight: normalizeEditorLineHeight, editorViewMode: normalizeEditorViewMode,
    outlinePosition: normalizeOutlinePosition, recordViewMode: normalizeRecordViewMode,
    recordSortMode: normalizeRecordSortMode, recordSaveTargetMode: normalizeRecordSaveTargetMode,
    fixedRecordTagId: normalizeRecordTagId, recordCompletionBehavior: normalizeRecordCompletionBehavior,
    canvasGridStyle: normalizeCanvasGridStyle, canvasGridGap: normalizeCanvasGridGap,
    canvasDefaultZoom: normalizeCanvasZoom, canvasManagerViewMode: normalizeCanvasManagerViewMode,
    canvasManagerSortMode: normalizeCanvasManagerSortMode, canvasWheelBehavior: normalizeCanvasWheelBehavior,
    canvasInsertBehavior: normalizeCanvasInsertBehavior,
  }
  for (const [key, normalize] of Object.entries(normalizers)) result[key] = normalize(result[key])
  result.agentSystemPromptExtension = typeof value.agentSystemPromptExtension === 'string' ? value.agentSystemPromptExtension
    : typeof value.systemPrompt === 'string' && !isManagedAgentSystemPrompt(value.systemPrompt) ? value.systemPrompt : ''
  delete result.systemPrompt // Legacy storage alias; the extension is the persisted preference.
  if (Array.isArray(value.recordToolbarConfig) && Array.isArray(defaults.recordToolbarConfig)) {
    const toolbar = value.recordToolbarConfig as Array<{ id: string; order: number }>
    if (toolbar.some(item => !item || typeof item.id !== 'string' || !Number.isFinite(item.order))) throw new Error('Invalid record toolbar settings')
    let order = toolbar.reduce((max, item) => Math.max(max, item.order), 0)
    result.recordToolbarConfig = [...toolbar, ...(defaults.recordToolbarConfig as Array<{ id: string; order: number }>)
      .filter(item => !toolbar.some(existing => existing.id === item.id)).map(item => ({ ...item, order: ++order }))]
  }
  // Drop sponsor gateway configs from restored snapshots (AD-15).
  if (Array.isArray(result.aiModelList)) {
    result.aiModelList = result.aiModelList.filter((item) => !isSponsorGatewayRecord(item))
  }
  for (const key of ['primaryModel', 'editorModel', 'placeholderModel', 'imageMethodModel', 'completionModel', 'markDescModel', 'commitModel']) {
    const value = result[key]
    if (typeof value === 'string' && (value.startsWith('note-gen-limited') || value.startsWith('note-gen-free-') || value === 'note-gen-chat' || value === 'note-gen-embedding' || value === 'note-gen-vlm')) result[key] = ''
  }
  // Keep the final snapshot inside the same boundary even when a migration
  // adds fields. Preview, persistence, verification and recovery share it.
  return filtered(result)
}
