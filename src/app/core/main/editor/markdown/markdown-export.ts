'use client'

import { platform } from '@/lib/platform'
import type { JSONContent } from '@tiptap/core'
import TaskList from '@tiptap/extension-task-list'
import Link from '@tiptap/extension-link'
import Image from '@tiptap/extension-image'
import { TableRow } from '@tiptap/extension-table-row'
import { MarkdownManager } from '@tiptap/markdown'
import { WikiMetadata } from './wiki-metadata-extension'
import { MarkdownParagraph } from './markdown-paragraph'
import { MarkdownListItem, MarkdownTaskItem } from './markdown-list-item'
import { MarkdownTable, MarkdownTableCell, MarkdownTableHeader } from './markdown-table-extension'
import { InlineMath, BlockMath } from './math-extension'
import { MermaidDiagram, renderMermaid } from './mermaid-extension'
import StarterKit from '@tiptap/starter-kit'
import { renderMarkdownExportFragment } from '@/lib/markdown/export-document'
import { checkIsTauri } from '@/lib/check'
import { resolveImagePathFromMarkdown } from '@/lib/markdown-image-path'
import { convertImageByWorkspace } from '@/lib/utils'
import { getFilePathOptions } from '@/lib/workspace'
import { shouldTransformImageSrcToWorkspaceAsset } from './image-src'
import { GitHubAlertBlockquote } from './github-alert-blockquote'
import { MarkdownOrderedList } from './markdown-ordered-list'
import { createIsolatedMarkdownLexer } from './markdown-tokenizers'
import { LANGUAGE_STORAGE_KEY, normalizeLocale, toHtmlLangTag } from '@/i18n/config'

export type MarkdownExportFormat = 'markdown' | 'html' | 'json' | 'pdf'

export interface MarkdownExportSource {
  baseName: string
  markdown: string | (() => string | Promise<string>)
  // DA-6 EXP-03 (area 12): JSON export always parses from markdown
  // with the editor-aligned extension set, so the result no longer
  // depends on the entry point. This field is kept for caller
  // compatibility and is ignored.
  json?: JSONContent | (() => JSONContent | Promise<JSONContent>)
  sourcePath?: string
}

export interface MarkdownExportWarning {
  code: 'asset-not-embedded' | 'highlight-fallback' | 'styles-truncated' | 'unsupported-content'
  message: string
}

export interface MarkdownExportOptions {
  onPdfRenderStart?: () => void
  // DA-6 EXP-01/EXP-04 (area 13): caller deadline signal, forwarded
  // to the fragment renderer so a timeout cancels background work
  // instead of only racing it at the surface.
  signal?: AbortSignal
  // DA-6 EXP-05 (area 12): non-blocking export degradations (image
  // not embedded, highlight fallback, styles truncated) are reported
  // here so callers can surface them after a successful export.
  onWarnings?: (warnings: MarkdownExportWarning[]) => void
  /** Explicit export locale. When omitted, the active UI locale is used (D-6). */
  locale?: string
  // DA-2 (EXP-04): flush pending editor saves before a file-tree
  // export reads from disk; resolving false aborts the export
  // instead of silently exporting stale saved content.
  flushPendingSave?: () => Promise<boolean>
}

const IMAGE_LOAD_TIMEOUT_MS = 5000
const EXPORT_ASSET_FETCH_TIMEOUT_MS = 10000
const PRINT_FRAME_CLEANUP_DELAY_MS = 60000
const PRINT_EXPORT_STORE = 'print-export.json'
const PRINT_WINDOW_START_TIMEOUT_MS = 15000
const DIRECT_PDF_EXPORT_TIMEOUT_MS = 75000
const HTML_EXPORT_TIMEOUT_MS = 75000
const EXPORT_IMAGE_EMBED_LIMIT_BYTES = 2 * 1024 * 1024
const EXPORT_IMAGE_EMBED_TOTAL_LIMIT_BYTES = 10 * 1024 * 1024
// PB2 PERF-01: bound parallel image embedding so a note with many
// images does not spend the whole export deadline fetching serially.
const EXPORT_IMAGE_EMBED_CONCURRENCY = 4
const EXPORT_STYLES_BYTE_LIMIT = 10 * 1024 * 1024
const ANIMATION_FRAME_TIMEOUT_MS = 250
const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'"\)]+)\1\s*\)/g

