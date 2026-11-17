const PASSTHROUGH_IMAGE_SRC_PREFIXES = [
  'http://',
  'https://',
  'asset://',
  'tauri://',
  'data:',
  'blob:',
  'file:',
  '/api/workspace/media/',
] as const

const WORKSPACE_MEDIA_URL_BASE = '/api/workspace/media'

const LEGACY_LOCALHOST_SRC_RE = /^(?:tauri|asset|http):\/\/localhost\//
const ABSOLUTE_MEDIA_URL_RE = /^https?:\/\/[^/]+\/api\/workspace\/media\//i

export function shouldKeepImageSrcAsIs(src: string | null | undefined): boolean {
  if (!src) {
    return false
  }

  if (src === WORKSPACE_MEDIA_URL_BASE) {
    return true
  }

  return PASSTHROUGH_IMAGE_SRC_PREFIXES.some((prefix) => src.startsWith(prefix))
}

export function shouldTransformImageSrcToWorkspaceAsset(src: string | null | undefined): boolean {
  if (!src) {
    return false
  }

  return !shouldKeepImageSrcAsIs(src)
}

/**
 * Strip a display URL back to the path that belongs in saved Markdown.
 *
 * Display URLs (Tauri `asset://localhost/...`, `http://localhost/...`,
 * and web `/api/workspace/media/...` URLs, with or without an origin)
 * must never leak into stored Markdown: the stored form is the
 * markdown-relative path carried by `relativeSrc`. This helper only
 * removes the display prefix; it never resolves the remainder
 * against a markdown file, so callers that need a markdown-relative
 * path must compute it with the file context they already have.
 * Plain relative paths, data URLs, blob URLs, and remote http(s)
 * URLs pass through unchanged.
 */
export function stripDisplayImageUrlPrefix(src: string | null | undefined): string {
  if (!src) {
    return ''
  }

  if (src === WORKSPACE_MEDIA_URL_BASE) {
    return ''
  }

  if (src.startsWith(`${WORKSPACE_MEDIA_URL_BASE}/`)) {
    return src.slice(WORKSPACE_MEDIA_URL_BASE.length + 1)
  }

  const absoluteMediaMatch = src.match(ABSOLUTE_MEDIA_URL_RE)
  if (absoluteMediaMatch) {
    return src.slice(absoluteMediaMatch[0].length)
  }

  return src.replace(LEGACY_LOCALHOST_SRC_RE, '')
}
