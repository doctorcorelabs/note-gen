import type { MarkdownTokenizer } from '@tiptap/core'
import { wikiMetadataTokenizer } from './wiki-metadata-tokenizer'

export const RAW_HTML_NODE_NAME = 'rawHtml'

// Block-level tag names from the CommonMark HTML block start conditions
// (type 6). Inline-only tags (kbd, span, a, em, br, img, code) are
// deliberately absent: a paragraph that starts with inline markup must
// keep parsing as a paragraph.
const BLOCK_TAG_NAMES = [
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'search',
  'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead',
  'title', 'tr', 'track', 'ul',
]

const BLOCK_TAG_ALTERNATION = BLOCK_TAG_NAMES.join('|')
const BLOCK_TAG_START = new RegExp(`^</?(?:${BLOCK_TAG_ALTERNATION})(?:[\\s/>]|$)`, 'i')
const RAW_HTML_LINE_START = new RegExp(`^(?:<!--|<!|<\\?|</?(?:${BLOCK_TAG_ALTERNATION})(?:[\\s/>]|$))`, 'im')
const TYPE1_TAG_START = /^<(script|pre|style|textarea)(?:[\s/>]|$)/i
const BLANK_LINE = /\r?\n[ \t]*\r?\n|\r?\n[ \t]*$/

function blankLineRaw(source: string): string | undefined {
  const blank = BLANK_LINE.exec(source)
  const raw = blank ? source.slice(0, blank.index) : source
  return raw.replace(/\r?\n$/, '') || undefined
}

/** Match one raw HTML block at the start of `source`, or return undefined.
 * Comments, processing instructions, CDATA sections, and declarations match
 * as single constructs. A block-level element runs until the next blank line
 * (CommonMark HTML blocks type 6/7), except script/pre/style/textarea, which
 * run until their closing tag even across blank lines (type 1).
 */
export function matchRawHtmlBlock(source: string): string | undefined {
  if (source.startsWith('<!--')) {
    const end = source.indexOf('-->', 4)
    return end === -1 ? undefined : source.slice(0, end + 3)
  }
  if (source.startsWith('<?')) {
    const end = source.indexOf('?>', 2)
    return end === -1 ? undefined : source.slice(0, end + 2)
  }
  if (source.startsWith('<![CDATA[')) {
    const end = source.indexOf(']]>', 9)
    return end === -1 ? undefined : source.slice(0, end + 3)
  }
  if (source.startsWith('<!')) {
    const end = source.indexOf('>')
    return end === -1 ? undefined : source.slice(0, end + 1)
  }
  const type1 = TYPE1_TAG_START.exec(source)
  if (type1) {
    const close = new RegExp(`</${type1[1]}>`, 'i').exec(source)
    if (close) return source.slice(0, close.index + close[0].length)
    // Unclosed type 1 block: keep the blank-line fallback, same as type 6.
    return blankLineRaw(source)
  }
  if (!BLOCK_TAG_START.test(source)) return undefined
  return blankLineRaw(source)
}

/** Raw HTML blocks and comments are opaque to Markdown. The DOM parser
 * behind visual mode drops comments and elements unknown to the schema
 * without any warning (DA10-F02), so one edit plus autosave could delete
 * them silently. This tokenizer claims them before the built-in HTML
 * handling, following the wiki metadata pattern, so the exact source
 * bytes survive a visual save. Inline HTML inside a paragraph is not
 * claimed here: only block-position HTML reaches this tokenizer.
 */
export const rawHtmlTokenizer: MarkdownTokenizer = {
  name: RAW_HTML_NODE_NAME,
  level: 'block',
  start: source => RAW_HTML_LINE_START.exec(source)?.index ?? -1,
  tokenize: (source, tokens, helpers) => {
    // Wiki metadata is more specific than raw HTML: a wiki section marker
    // is an HTML comment, and frontmatter keeps its own node. Defer to it.
    if (wikiMetadataTokenizer.tokenize(source, tokens, helpers)) return undefined
    const raw = matchRawHtmlBlock(source)
    return raw ? { type: RAW_HTML_NODE_NAME, raw, text: raw, tokens: [] } : undefined
  },
}
