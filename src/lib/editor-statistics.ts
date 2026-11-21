export interface EditorStatistics {
  characters: number
  readingMinutes: number
}

export { markdownToPlainText } from './markdown-to-plain-text'

export function getEditorStatistics(text: string): EditorStatistics {
  const normalizedText = text.trim()
  if (!normalizedText) {
    return {
      characters: 0,
      readingMinutes: 0,
    }
  }

  const characters = Array.from(normalizedText).length
  const cjkCharacters = normalizedText.match(/\p{Script=Han}/gu)?.length ?? 0
  const nonCjkWords = normalizedText
    .replace(/\p{Script=Han}/gu, ' ')
    .match(/[\p{L}\p{N}]+(?:['’_-][\p{L}\p{N}]+)*/gu)?.length ?? 0
  const readingMinutes = Math.max(1, Math.ceil((cjkCharacters / 300) + (nonCjkWords / 200)))

  return {
    characters,
    readingMinutes,
  }
}

// Leaf text for the visual-mode character basis (UTANG-UJI-08):
// atom/leaf nodes carry their countable text in attributes, not in
// node text. The source basis (markdownToPlainText) counts fence
// contents and image alt text, so the visual basis must count the
// same: mermaid code (attrs.code) and image alt (attrs.alt). Every
// other leaf counts 0.
export function editorLeafText(node: {
  type: { name: string }
  attrs?: Record<string, unknown>
}): string {
  if (node.type.name === "mermaidDiagram") {
    return typeof node.attrs?.code === "string" ? node.attrs.code : ""
  }
  if (node.type.name === "image") {
    return typeof node.attrs?.alt === "string" ? node.attrs.alt : ""
  }
  return ""
}
