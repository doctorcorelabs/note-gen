import { Node } from '@tiptap/core'
import { RAW_HTML_NODE_NAME, rawHtmlTokenizer } from './raw-html-tokenizer'

/** Keep raw HTML blocks and comments in the document byte for byte while
 * the normal Markdown nodes around them remain fully editable. Visual
 * mode shows the preserved source as read-only text: the block cannot be
 * edited in place, and deleting it means editing in source mode, so a
 * stray keypress can never silently drop markup that the DOM parser
 * would otherwise discard. Source mode still exposes the actual
 * Markdown, including these blocks, without an editor-only format.
 */
export const RawHtml = Node.create({
  name: RAW_HTML_NODE_NAME,
  group: 'block',
  atom: true,
  selectable: false,
  draggable: false,
  isolating: true,

  addAttributes() {
    return { raw: { default: '', rendered: false } }
  },

  parseHTML() {
    return [{
      tag: 'div[data-notegen-raw-html]',
      getAttrs: element => {
        const raw = element.getAttribute('data-notegen-raw-html') || ''
        const token = rawHtmlTokenizer.tokenize(raw, [], {
          inlineTokens: () => [], blockTokens: () => [],
        })
        return token && token.raw === raw ? { raw } : false
      },
    }]
  },

  renderHTML({ node }) {
    return ['div', {
      'data-notegen-raw-html': node.attrs.raw,
      contenteditable: 'false',
    }]
  },

  renderText() { return '' },

  addNodeView() {
    return ({ node }) => {
      const raw = typeof node.attrs.raw === 'string' ? node.attrs.raw : ''
      const dom = document.createElement('div')
      dom.setAttribute('data-notegen-raw-html', raw)
      dom.contentEditable = 'false'
      dom.style.border = '1px dashed GrayText'
      dom.style.borderRadius = '6px'
      dom.style.padding = '6px 8px'
      dom.style.margin = '4px 0'
      dom.style.overflowX = 'auto'
      const label = document.createElement('div')
      label.textContent = 'HTML'
      label.style.fontSize = '11px'
      label.style.letterSpacing = '0.08em'
      label.style.color = 'GrayText'
      label.style.marginBottom = '4px'
      const pre = document.createElement('pre')
      pre.textContent = raw
      pre.style.margin = '0'
      pre.style.whiteSpace = 'pre-wrap'
      pre.style.wordBreak = 'break-word'
      pre.style.fontSize = '12px'
      pre.style.fontFamily = 'ui-monospace, monospace'
      dom.appendChild(label)
      dom.appendChild(pre)
      return { dom, ignoreMutation: () => true, stopEvent: () => true }
    }
  },

  markdownTokenName: RAW_HTML_NODE_NAME,
  markdownTokenizer: rawHtmlTokenizer,
  parseMarkdown: token => ({ type: RAW_HTML_NODE_NAME, attrs: { raw: token.raw || '' } }),
  renderMarkdown: node => typeof node.attrs?.raw === 'string' ? node.attrs.raw : '',
})