interface TauriPrintDocument {
  html: string
  outputPath?: string
  completionEvent?: string
}

const EXPORT_DOCUMENT_STYLES = `
  @page {
    size: A4;
    margin: 18mm 16mm 20mm;
  }

  :root {
    color-scheme: light;
  }

  html,
  body {
    width: auto !important;
    height: auto !important;
    min-height: 100% !important;
    margin: 0;
    padding: 0;
    overflow: visible !important;
    background: #ffffff !important;
    color: #24292f !important;
  }

  body.notegen-export {
    max-width: 800px;
    margin: 0 auto;
    padding: 40px 24px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.65;
  }

  .notegen-export .streamdown-document {
    color: #24292f !important;
  }

  .notegen-export h1,
  .notegen-export h2,
  .notegen-export h3,
  .notegen-export h4,
  .notegen-export h5,
  .notegen-export h6 {
    break-after: avoid-page;
    color: #111827 !important;
  }

  .notegen-export h1 { font-size: 28px; }
  .notegen-export h2 { font-size: 22px; }
  .notegen-export h3 { font-size: 18px; }
  .notegen-export h4 { font-size: 16px; }

  .notegen-export p,
  .notegen-export li,
  .notegen-export blockquote {
    orphans: 3;
    widows: 3;
  }

  .notegen-export ul,
  .notegen-export ol,
  .notegen-export li {
    break-inside: avoid-page;
    page-break-inside: avoid;
  }

  .notegen-export a {
    color: #0969da !important;
    text-decoration: underline;
  }

  .notegen-export blockquote {
    border-left-color: #d0d7de !important;
    color: #57606a !important;
  }

  .notegen-export pre,
  .notegen-export table,
  .notegen-export img,
  .notegen-export .katex-display {
    break-inside: avoid-page;
  }

  .notegen-export pre {
    white-space: pre-wrap !important;
    overflow-wrap: anywhere;
    background: #f6f8fa !important;
    color: #24292f !important;
  }

  .notegen-export code {
    color: #24292f;
  }

  .notegen-export table {
    width: 100%;
    border-collapse: collapse;
  }

  .notegen-export th,
  .notegen-export td {
    border: 1px solid #d0d7de !important;
    padding: 8px 10px;
    overflow-wrap: anywhere;
  }

  .notegen-export th {
    background: #f6f8fa !important;
  }

  .notegen-export img,
  .notegen-export svg,
  .notegen-export canvas {
    max-width: 100%;
    height: auto;
  }

  @media print {
    body.notegen-export {
      max-width: none;
      padding: 0;
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }

    .notegen-export [data-streamdown="table-wrapper"] {
      overflow: visible;
    }

    .notegen-export a {
      overflow-wrap: anywhere;
    }
  }
`

let markdownManager: MarkdownManager | null = null

export function sanitizeExportFileName(fileName: string) {
  return fileName
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'document'
}

export function getMarkdownExportBaseName(filePath?: string) {
  const fileName = filePath
    ? filePath.split(/[\\/]/).pop() || filePath
    : 'document'

  return sanitizeExportFileName(fileName.replace(/\.[^/.\\]+$/, ''))
}

