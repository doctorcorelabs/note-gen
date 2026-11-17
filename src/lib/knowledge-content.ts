import { platform, BaseDirectory } from '@/lib/platform'
import { createHash } from 'crypto'
import { getCanvasProject, getCanvasProjects } from '@/db/canvases'
import { getAllMarks, getMarkById, type Mark } from '@/db/marks'
import { getTags, type Tag } from '@/db/tags'
import { recordMatchesTag, recordTagIds } from '@/lib/record-tags'
import { getFilePathOptions } from '@/lib/workspace'
import type { CanvasDocument, CanvasProject } from '@/types/canvas'
import {
  createKnowledgeSourceKey,
  parseKnowledgeSourceKey,
  type KnowledgeChunk,
  type KnowledgeSourceDocument,
} from '@/types/knowledge'

export function hashKnowledgeContent(content: string): string {
  return createHash('sha256').update(content.trim()).digest('hex')
}

function recordTitle(mark: Mark) {
  return (mark.desc || mark.content || mark.url || `${mark.type} #${mark.id}`)
    .trim()
    .split('\n')[0]
    .slice(0, 120)
}

function serializeRecord(mark: Mark, tagName: string) {
  return [
    `Record: ${recordTitle(mark)}`,
    `Type: ${mark.type}`,
    `Tags: ${tagName}`,
    `Created: ${new Date(mark.createdAt).toISOString()}`,
    mark.desc ? `Description: ${mark.desc}` : '',
    mark.content ? `Content:\n${mark.content}` : '',
    mark.url ? `Link or file: ${mark.url}` : '',
  ].filter(Boolean).join('\n')
}

export async function getRecordKnowledgeDocument(mark: Mark, availableTags?: Tag[]): Promise<KnowledgeSourceDocument | null> {
  if (mark.deleted === 1) return null
  const tags = availableTags ?? await getTags()
  const tagName = recordTagIds(mark)
    .map(tagId => tags.find(tag => tag.id === tagId)?.name || String(tagId))
    .join('、')
  const content = serializeRecord(mark, tagName)
  const sourceKey = createKnowledgeSourceKey('record', mark.id)
  const { chunkText } = await import('@/lib/rag')
  return {
    sourceKey,
    sourceType: 'record',
    sourceId: String(mark.id),
    title: recordTitle(mark),
    content,
    contentHash: hashKnowledgeContent(content),
    updatedAt: mark.createdAt,
    locator: { markId: mark.id, tagId: mark.tagId, tagIds: tags.filter(tag => recordMatchesTag(mark, tag.id, tags)).map(tag => tag.id) },
    status: 'pending',
    chunks: chunkText(content).map(chunk => ({ content: chunk })),
  }
}

function semanticCanvasNodes(document: CanvasDocument) {
  return document.nodes.filter(node => (
    node.type !== 'freehand'
    && Boolean(node.data.label || node.data.description || node.data.url || node.data.filePath)
  ))
}

function serializeCanvasNode(project: CanvasProject, nodeId: string): KnowledgeChunk | null {
  const node = project.document.nodes.find(item => item.id === nodeId)
  if (!node || node.type === 'freehand') return null
  const incoming = project.document.edges.filter(edge => edge.target === node.id)
  const outgoing = project.document.edges.filter(edge => edge.source === node.id)
  const nodeName = (id: string) => {
    const target = project.document.nodes.find(item => item.id === id)
    return target?.data.label || id
  }
  const content = [
    `Canvas: ${project.title}`,
    `Node: ${node.data.label || node.id}`,
    `Node type: ${node.type}`,
    node.data.description ? `Description: ${node.data.description}` : '',
    node.data.url ? `Link: ${node.data.url}` : '',
    node.data.filePath ? `Linked file: ${node.data.filePath}` : '',
    ...incoming.map(edge => `Incoming edge: ${nodeName(edge.source)} --${edge.label || 'link'}--> ${node.data.label || node.id}`),
    ...outgoing.map(edge => `Outgoing edge: ${node.data.label || node.id} --${edge.label || 'link'}--> ${nodeName(edge.target)}`),
  ].filter(Boolean).join('\n')
  return content.trim() ? { content, nodeId: node.id } : null
}

