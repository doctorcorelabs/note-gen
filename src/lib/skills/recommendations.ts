// Local-only skill recommendations (AD-15). No Config Center fetch, no cache.
// Pinned bundle: config/recommended-skills.json. See config/PIN-REVIEW.md.
import builtinRecommendations from '../../../config/recommended-skills.json'

export interface RecommendedSkill {
  id: string
  name: Record<string, string>
  description: Record<string, string>
  author: string
  sourceUrl: string
}

interface RecommendedSkillsConfig {
  schemaVersion: 1
  skills: RecommendedSkill[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function normalizeLocalizedText(value: unknown): Record<string, string> | null {
  if (!isRecord(value) || !isNonEmptyString(value.en)) return null
  const entries = Object.entries(value)
  if (entries.some(([locale, text]) => !locale.trim() || !isNonEmptyString(text))) return null
  return Object.fromEntries(entries.map(([locale, text]) => [locale, String(text).trim()]))
}

function isSourceUrl(value: unknown): value is string {
  if (!isNonEmptyString(value)) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password
  } catch {
    return false
  }
}

function normalizeConfig(payload: unknown): RecommendedSkillsConfig | null {
  if (!isRecord(payload) || payload.schemaVersion !== 1 || !Array.isArray(payload.skills)) return null
  const skills: RecommendedSkill[] = []
  const ids = new Set<string>()
  for (const item of payload.skills) {
    if (!isRecord(item) || !isNonEmptyString(item.id)
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(item.id) || item.id.length > 64
      || ids.has(item.id) || !isNonEmptyString(item.author) || !isSourceUrl(item.sourceUrl)) {
      return null
    }
    const name = normalizeLocalizedText(item.name)
    const description = normalizeLocalizedText(item.description)
    if (!name || !description) return null
    ids.add(item.id)
    skills.push({
      id: item.id,
      name,
      description,
      author: item.author.trim(),
      sourceUrl: item.sourceUrl.trim(),
    })
  }
  // An empty list is valid: publishing one removes all recommendations.
  return { schemaVersion: 1, skills }
}

export function getRecommendedSkillText(text: Record<string, string>, locale: string): string {
  return text[locale] || text[locale.split('-')[0]] || text.en || Object.values(text)[0] || ''
}

export function loadRecommendedSkills(): Promise<RecommendedSkill[]> {
  return Promise.resolve(normalizeConfig(builtinRecommendations)?.skills ?? [])
}