function ensureExtension(path: string, extension: string) {
  return path.toLowerCase().endsWith(`.${extension}`) ? path : `${path}.${extension}`
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function downloadTextFile(content: string, filename: string, mimeType: string) {
  downloadBlob(new Blob([content], { type: mimeType }), filename)
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  // DA-6 EXP-07: revoking on a 0 ms timer can cancel the download in
  // some browsers before it starts; keep the object URL alive for
  // the same grace period as the print frame cleanup.
  window.setTimeout(() => URL.revokeObjectURL(url), PRINT_FRAME_CLEANUP_DELAY_MS)
}

async function saveTextExport(
  content: string,
  filename: string,
  extension: string,
  mimeType: string,
  filterName: string,
) {
  if (checkIsTauri()) {
    const selectedPath = await platform.dialog.save({
      title: 'Export',
      defaultPath: filename,
      filters: [{ name: filterName, extensions: [extension] }],
    })

    if (!selectedPath) {
      return false
    }

    await platform.fs.writeTextFile(ensureExtension(selectedPath, extension), content)
    return true
  }

  downloadTextFile(content, filename, mimeType)
  return true
}

function getMarkdownManager() {
  if (!markdownManager) {
    markdownManager = new MarkdownManager({
      marked: createIsolatedMarkdownLexer() as unknown as NonNullable<ConstructorParameters<typeof MarkdownManager>[0]>['marked'],
      // DA-6 EXP-03 (area 12): align with the editor schema so JSON
      // export keeps tables, math, mermaid, images, and task items
      // instead of dropping or reshaping them on the parse path.
      extensions: [
        GitHubAlertBlockquote,
        StarterKit.configure({
          blockquote: false,
          orderedList: false,
          listItem: false,
          paragraph: false,
          link: false,
        }),
        MarkdownParagraph,
        MarkdownListItem,
        MarkdownOrderedList,
        TaskList,
        MarkdownTaskItem.configure({ nested: true }),
        Link,
        Image,
        MarkdownTable,
        TableRow,
        MarkdownTableHeader,
        MarkdownTableCell,
        InlineMath,
        BlockMath,
        MermaidDiagram,
        WikiMetadata,
      ],
      indentation: {
        style: 'space',
        size: 2,
      },
    })
  }

  return markdownManager
}

export function parseMarkdownToJson(markdown: string) {
  return getMarkdownManager().parse(markdown)
}

async function getValue<T>(value: T | (() => T | Promise<T>)) {
  if (typeof value === 'function') {
    return await (value as () => T | Promise<T>)()
  }

  return value
}

// DA-6 EXP-06: scheme check for URL attributes in exported HTML.
// Control characters and whitespace are stripped first because URL
// parsers ignore them before reading the scheme, so an obfuscated
// "java\tscript:" must still match.
export function isDangerousExportUrl(value: string) {
  const compacted = value.replace(/[\u0000-\u0020\u007F]/g, '').toLowerCase()
  return compacted.startsWith('javascript:') || compacted.startsWith('data:text/html')
}

function sanitizeExportHtml(html: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  // DA-6 EXP-06: same element list as the advanced export path in
  // export-document.ts. src/srcset/poster are NOT stripped here
  // (unlike advanced) because the main path resolves images after
  // sanitizing; only dangerous URL schemes are removed.
  template.content
    .querySelectorAll('script, style, link, iframe, object, embed, audio, video, source, base, meta, form')
    .forEach((element) => {
      // PB3 BUG2-02: mermaid renders its diagram CSS in a style
      // element inside the generated SVG (securityLevel strict; the
      // CSS comes from the mermaid theme, not user text, and raw
      // user svg/style never survives the Streamdown sanitize
      // schema). Removing it would strip all diagram styling.
      if (element.tagName.toLowerCase() === 'style' && element.closest('svg')) return
      element.remove()
    })

  template.content.querySelectorAll<Element>('*').forEach((element) => {
    Array.from(element.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name)
      } else if (
        (name === 'href' || name === 'src' || name === 'xlink:href')
        && isDangerousExportUrl(attribute.value)
      ) {
        element.removeAttribute(attribute.name)
      }
    })
  })

  return template.innerHTML
}

// Race a promise against a timeout that yields the fallback
// value, so a hung asset load degrades the export instead of
// stalling it forever (UTANG-UJI-07).
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return Promise.race([
    promise,
    waitForTimeout(timeoutMs).then(() => fallback),
  ])
}

