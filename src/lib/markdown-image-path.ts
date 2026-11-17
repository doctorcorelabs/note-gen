function normalizePathSegments(path: string): string[] {
  const normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+/g, '/')

  if (!normalized) {
    return []
  }

  const segments: string[] = []

  for (const segment of normalized.split('/')) {
    if (!segment || segment === '.') {
      continue
    }

    if (segment === '..') {
      if (segments.length > 0) {
        segments.pop()
      }
      continue
    }

    segments.push(segment)
  }

  return segments
}

function getMarkdownDirSegments(markdownPath: string): string[] {
  const segments = normalizePathSegments(markdownPath)
  return segments.slice(0, -1)
}

// Markdown 链接中的路径通常经过 URL 编码（如空格为 %20），解析为磁盘路径时需解码
function decodePathSegment(segment: string): string {
  if (!segment.includes('%')) {
    return segment
  }

  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

export function resolveImagePathFromMarkdown(markdownPath: string, imagePath: string): string {
  const markdownDirSegments = getMarkdownDirSegments(markdownPath)
  const imageSegments = imagePath
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .split('/')
    .filter(Boolean)
    .map(decodePathSegment)

  const resolvedSegments = [...markdownDirSegments]

  for (const segment of imageSegments) {
    if (segment === '.') {
      continue
    }

    if (segment === '..') {
      if (resolvedSegments.length > 0) {
        resolvedSegments.pop()
      }
      continue
    }

    resolvedSegments.push(segment)
  }

  return resolvedSegments.join('/')
}

/**
 * Normalize a workspace image path for the web media endpoint.
 *
 * The web asset adapter only accepts workspace-relative paths (see
 * `src/lib/platform/asset/asset.web.ts`), so callers must not join
 * a workspace root or app-data prefix before calling it. This
 * helper performs the reversible lexical cleanup only: separators,
 * leading slashes and `./` markers, and the default-workspace
 * `article/` prefix. The adapter remains the authority that
 * rejects `..` segments, hidden segments, overlong paths, and
 * control characters. Callers must pass decoded paths (the
 * resolver in this file already decodes markdown URL segments);
 * this helper never decodes percent escapes.
 */
export function toWorkspaceMediaRelativePath(path: string, isCustomWorkspace: boolean): string {
  let normalized = path
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')

  while (normalized.startsWith('/')) {
    normalized = normalized.slice(1)
  }
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2)
  }

  if (!isCustomWorkspace) {
    normalized = normalized.replace(/^article\//, '')
  }

  return normalized
}

export function toMarkdownImagePath(markdownPath: string, workspaceImagePath: string): string {
  const markdownDirSegments = getMarkdownDirSegments(markdownPath)
  const imageSegments = normalizePathSegments(workspaceImagePath)

  let commonPrefixLength = 0
  while (
    commonPrefixLength < markdownDirSegments.length &&
    commonPrefixLength < imageSegments.length &&
    markdownDirSegments[commonPrefixLength] === imageSegments[commonPrefixLength]
  ) {
    commonPrefixLength++
  }

  const upwardSegments = new Array(markdownDirSegments.length - commonPrefixLength).fill('..')
  const downwardSegments = imageSegments.slice(commonPrefixLength)

  return [...upwardSegments, ...downwardSegments].join('/') || '.'
}