export function serializeCanvasDocument(project: CanvasProject) {
  const nodes = semanticCanvasNodes(project.document)
  const nodeLines = nodes.map(node => [
    `- [${node.id}] ${node.data.label || node.id}（${node.type}）`,
    node.data.description ? `：${node.data.description}` : '',
  ].join(''))
  const edgeLines = project.document.edges.map(edge => {
    const source = project.document.nodes.find(node => node.id === edge.source)
    const target = project.document.nodes.find(node => node.id === edge.target)
    return `- ${source?.data.label || edge.source} --${edge.label || 'link'}--> ${target?.data.label || edge.target}`
  })
  return [
    `# Canvas: ${project.title}`,
    `Type: ${project.canvasType}`,
    '',
    '## Nodes',
    ...nodeLines,
    '',
    '## Explicit edges',
    ...(edgeLines.length ? edgeLines : ['None']),
  ].join('\n')
}

export async function getCanvasKnowledgeDocument(project: CanvasProject): Promise<KnowledgeSourceDocument | null> {
  if (project.deletedAt) return null
  const content = serializeCanvasDocument(project)
  const chunks = semanticCanvasNodes(project.document)
    .map(node => serializeCanvasNode(project, node.id))
    .filter((chunk): chunk is KnowledgeChunk => Boolean(chunk))
  if (chunks.length === 0) chunks.push({ content })
  return {
    sourceKey: createKnowledgeSourceKey('canvas', project.id),
    sourceType: 'canvas',
    sourceId: project.id,
    title: project.title,
    content,
    contentHash: hashKnowledgeContent(content),
    updatedAt: project.updatedAt,
    locator: { canvasId: project.id },
    status: 'pending',
    chunks,
  }
}

export async function getArticleKnowledgeDocument(filePath: string): Promise<KnowledgeSourceDocument | null> {
  try {
    const options = await getFilePathOptions(filePath)
    const content = options.baseDir === undefined
      ? await platform.fs.readTextFile(options.path)
      : await platform.fs.readTextFile(options.path, { baseDir: options.baseDir || BaseDirectory.AppData })
    const { chunkText } = await import('@/lib/rag')
    return {
      sourceKey: createKnowledgeSourceKey('article', filePath),
      sourceType: 'article',
      sourceId: filePath,
      title: filePath.replace(/\\/g, '/').split('/').pop() || filePath,
      content,
      contentHash: hashKnowledgeContent(content),
      updatedAt: Date.now(),
      locator: { filePath },
      status: 'pending',
      chunks: chunkText(content).map(chunk => ({ content: chunk })),
    }
  } catch {
    return null
  }
}

export async function getKnowledgeSourceDocument(sourceKey: string): Promise<KnowledgeSourceDocument | null> {
  const parsed = parseKnowledgeSourceKey(sourceKey)
  if (!parsed) return null
  if (parsed.sourceType === 'record') {
    const id = Number(parsed.sourceId)
    // Portable Wiki identities are UUIDs, never local SQLite row numbers.
    if (!/^\d+$/.test(parsed.sourceId) || !Number.isSafeInteger(id) || id <= 0) return null
    const mark = await getMarkById(id)
    return mark ? getRecordKnowledgeDocument(mark) : null
  }
  if (parsed.sourceType === 'canvas') {
    const project = await getCanvasProject(parsed.sourceId)
    return project ? getCanvasKnowledgeDocument(project) : null
  }
  return getArticleKnowledgeDocument(parsed.sourceId)
}

export async function collectRecordKnowledgeDocuments() {
  const [marks, tags] = await Promise.all([getAllMarks(), getTags()])
  const documents = await Promise.all(marks.map(mark => getRecordKnowledgeDocument(mark, tags)))
  return documents.filter((document): document is KnowledgeSourceDocument => Boolean(document))
}

export async function collectCanvasKnowledgeDocuments() {
  const projects = await getCanvasProjects()
  const documents = await Promise.all(projects.map(getCanvasKnowledgeDocument))
  return documents.filter((document): document is KnowledgeSourceDocument => Boolean(document))
}