async function resolveMarkdownImageSources(html: string, sourcePath?: string) {
  const template = document.createElement('template')
  template.innerHTML = html
  const images = Array.from(template.content.querySelectorAll('img'))
  const warnings: MarkdownExportWarning[] = []
  let embeddedTotalBytes = 0

  // PB2 BUG2-01: the main export path now renders with
  // deferImages (same as the advanced path), so the original src
  // arrives in data-notegen-export-src and the img has no src yet.
  // Read the deferred source first; fall back to src for fragments
  // rendered without deferral.
  interface PendingImage {
    image: HTMLImageElement
    src: string
    fallbackSrc: string
    blob: Blob | null
    fetchFailed: boolean
  }

  const pending: PendingImage[] = []
  for (const image of images) {
    const deferredSrc = image.getAttribute('data-notegen-export-src')
    image.removeAttribute('data-notegen-export-src')
    const src = deferredSrc ?? image.getAttribute('src')
    if (!src || /^(?:data:|blob:)/i.test(src)) {
      if (src) {
        image.setAttribute('src', src)
      }
      continue
    }
    pending.push({ image, src, fallbackSrc: src, blob: null, fetchFailed: false })
  }

  // PB2 PERF-01: fetch image bytes with bounded concurrency
  // instead of one image at a time. Results are applied below in
  // document order, so size-limit accounting and warning order
  // stay deterministic.
  const fetchImage = async (entry: PendingImage) => {
    try {
      let url = entry.src
      if (sourcePath && shouldTransformImageSrcToWorkspaceAsset(entry.src)) {
        const fullRelativePath = resolveImagePathFromMarkdown(sourcePath, entry.src)
        url = await withTimeout(
          convertImageByWorkspace(fullRelativePath),
          EXPORT_ASSET_FETCH_TIMEOUT_MS,
          entry.src,
        )
        // In web mode the resolved URL is an authenticated
        // same-origin media URL; fetch its bytes and embed them.
        // On desktop the asset URL fetch may fail, in which case
        // the URL is kept as before.
        entry.fallbackSrc = url
      } else {
        url = new URL(entry.src, document.baseURI).href
      }
      const response = await fetch(url, {
        signal: AbortSignal.timeout(EXPORT_ASSET_FETCH_TIMEOUT_MS),
      })
      if (!response.ok) {
        throw new Error('Export asset fetch failed')
      }
      entry.blob = await response.blob()
    } catch {
      entry.fetchFailed = true
    }
  }

  for (let offset = 0; offset < pending.length; offset += EXPORT_IMAGE_EMBED_CONCURRENCY) {
    await Promise.all(pending.slice(offset, offset + EXPORT_IMAGE_EMBED_CONCURRENCY).map(fetchImage))
  }

  // DA-6 EXP-03 (area 13) + EXP-05 (area 12): embed image bytes as a
  // data URL with per-image and total size limits so the exported
  // HTML is self-contained; on failure keep the URL and record a
  // warning instead of degrading silently.
  for (const entry of pending) {
    const { image, fallbackSrc } = entry
    if (entry.fetchFailed || !entry.blob) {
      image.setAttribute('src', fallbackSrc)
      warnings.push({
        code: 'asset-not-embedded',
        message: 'An image could not be embedded in the exported file',
      })
      continue
    }
    const blob = entry.blob
    if (
      blob.size > EXPORT_IMAGE_EMBED_LIMIT_BYTES
      || embeddedTotalBytes + blob.size > EXPORT_IMAGE_EMBED_TOTAL_LIMIT_BYTES
    ) {
      image.setAttribute('src', fallbackSrc)
      warnings.push({
        code: 'asset-not-embedded',
        message: 'An image was too large to embed in the exported file',
      })
      continue
    }
    try {
      const dataUrl = await blobToDataUrl(blob)
      embeddedTotalBytes += blob.size
      image.setAttribute('src', dataUrl)
    } catch {
      image.setAttribute('src', fallbackSrc)
      warnings.push({
        code: 'asset-not-embedded',
        message: 'An image could not be embedded in the exported file',
      })
    }
  }

  return { html: template.innerHTML, warnings }
}

