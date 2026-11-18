import type { MarkdownTokenizer } from '@tiptap/core'

export const WIKI_METADATA_NODE_NAME = 'wikiMetadata'
export const WIKI_METADATA_REPLACE_DOCUMENT = 'notegen-wiki-replace-document'

const FRONTMATTER = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/
const SECTION_MARKER = /^<!-- notegen-wiki:[a-f0-9]{64}:[a-z0-9-]+:(?:start|end) -->(?=\r?\n|$)/

/** Reserved Wiki metadata and generic leading frontmatter are opaque to
 * Markdown. In particular, the raw block must never be parsed as prose,
 * a horizontal rule, or HTML that the DOM discards.
 */
export const wikiMetadataTokenizer: MarkdownTokenizer = {
  name: WIKI_METADATA_NODE_NAME,
  level: 'block',
  start: source => {
    const match = /^(?:(?:\uFEFF)?---\r?$|<!-- notegen-wiki:[a-f0-9]{64}:[a-z0-9-]+:(?:start|end) -->\r?$)/m.exec(source)
    return match?.index ?? -1
  },
  tokenize: source => {
    const frontmatter = FRONTMATTER.exec(source)
    // Any leading frontmatter is opaque: the visual serializer rewrites
    // headings as ATX and drops the closing fence, so generic YAML would
    // be destroyed by one edit plus autosave (S-P0-19 / DA10-F01). A
    // wiki-origin header is a subset of this rule, not a special case.
    const header = frontmatter?.[0]
    const raw = header ?? SECTION_MARKER.exec(source)?.[0]
    return raw ? { type: WIKI_METADATA_NODE_NAME, raw, text: raw, tokens: [] } : undefined
  },
}
