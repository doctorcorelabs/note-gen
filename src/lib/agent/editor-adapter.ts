import type { AgentChange } from './types'
import { buildTextEdits } from './text-diff'

export type EditorTransactionOperation =
  | {
      type: 'replace_lines'
      startLine: number
      endLine: number
      content: string
      preserveListStructure?: boolean
    }
  | {
      type: 'insert_after_line' | 'insert_before_line'
      line: number
      content: string
    }

export interface EditorTransactionInput {
  filePath: string
  version: number
  operations: EditorTransactionOperation[]
}

export type EditorTransactionPreparation =
  | {
      ok: true
      markdown: string
      orderedOperations: EditorTransactionOperation[]
    }
  | {
      ok: false
      error: string
    }

const MAX_EDITOR_TRANSACTION_OPERATIONS = 100

export const EDITOR_EDIT_SKIPPED = 'EDITOR_EDIT_SKIPPED'

export class EditorEditSkipped extends Error {}

/** Keep separate changes local even when insertions change the line count. */
export function buildEditorTextEdits(before: string, after: string) {
  const edits = buildTextEdits(before, after)
  if (before.length > 0 && edits.length === 1 && edits[0].from === 0 && edits[0].to === before.length) {
    throw new EditorEditSkipped('This change was not applied. Split it into local edits.')
  }
  return edits
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function operationIndex(operation: EditorTransactionOperation) {
  if (operation.type === 'replace_lines') {
    return operation.startLine - 1
  }
  return operation.type === 'insert_before_line'
    ? operation.line - 1
    : operation.line
}

/** Keep structural indentation for body-only edits; structural edits opt out. */
export function preserveEditorLineStructure(
  markdown: string,
  startLine: number,
  endLine: number,
  content: string
): string {
  const source = markdown.split('\n')
  const replacement = content.split('\n')
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine)
    || startLine < 1 || endLine < startLine || endLine > source.length) return content

  if (replacement.length !== endLine - startLine + 1) {
    const commonIndent = (lines: string[]) => {
      const prefixes = lines.filter(line => line.trim()).map(line => line.match(/^[ \t]*/)?.[0] ?? '')
      let prefix = prefixes[0] ?? ''
      for (const next of prefixes.slice(1)) {
        while (prefix && !next.startsWith(prefix)) prefix = prefix.slice(0, -1)
      }
      return prefix
    }
    const originalIndent = commonIndent(source.slice(startLine - 1, endLine))
    const replacementIndent = commonIndent(replacement)
    const firstContent = replacement.findIndex(line => line.trim())
    const remainingContent = replacement.slice(firstContent + 1).filter(line => line.trim())
    // Models sometimes omit only the first line's indentation while retaining
    // the source gutter on following lines. Do not add that gutter twice.
    if (originalIndent && !replacementIndent && firstContent >= 0
      && remainingContent.length > 0 && remainingContent.every(line => line.startsWith(originalIndent))) {
      replacement[firstContent] = originalIndent + replacement[firstContent]
      return replacement.join('\n')
    }
    return replacement.map(line => line.trim()
      ? originalIndent + line.slice(replacementIndent.length)
      : line).join('\n')
  }

  let fence: { marker: string; length: number } | undefined
  const preserveIndentation = (index: number) => {
    if (index < startLine - 1) return
    const offset = index - startLine + 1
    if (source[index].trim() && replacement[offset].trim()) {
      replacement[offset] = (source[index].match(/^[ \t]*/)?.[0] ?? '') + replacement[offset].trimStart()
    }
  }
  for (let index = 0; index < endLine; index += 1) {
    const line = source[index]
    const delimiter = /^\s*(`{3,}|~{3,})(.*)$/.exec(line)
    if (delimiter) {
      if (!fence) fence = { marker: delimiter[1][0], length: delimiter[1].length }
      else if (delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length
        && !delimiter[2].trim()) fence = undefined
      preserveIndentation(index)
      continue
    }
    if (fence) {
      // Fenced code also carries the outer list's structural indentation.
      // Preserve whitespace without interpreting code as Markdown list items.
      preserveIndentation(index)
      continue
    }
    if (index < startLine - 1) continue
    const offset = index - startLine + 1
    const original = /^([ \t]*)(\d+[.)]|[-+*])([ \t]+)(.*)$/.exec(line)
    const modified = /^([ \t]*)(\d+[.)]|[-+*])([ \t]+)(.*)$/.exec(replacement[offset])
    if (original && modified && original[2] === modified[2]) {
      replacement[offset] = original[1] + original[2] + original[3] + modified[4]
    } else if (!original && !modified && line.trim() && replacement[offset].trim()) {
      // Table rows, formula bodies and continuation paragraphs belong to their
      // surrounding list by indentation even though they have no list marker.
      preserveIndentation(index)
    }
  }
  return replacement.join('\n')
}

export function prepareEditorLineTransaction(
  markdown: string,
  inputOperations: unknown[]
): EditorTransactionPreparation {
  const totalLines = markdown.split('\n').length

  if (inputOperations.length === 0) {
    return { ok: false, error: 'operations must contain at least one edit operation.' }
  }
  if (inputOperations.length > MAX_EDITOR_TRANSACTION_OPERATIONS) {
    return {
      ok: false,
      error: `A single edit allows at most ${MAX_EDITOR_TRANSACTION_OPERATIONS} operations.`,
    }
  }

  const operations: EditorTransactionOperation[] = []
  const replacedRanges: Array<{ startLine: number; endLine: number }> = []
  const insertionBoundaries: number[] = []

  for (const [index, rawOperation] of inputOperations.entries()) {
    if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
      return { ok: false, error: `Operation ${index + 1} must be an object.` }
    }

    const operation = rawOperation as Record<string, unknown>
    if (typeof operation.content !== 'string') {
      return { ok: false, error: `Operation ${index + 1} is missing a string content.` }
    }

    if (operation.type === 'replace_lines') {
      if (!isInteger(operation.startLine) || !isInteger(operation.endLine)) {
        return { ok: false, error: `Operation ${index + 1} (replace_lines) must provide integer startLine/endLine.` }
      }
      const startLine = operation.startLine
      const endLine = operation.endLine
      if (
        startLine < 1 ||
        endLine < startLine ||
        endLine > totalLines
      ) {
        return {
          ok: false,
          error: `Operation ${index + 1} line numbers out of range: ${startLine}-${endLine}; the document has ${totalLines} lines in total.`,
        }
      }

      const overlaps = replacedRanges.some((range) =>
        startLine <= range.endLine && endLine >= range.startLine
      )
      if (overlaps) {
        return { ok: false, error: `Operation ${index + 1} overlaps another replacement range.` }
      }

      replacedRanges.push({ startLine, endLine })
      operations.push({
        type: 'replace_lines',
        startLine,
        endLine,
        content: operation.preserveListStructure === false
          ? operation.content
          : preserveEditorLineStructure(markdown, startLine, endLine, operation.content),
        preserveListStructure: operation.preserveListStructure !== false,
      })
      continue
    }

    if (operation.type === 'insert_before_line' || operation.type === 'insert_after_line') {
      if (!isInteger(operation.line)) {
        return { ok: false, error: `Operation ${index + 1} (insert) must provide an integer line.` }
      }
      const lineIsValid = operation.type === 'insert_before_line'
        ? operation.line >= 1 && operation.line <= totalLines
        : operation.line >= 0 && operation.line <= totalLines
      if (!lineIsValid) {
        return {
          ok: false,
          error: `Operation ${index + 1} (insert) line number out of range: ${operation.line}; the document has ${totalLines} lines in total.`,
        }
      }

      const boundary = operation.type === 'insert_before_line'
        ? operation.line - 1
        : operation.line
      if (insertionBoundaries.includes(boundary)) {
        return { ok: false, error: `Operation ${index + 1} uses the same position as another insert operation.` }
      }
      insertionBoundaries.push(boundary)
      operations.push({
        type: operation.type,
        line: operation.line,
        content: operation.content,
      })
      continue
    }

    return {
      ok: false,
      error: `Operation ${index + 1} has an invalid type. editor_apply_transaction only supports line-level replacement and insertion.`,
    }
  }

  for (const boundary of insertionBoundaries) {
    const conflictsWithReplacement = replacedRanges.some((range) =>
      boundary > range.startLine - 1 && boundary < range.endLine
    )
    if (conflictsWithReplacement) {
      return { ok: false, error: 'The insert position must not be inside a replacement range of the same transaction.' }
    }
  }

  const orderedOperations = [...operations].sort((left, right) =>
    operationIndex(right) - operationIndex(left)
    || (left.type === 'replace_lines' ? -1 : right.type === 'replace_lines' ? 1 : 0)
  )
  const lines = markdown.split('\n')

  for (const operation of orderedOperations) {
    const replacementLines = operation.content.split('\n')
    if (operation.type === 'replace_lines') {
      lines.splice(
        operation.startLine - 1,
        operation.endLine - operation.startLine + 1,
        ...replacementLines
      )
      continue
    }

    const insertionIndex = operation.type === 'insert_before_line'
      ? operation.line - 1
      : operation.line
    lines.splice(insertionIndex, 0, ...replacementLines)
  }

  return {
    ok: true,
    markdown: lines.join('\n'),
    orderedOperations,
  }
}

export function buildEditorChange(target: string, before: string | undefined, after: string | undefined): AgentChange {
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    type: 'editor',
    target,
    before,
    after,
    reversible: true,
    summary: 'Editor content updated',
  }
}