function waitForAnimationFrame() {
  // requestAnimationFrame never fires while the page is hidden or
  // rendering is suppressed (automation), which used to hang PDF
  // export forever (UTANG-UJI-07 putaran 2). Race it against a
  // short timer: the frame wait is only a cosmetic yield so the
  // "Preparing PDF" toast can paint before heavy work starts.
  return Promise.race([
    new Promise<void>((resolve) => {
      window.requestAnimationFrame(() => resolve())
    }),
    waitForTimeout(ANIMATION_FRAME_TIMEOUT_MS),
  ])
}

function waitForTimeout(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    window.setTimeout(resolve, timeoutMs)
  })
}

async function waitForImage(image: HTMLImageElement) {
  image.loading = 'eager'

  if (image.complete) {
    return
  }

  await Promise.race([
    new Promise<void>((resolve) => {
      image.onload = () => resolve()
      image.onerror = () => resolve()
    }),
    waitForTimeout(IMAGE_LOAD_TIMEOUT_MS),
  ])
}

async function waitForDocumentResources(frameDocument: Document) {
  await Promise.all(Array.from(frameDocument.images).map(waitForImage))
  // fonts.ready can stay pending forever on a broken font load;
  // race it like the images above (UTANG-UJI-07).
  if (frameDocument.fonts?.ready) {
    await Promise.race([
      frameDocument.fonts.ready,
      waitForTimeout(IMAGE_LOAD_TIMEOUT_MS),
    ])
  }
}

export async function renderMarkdownToHtmlDetailed(
  markdown: string,
  sourcePath?: string,
  signal?: AbortSignal,
) {
  // PB2 BUG2-01: deferImages keeps workspace-relative image
  // references out of rehype-harden (which replaced plain relative
  // names with "[Image blocked: ...]" text) so
  // resolveMarkdownImageSources can embed them, matching the
  // advanced export path.
  const { html, highlightFallback, mermaidFailed } = await renderMarkdownExportFragment(markdown, {
    deferImages: true,
    signal,
    // PB3 BUG2-02: render mermaid fences to SVG in the export.
    // renderMermaid races its frame wait against a timer, and the
    // fragment races each diagram against a timeout, so a stuck
    // diagram degrades to its code block instead of hanging the
    // export (UTANG-UJI-07 pattern).
    renderMermaidDiagram: async (code, diagramSignal) => {
      try {
        return await renderMermaid(code, () => !diagramSignal?.aborted)
      } catch {
        return null
      }
    },
  })
  const resolved = await resolveMarkdownImageSources(sanitizeExportHtml(html), sourcePath)
  const warnings = [...resolved.warnings]
  // DA-6 EXP-05 (area 12): highlightFallback used to be discarded.
  if (highlightFallback) {
    warnings.push({
      code: 'highlight-fallback',
      message: 'Code highlighting fell back to plain text in the exported file',
    })
  }
  // PB3 BUG2-02: diagrams that could not be rendered stay code
  // blocks; warn like the advanced path (export-document.ts)
  // instead of degrading silently. Fully rendered exports carry
  // no warning.
  if ((mermaidFailed ?? 0) > 0) {
    warnings.push({
      code: 'unsupported-content',
      message: 'Mermaid diagrams are preserved as code blocks',
    })
  }
  return { html: resolved.html, warnings }
}

export async function renderMarkdownToHtml(markdown: string, sourcePath?: string) {
  return (await renderMarkdownToHtmlDetailed(markdown, sourcePath)).html
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('Unable to read export asset'))
    reader.readAsDataURL(blob)
  })
}

