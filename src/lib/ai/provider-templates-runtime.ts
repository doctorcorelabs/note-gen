// Local-only provider templates (AD-15). No Config Center fetch, no cache.
// Pinned bundle: config/provider-templates.json and config/provider-templates-cn.json.
// See config/PIN-REVIEW.md for the review record. Bundle changes only ship
// with a reviewed fork release.
import type { AiConfig } from '@/app/core/setting/config'
import {
  excludeBuiltInOpenAIProviders,
  isMainlandChinaAppStore,
} from '@/lib/ai/storefront-policy'
import pinnedTemplates from '../../../config/provider-templates.json'
import pinnedTemplatesChina from '../../../config/provider-templates-cn.json'

type PinnedTemplateBundleKey = 'providerTemplates' | 'providerTemplatesChina'

// Loopback entries allowed over HTTP, server-side only (AD-12, AD-16).
// Each entry is one pinned local provider: template key + host + port.
// No other HTTP baseURL is accepted anywhere in this loader.
const LOOPBACK_ALLOWLIST: Array<{ key: string; hostname: string; port: string }> = [
  { key: 'ollama', hostname: 'localhost', port: '11434' },
  { key: 'ollama', hostname: '127.0.0.1', port: '11434' },
  { key: 'lmstudio', hostname: 'localhost', port: '1234' },
  { key: 'lmstudio', hostname: '127.0.0.1', port: '1234' },
]

const BLOCKED_HOSTS = new Set(['metadata.google.internal'])

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) {
    return false
  }
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function isBlockedLiteralIp(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '::1' || host === '[::1]') {
    return true
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^169\.254\./.test(host)) {
    return true
  }
  const m172 = /^172\.(\d+)\./.exec(host)
  if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) {
    return true
  }
  if (host.startsWith('fe80:') || host.startsWith('[fe80:')) {
    return true
  }
  return false
}

function isAllowedBaseUrl(key: string, raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.username || url.password) {
    return false
  }
  if (url.search || url.hash) {
    return false
  }
  const hostname = url.hostname.toLowerCase()
  if (BLOCKED_HOSTS.has(hostname)) {
    return false
  }
  if (url.protocol === 'http:') {
    return LOOPBACK_ALLOWLIST.some(
      (entry) => entry.key === key && entry.hostname === hostname && entry.port === url.port,
    )
  }
  if (url.protocol !== 'https:') {
    return false
  }
  if (isBlockedLiteralIp(hostname)) {
    return false
  }
  return true
}

function neutralizeApiKeyUrl(value: unknown): string | undefined {
  if (!isValidUrl(value)) {
    return undefined
  }
  const url = new URL(String(value).trim())
  if (url.protocol !== 'https:' || url.username || url.password) {
    return undefined
  }
  return `${url.origin}${url.pathname}`
}

function pinnedIcon(value: unknown): string | undefined {
  const icon = isNonEmptyString(value) ? value.trim() : ''
  if (!icon.startsWith('https://') || !isValidUrl(icon)) {
    return undefined
  }
  return icon
}

// Whitelist output: only display metadata is copied. Never copies apiKey,
// sponsored, promotion, customHeaders, or proxy fields from the bundle.
// Exported so unit tests can run the validation table against the exact
// function loadProviderTemplates uses; production callers use
// loadProviderTemplates, never this export directly.
export function normalizeTemplateRecords(records: unknown[]): AiConfig[] {
  const seen = new Set<string>()
  const out: AiConfig[] = []
  for (const item of records) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    if (record.enabled === false) {
      continue
    }
    if (!isNonEmptyString(record.key) || !isNonEmptyString(record.title)) {
      continue
    }
    if (!isNonEmptyString(record.baseURL)) {
      continue
    }
    const key = String(record.key).trim()
    const baseURL = String(record.baseURL).trim()
    if (seen.has(key)) {
      console.error(`[provider-templates] duplicate template key dropped: ${key}`)
      continue
    }
    if (!isAllowedBaseUrl(key, baseURL)) {
      console.error(`[provider-templates] template dropped, invalid baseURL: ${key}`)
      continue
    }
    seen.add(key)
    out.push({
      key,
      title: String(record.title).trim(),
      baseURL,
      icon: pinnedIcon(record.icon),
      apiKeyUrl: neutralizeApiKeyUrl(record.apiKeyUrl),
      templateKey: key,
      templateSource: 'builtin',
    })
  }
  return out
}

function bundleProviders(payload: unknown): unknown[] {
  const providers = (payload as { providers?: unknown[] } | null)?.providers
  return Array.isArray(providers) ? providers : []
}

function matchProviderTemplate({
  currentConfig,
  templates,
}: {
  currentConfig: AiConfig | undefined
  templates: AiConfig[]
}) {
  if (!currentConfig || templates.length === 0) {
    return null
  }
  if (isNonEmptyString(currentConfig.templateKey)) {
    const matchedByKey = templates.find((item) => item.key === currentConfig.templateKey)
    if (matchedByKey) {
      return matchedByKey
    }
  }
  if (isValidUrl(currentConfig.baseURL)) {
    const matchedByBaseUrl = templates.find((item) => item.baseURL === currentConfig.baseURL)
    if (matchedByBaseUrl) {
      return matchedByBaseUrl
    }
  }
  return null
}

function enforceStorefrontPolicy(
  templates: AiConfig[],
  bundleKey: PinnedTemplateBundleKey,
): AiConfig[] {
  return bundleKey === 'providerTemplatesChina'
    ? excludeBuiltInOpenAIProviders(templates)
    : templates
}

async function getPinnedTemplateBundleKey(): Promise<PinnedTemplateBundleKey> {
  return (await isMainlandChinaAppStore()) ? 'providerTemplatesChina' : 'providerTemplates'
}

export async function loadProviderTemplates(builtinTemplates: AiConfig[]): Promise<AiConfig[]> {
  const bundleKey = await getPinnedTemplateBundleKey()
  const pinned = enforceStorefrontPolicy(
    normalizeTemplateRecords(
      bundleProviders(bundleKey === 'providerTemplatesChina' ? pinnedTemplatesChina : pinnedTemplates),
    ),
    bundleKey,
  )
  if (pinned.length > 0) {
    return pinned
  }
  console.error('[provider-templates] pinned bundle empty after validation; falling back to built-in templates')
  const fallback = enforceStorefrontPolicy(
    normalizeTemplateRecords(builtinTemplates as unknown[]),
    bundleKey,
  )
  if (fallback.length > 0) {
    return fallback
  }
  console.error('[provider-templates] no usable provider templates')
  return []
}

export function getProviderTemplateMatch(currentConfig: AiConfig | undefined, templates: AiConfig[]) {
  return matchProviderTemplate({
    currentConfig,
    templates,
  }) as AiConfig | null
}
