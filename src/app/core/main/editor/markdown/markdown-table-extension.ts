// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// DA-6 EXP-03 (area 12): the editor table extensions live here so the
// export MarkdownManager can use the exact same schema and markdown
// handlers as the editor. Previously they were private to
// tiptap-editor.tsx, so JSON export parsed tables with a smaller
// extension set than the editor schema.

import type { JSONContent } from '@tiptap/core'
import { renderTableToMarkdown, Table } from '@tiptap/extension-table'
import { TableCell } from '@tiptap/extension-table-cell'
import { TableHeader } from '@tiptap/extension-table-header'

function promoteFirstTableRowInMarkdown(node: JSONContent): JSONContent {
  const [firstRow, ...remainingRows] = node.content ?? []
  if (!firstRow?.content?.length) return node

  const hasHeader = firstRow.content.some(cell => cell.type === 'tableHeader')
  if (hasHeader) return node

  return {
    ...node,
    content: [
      {
        ...firstRow,
        content: firstRow.content.map(cell => (
          cell.type === 'tableCell' ? { ...cell, type: 'tableHeader' } : cell
        )),
      },
      ...remainingRows,
    ],
  }
}

export const MarkdownTable = Table.extend({
  parseMarkdown: (token, helpers) => {
    const tableToken = token as {
      header?: Array<{ tokens: import('@tiptap/core').MarkdownToken[] }>
      rows?: Array<Array<{ tokens: import('@tiptap/core').MarkdownToken[] }>>
      align?: Array<string | null>
    }
    const alignmentForColumn = (index: number) => {
      const alignment = tableToken.align?.[index]
      return alignment === 'left' || alignment === 'center' || alignment === 'right' ? alignment : null
    }
    const rows: JSONContent[] = []

    if (tableToken.header) {
      rows.push(helpers.createNode('tableRow', {}, tableToken.header.map((cell, index) => (
        helpers.createNode('tableHeader', { align: alignmentForColumn(index) }, [
          { type: 'paragraph', content: helpers.parseInline(cell.tokens) },
        ])
      ))))
    }

    tableToken.rows?.forEach(row => {
      rows.push(helpers.createNode('tableRow', {}, row.map((cell, index) => (
        helpers.createNode('tableCell', { align: alignmentForColumn(index) }, [
          { type: 'paragraph', content: helpers.parseInline(cell.tokens) },
        ])
      ))))
    })

    return helpers.createNode('table', undefined, rows)
  },
  renderMarkdown: (node, helpers) => {
    const promotedNode = promoteFirstTableRowInMarkdown(node)
    // Preserve cell breaks before the table renderer collapses whitespace.
    const markdown = renderTableToMarkdown(promotedNode, {
      ...helpers,
      renderChildren: (children, separator) => {
        if (!Array.isArray(children) && children.type === 'paragraph' && !children.content?.length) {
          return ''
        }
        return helpers.renderChildren(children, separator).replace(/ {2}\n|\n/g, '<br>')
      },
    }, { cellLineSeparator: '<br>' })
    const columnCount = Math.max(0, ...(promotedNode.content ?? []).map(row => row.content?.length ?? 0))
    if (columnCount === 0) return markdown

    const alignments = Array.from({ length: columnCount }, (_, columnIndex) => {
      for (const row of promotedNode.content ?? []) {
        const alignment = row.content?.[columnIndex]?.attrs?.align
        if (alignment === 'left' || alignment === 'center' || alignment === 'right') return alignment
      }
      return null
    })
    if (alignments.every(alignment => alignment === null)) return markdown

    const lines = markdown.split('\n')
    lines[2] = `| ${alignments.map(alignment => (
      alignment === 'left' ? ':---' : alignment === 'center' ? ':---:' : alignment === 'right' ? '---:' : '---'
    )).join(' | ')} |`
    return lines.join('\n')
  },
})

function addTableCellAlignment() {
  return {
    align: {
      default: null,
      parseHTML: (element: HTMLElement) => {
        const value = element.getAttribute('data-align') ?? element.style.textAlign
        return value === 'left' || value === 'center' || value === 'right' ? value : null
      },
      renderHTML: (attributes: { align?: string | null }) => (
        attributes.align === 'left' || attributes.align === 'center' || attributes.align === 'right'
          ? { 'data-align': attributes.align }
          : {}
      ),
    },
  }
}

export const MarkdownTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...addTableCellAlignment() }
  },
})

export const MarkdownTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...addTableCellAlignment() }
  },
})