async function inlineCssAssetUrls(
  css: string,
  baseUrl: string,
  assetCache: Map<string, Promise<string>>,
) {
  const matches = Array.from(css.matchAll(CSS_URL_PATTERN))
  if (matches.length === 0) {
    return css
  }

  let output = ''
  let offset = 0

  for (const match of matches) {
    const index = match.index ?? 0
    const rawUrl = match[2].trim()
    output += css.slice(offset, index)

    if (/^(?:data:|blob:|#)/i.test(rawUrl)) {
      output += match[0]
      offset = index + match[0].length
      continue
    }

    let absoluteUrl: string
    try {
      absoluteUrl = new URL(rawUrl, baseUrl).href
    } catch {
      output += match[0]
      offset = index + match[0].length
      continue
    }

    let dataUrlPromise = assetCache.get(absoluteUrl)
    if (!dataUrlPromise) {
      dataUrlPromise = fetch(absoluteUrl, {
        signal: AbortSignal.timeout(EXPORT_ASSET_FETCH_TIMEOUT_MS),
      })
        .then((response) => {
          if (!response.ok) {
            throw new Error(`Unable to load export asset: ${absoluteUrl}`)
          }
          return response.blob()
        })
        .then(blobToDataUrl)
      assetCache.set(absoluteUrl, dataUrlPromise)
    }

    try {
      output += `url("${await dataUrlPromise}")`
    } catch {
      output += `url("${absoluteUrl}")`
    }
    offset = index + match[0].length
  }

  return output + css.slice(offset)
}

// DA-6 EXP-05 (area 13): cache inlined CSS assets across exports
// (fonts were re-downloaded on every export) and cap the total
// style bytes; beyond the cap the base export styles still apply
// and the caller is warned instead of silently ballooning the file.
const exportStyleAssetCache = new Map<string, Promise<string>>()

async function collectExportStyles() {
  const styleChunks: string[] = []
  let totalBytes = 0
  let truncated = false

  for (const styleSheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(styleSheet.cssRules).map((rule) => rule.cssText).join('\n')
      const inlined = await inlineCssAssetUrls(
        css,
        styleSheet.href || document.baseURI,
        exportStyleAssetCache,
      )
      const bytes = new TextEncoder().encode(inlined).byteLength
      if (totalBytes + bytes > EXPORT_STYLES_BYTE_LIMIT) {
        truncated = true
        continue
      }
      totalBytes += bytes
      styleChunks.push(inlined)
    } catch {
      // Cross-origin stylesheets cannot expose cssRules. Streamdown's local styles remain available.
    }
  }

  styleChunks.push(EXPORT_DOCUMENT_STYLES)
  return { styles: styleChunks.join('\n'), truncated }
}

function getExportDocumentLang(explicitLocale?: string | null) {
  if (explicitLocale) {
    return toHtmlLangTag(explicitLocale)
  }
  const storedLocale = typeof window === 'undefined'
    ? null
    : localStorage.getItem(LANGUAGE_STORAGE_KEY)
  return toHtmlLangTag(normalizeLocale(storedLocale))
}

function buildHtmlDocument(title: string, body: string, styles: string, lang: string) {
  return `<!DOCTYPE html>
<html lang="${escapeHtml(lang)}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${styles}</style>
</head>
<body class="notegen-export">
${body}
</body>
</html>`
}

export async function buildMarkdownExportDocument(source: MarkdownExportSource, options?: MarkdownExportOptions) {
  const fileName = getMarkdownExportBaseName(source.baseName)
  const markdown = await getValue(source.markdown)
  const [rendered, collected] = await Promise.all([
    renderMarkdownToHtmlDetailed(markdown, source.sourcePath, options?.signal),
    collectExportStyles(),
  ])

  const warnings = [...rendered.warnings]
  if (collected.truncated) {
    warnings.push({
      code: 'styles-truncated',
      message: 'Some application styles were omitted from the exported file because of the size limit',
    })
  }
  if (warnings.length > 0) {
    options?.onWarnings?.(warnings)
  }

  return buildHtmlDocument(fileName, rendered.html, collected.styles, getExportDocumentLang(options?.locale))
}

function createPrintFrame(html: string) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.tabIndex = -1
  iframe.style.position = 'fixed'
  iframe.style.left = '-10000px'
  iframe.style.top = '0'
  iframe.style.width = '210mm'
  iframe.style.height = '297mm'
  iframe.style.border = '0'
  iframe.style.pointerEvents = 'none'
  document.body.appendChild(iframe)

  const frameDocument = iframe.contentDocument
  if (!frameDocument) {
    iframe.remove()
    throw new Error('Unable to create the PDF print page')
  }

  frameDocument.open()
  frameDocument.write(html)
  frameDocument.close()

  return iframe
}

async function openTauriPrintWindow(html: string, title: string, outputPath?: string) {
  const documentKey = `document-${crypto.randomUUID()}`
  const windowLabel = `pdf-print-${crypto.randomUUID()}`
  const completionEvent = outputPath ? `pdf-export-result-${crypto.randomUUID()}` : undefined
  const store = await platform.store.load(PRINT_EXPORT_STORE)
  await store.set(documentKey, {
    html,
    outputPath,
    completionEvent,
  } satisfies TauriPrintDocument)
  await store.save()

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false
    let removeCompletionListener: (() => void) | undefined
    const timeout = window.setTimeout(() => {
      void finishWithError(new Error(outputPath ? 'PDF export timed out' : 'The PDF print window timed out while starting'))
    }, outputPath ? DIRECT_PDF_EXPORT_TIMEOUT_MS : PRINT_WINDOW_START_TIMEOUT_MS)

    const removeStoredDocument = async () => {
      await store.delete(documentKey)
      await store.save()
    }

    const finish = (result: boolean) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      removeCompletionListener?.()
      resolve(result)
    }

    const finishWithError = async (reason: unknown) => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      removeCompletionListener?.()
      await removeStoredDocument().catch(() => undefined)
      reject(reason instanceof Error ? reason : new Error(String(reason)))
    }

    void (async () => {
      if (completionEvent) {
        removeCompletionListener = await platform.event.once<{ success: boolean; error?: string }>(completionEvent, (event) => {
          if (event.payload.success) {
            finish(true)
          } else {
            void finishWithError(new Error(event.payload.error || 'Native PDF export failed.'))
          }
        })
      }

      const printWindow = platform.window.createWebviewWindow(windowLabel, {
        url: `/print?key=${encodeURIComponent(documentKey)}`,
        title: outputPath ? `${title} - Exporting PDF` : `${title} - PDF print preview`,
        width: 900,
        height: 700,
        center: true,
        visible: !outputPath,
      })

      await printWindow.once('tauri://created', () => {
        if (!outputPath) finish(true)
      })
      await printWindow.once<string>('tauri://error', (event) => {
        void finishWithError(new Error(`Failed to start the PDF print window: ${event.payload}`))
      })
    })().catch((reason: unknown) => {
      void finishWithError(reason)
    })
  })
}

async function notifyPdfRenderStart(options?: MarkdownExportOptions) {
  options?.onPdfRenderStart?.()
  await waitForAnimationFrame()
}

async function printExportDocument(source: MarkdownExportSource, options?: MarkdownExportOptions) {
  const fileName = getMarkdownExportBaseName(source.baseName)

  // Desktop only: the native print window and the /print route. In web
  // mode the branch below prints the same document with the browser
  // print dialog (window.print on the print frame, "Save as PDF").
  if (checkIsTauri()) {
    let outputPath: string | undefined

    if (platform.os.platform() === 'macos') {
      const selectedPath = await platform.dialog.save({
        title: 'Export PDF',
        defaultPath: `${fileName}.pdf`,
        filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
      })

      if (!selectedPath) return false
      outputPath = ensureExtension(selectedPath, 'pdf')
    }

    await notifyPdfRenderStart(options)
    return await openTauriPrintWindow(
      await buildMarkdownExportDocument(source, options),
      fileName,
      outputPath,
    )
  }

  // Overall deadline for the web branch, mirroring the Tauri
  // DIRECT_PDF_EXPORT_TIMEOUT_MS: a stalled build or resource
  // wait fails with a typed error the caller can surface,
  // instead of hanging after the "Preparing PDF" toast
  // (UTANG-UJI-07). The deadline starts before the render-start
  // notification and stays armed until just before print(), so
  // every await in between is covered (UTANG-UJI-07 putaran 2).
  // DA-6 EXP-04 (area 13): the deadline now also aborts the
  // background render via the signal instead of only rejecting the
  // race at the surface.
  const controller = new AbortController()
  let deadlineTimer: number | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    deadlineTimer = window.setTimeout(
      () => {
        controller.abort()
        reject(new Error('PDF export timed out'))
      },
      DIRECT_PDF_EXPORT_TIMEOUT_MS,
    )
  })
  await Promise.race([notifyPdfRenderStart(options), deadline])
  const html = await Promise.race([
    buildMarkdownExportDocument(source, { ...options, signal: controller.signal }),
    deadline,
  ])

  const iframe = createPrintFrame(html)

  try {
    const frameDocument = iframe.contentDocument
    const printWindow = iframe.contentWindow
    if (!frameDocument || !printWindow || typeof printWindow.print !== 'function') {
      throw new Error('The current platform does not support system PDF printing')
    }

    await Promise.race([waitForDocumentResources(frameDocument), deadline])
    await Promise.race([waitForAnimationFrame(), deadline])
    window.clearTimeout(deadlineTimer)

    let cleanedUp = false
    const cleanup = () => {
      if (cleanedUp) return
      cleanedUp = true
      iframe.remove()
    }

    printWindow.addEventListener('afterprint', cleanup, { once: true })
    window.setTimeout(cleanup, PRINT_FRAME_CLEANUP_DELAY_MS)
    printWindow.focus()
    printWindow.print()
    return true
  } catch (error) {
    iframe.remove()
    throw error
  }
}

export async function exportMarkdownSource(
  format: MarkdownExportFormat,
  source: MarkdownExportSource,
  options?: MarkdownExportOptions,
) {
  const fileName = getMarkdownExportBaseName(source.baseName)

  if (format === 'markdown') {
    return await saveTextExport(
      await getValue(source.markdown),
      `${fileName}.md`,
      'md',
      'text/markdown',
      'Markdown Files',
    )
  }

  if (format === 'html') {
    // DA-6 EXP-01 (area 13): the HTML branch gets the same overall
    // deadline discipline as PDF; the abort signal cancels the
    // background render and style collection work.
    const controller = new AbortController()
    let deadlineTimer: number | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      deadlineTimer = window.setTimeout(() => {
        controller.abort()
        reject(new Error('HTML export timed out'))
      }, HTML_EXPORT_TIMEOUT_MS)
    })
    try {
      const html = await Promise.race([
        buildMarkdownExportDocument(source, { ...options, signal: controller.signal }),
        deadline,
      ])
      return await saveTextExport(
        html,
        `${fileName}.html`,
        'html',
        'text/html',
        'HTML Files',
      )
    } finally {
      window.clearTimeout(deadlineTimer)
    }
  }

  if (format === 'json') {
    // DA-6 EXP-03 (area 12): one basis for every entry point - always
    // parse from markdown with the editor-aligned extension set.
    // Round-tripping markdown is lossy for attributes that never
    // serialize to markdown; that bound is pinned in the spec.
    const jsonContent = getMarkdownManager().parse(await getValue(source.markdown))

    return await saveTextExport(
      JSON.stringify(jsonContent, null, 2),
      `${fileName}.json`,
      'json',
      'application/json',
      'JSON Files',
    )
  }

  return await printExportDocument(source, options)
}

export async function exportMarkdownFile(
  format: MarkdownExportFormat,
  filePath: string,
  options?: MarkdownExportOptions,
) {
  if (options?.flushPendingSave && !await options.flushPendingSave()) {
    throw new Error('UNSAVED_CHANGES')
  }
  const pathOptions = await getFilePathOptions(filePath)
  const readMarkdown = () => (
    pathOptions.baseDir
      ? platform.fs.readTextFile(pathOptions.path, { baseDir: pathOptions.baseDir })
      : platform.fs.readTextFile(pathOptions.path)
  )

  return await exportMarkdownSource(format, {
    baseName: filePath,
    markdown: readMarkdown,
    sourcePath: filePath,
  }, options)
}
