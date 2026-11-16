import { platform, BaseDirectory } from '@/lib/platform'
import { inspectChatImage, type ImageInspectionCrop } from '@/lib/chat-image-context'
import { skillManager } from '@/lib/skills/manager'
import { getSkillWorkspaceIdentity } from '@/lib/skills/runtime'
import { getWorkspacePath } from '@/lib/workspace'
import type { AgentTool, AgentToolResult } from '../types'

const MAX_TEXT_BYTES = 100 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const IMAGE_MIME_TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
}
const TEXT_EXTENSIONS = new Set([
  'md', 'txt', 'xml', 'xsd', 'xsl', 'xslt', 'rels', 'json', 'jsonl', 'ipynb',
  'yaml', 'yml', 'toml', 'html', 'htm', 'css', 'svg', 'csv', 'tsv',
  'log', 'tex', 'bib', 'ini', 'conf', 'cfg',
])

class ArtifactAccessError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

interface ResolvedArtifact {
  path: string
  baseDir?: BaseDirectory
  relativePath: string
  name: string
  extension: string
  workspaceIdentity: string
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ArtifactAccessError('ARTIFACT_INSPECTION_CANCELLED', 'Artifact reading or inspection was cancelled.')
}

function normalizeArtifactPath(skillId: string, path: unknown): string[] {
  if (typeof path !== 'string' || !path || path.length > 2048 || /[\0:]/.test(path)) {
    throw new ArtifactAccessError('ARTIFACT_INVALID_PATH', 'Provide a relative path inside the Skill output directory.')
  }
  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/')
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new ArtifactAccessError('ARTIFACT_INVALID_PATH', 'The artifact path must not contain absolute paths, empty directories, or parent directories.')
  }
  if (segments[0] === 'article' && segments[1] === 'outputs') segments.shift()
  if (segments[0] === 'outputs') {
    if (segments[1] !== skillId || segments.length < 3) {
      throw new ArtifactAccessError('ARTIFACT_OUTSIDE_SKILL_OUTPUT', 'Only artifacts in the current Skill output directory can be read.')
    }
    return segments
  }
  return ['outputs', skillId, ...segments]
}

async function resolveArtifact(skillId: unknown, path: unknown, expectedWorkspaceIdentity?: string): Promise<ResolvedArtifact> {
  if (typeof skillId !== 'string' || skillId.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillId)) {
    throw new ArtifactAccessError('ARTIFACT_INVALID_SKILL', 'skill_id must be the exact identifier of an installed Skill.')
  }
  const workspace = await getWorkspacePath()
  const workspaceIdentity = getSkillWorkspaceIdentity(workspace)
  if (expectedWorkspaceIdentity !== undefined && workspaceIdentity !== expectedWorkspaceIdentity) {
    throw new ArtifactAccessError('WORKSPACE_CHANGED', 'The workspace has changed. Re-check the artifact in the original workspace.')
  }
  const skill = skillManager.getSkill(skillId)
  if (!skill || skill.metadata.enabled === false) {
    throw new ArtifactAccessError('ARTIFACT_SKILL_UNAVAILABLE', 'This Skill is not installed or has been disabled.')
  }
  const segments = normalizeArtifactPath(skillId, path)
  // Capture the actual workspace once. Never resolve artifacts against the
  // default AppData/article root when a custom workspace is active.
  const workspaceRoot = workspace.isCustom ? workspace.path : 'article'
  const baseDir = workspace.isCustom ? undefined : BaseDirectory.AppData
  const fsOptions = baseDir ? { baseDir } : undefined
  const rootInfo = await platform.fs.lstat(workspaceRoot, fsOptions)
  if (rootInfo.isSymlink || !rootInfo.isDirectory) {
    throw new ArtifactAccessError('ARTIFACT_SYMLINK_BLOCKED', 'The workspace must be a real directory.')
  }
  let targetPath = workspaceRoot
  for (let index = 0; index < segments.length; index += 1) {
    targetPath = await platform.path.join(targetPath, segments[index])
    const info = await platform.fs.lstat(targetPath, fsOptions)
    if (info.isSymlink) {
      throw new ArtifactAccessError('ARTIFACT_SYMLINK_BLOCKED', 'The artifact path must not pass through a symbolic link.')
    }
    const last = index === segments.length - 1
    if (last ? !info.isFile : !info.isDirectory) {
      throw new ArtifactAccessError('ARTIFACT_NOT_REGULAR_FILE', 'The artifact must be a regular file in the output directory.')
    }
  }
  const name = segments[segments.length - 1]
  return {
    path: targetPath,
    baseDir,
    relativePath: segments.join('/'),
    name,
    extension: name.split('.').pop()?.toLowerCase() || '',
    workspaceIdentity,
  }
}

async function assertArtifactWorkspace(artifact: ResolvedArtifact): Promise<void> {
  if (getSkillWorkspaceIdentity(await getWorkspacePath()) !== artifact.workspaceIdentity) {
    throw new ArtifactAccessError('WORKSPACE_CHANGED', 'The workspace changed during artifact inspection, so the operation was cancelled.')
  }
}

async function readArtifactBytes(artifact: ResolvedArtifact, maxBytes: number, signal?: AbortSignal) {
  throwIfAborted(signal)
  await assertArtifactWorkspace(artifact)
  const handle = await platform.fs.open(artifact.path, { read: true, baseDir: artifact.baseDir })
  try {
    const info = await handle.stat()
    if (!info.isFile || info.size > maxBytes) {
      throw new ArtifactAccessError('ARTIFACT_SIZE_LIMIT', `The artifact exceeds this tool's read limit of ${Math.floor(maxBytes / 1024)} KiB.`)
    }
    const buffer = new Uint8Array(Math.min(info.size + 1, maxBytes + 1))
    let size = 0
    while (size < buffer.length) {
      throwIfAborted(signal)
      const count = await handle.read(buffer.subarray(size))
      if (!count) break
      size += count
    }
    if (size > maxBytes || size > info.size) {
      throw new ArtifactAccessError('ARTIFACT_CHANGED', 'The artifact changed while being read. Retry after generation finishes.')
    }
    throwIfAborted(signal)
    await assertArtifactWorkspace(artifact)
    return buffer.slice(0, size)
  } finally {
    await handle.close()
  }
}

function parseCrop(value: unknown): ImageInspectionCrop | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ArtifactAccessError('ARTIFACT_INVALID_CROP', 'crop must include x, y, width, and height in the range 0 to 1.')
  }
  const crop = value as Partial<ImageInspectionCrop>
  const { x, y, width, height } = crop
  if (typeof x !== 'number' || typeof y !== 'number' || typeof width !== 'number' || typeof height !== 'number'
    || ![x, y, width, height].every(Number.isFinite)
    || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) {
    throw new ArtifactAccessError('ARTIFACT_INVALID_CROP', 'crop must be a valid normalized rectangle inside the image.')
  }
  return { x, y, width, height }
}

async function imageDataUrl(bytes: Uint8Array, mimeType: string): Promise<string> {
  // inspectChatImage accepts data URLs or conversation-assets paths, but not
  // convertFileSrc URLs. Encode the validated original bytes without writing
  // a second image or broadening that helper's filesystem access.
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string'
      ? resolve(reader.result)
      : reject(new Error('The artifact image could not be encoded.'))
    reader.onerror = () => reject(reader.error || new Error('The artifact image could not be encoded.'))
    reader.readAsDataURL(new Blob([new Uint8Array(bytes)], { type: mimeType }))
  })
}

function artifactFailure(error: unknown): AgentToolResult {
  return {
    ok: false,
    message: error instanceof Error ? error.message : String(error),
    error: error instanceof ArtifactAccessError ? error.code : 'ARTIFACT_READ_FAILED',
  }
}

const skillInspectArtifactTool: AgentTool = {
  name: 'skill_inspect_artifact',
  title: 'Inspect Skill artifact page',
  description: 'Visually inspect an existing PNG, JPEG, WebP, GIF, or BMP page generated under outputs/<skill_id>/ in the current workspace. Use after rendering a PDF or Word document. OCR alone does not complete visual layout verification. No arbitrary local paths or symbolic links are allowed.',
  category: 'skill',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Exact installed Skill ID.' },
      path: { type: 'string', description: 'Existing workspace-relative outputs/<skill_id>/... image path, or a path relative to that Skill output directory.' },
      prompt: { type: 'string', description: 'Specific visual checks, such as clipped text, overflowing tables, alignment, page breaks, or unreadable fonts.' },
      crop: {
        type: 'object',
        description: 'Optional image region using normalized 0-1 coordinates.',
        properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
    },
    required: ['skill_id', 'path', 'prompt'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    try {
      const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : ''
      if (!prompt || prompt.length > 8000) {
        throw new ArtifactAccessError('ARTIFACT_INVALID_PROMPT', 'Provide specific page inspection requirements (max 8000 characters).')
      }
      const crop = parseCrop(input.crop)
      const artifact = await resolveArtifact(input.skill_id, input.path, context.workspaceIdentity)
      const mimeType = IMAGE_MIME_TYPES[artifact.extension]
      if (!mimeType) throw new ArtifactAccessError('ARTIFACT_NOT_IMAGE', 'Render the document to a PNG, JPEG, WebP, GIF, or BMP page first, then inspect the existing image.')
      const bytes = await readArtifactBytes(artifact, MAX_IMAGE_BYTES, context.signal)
      const result = await inspectChatImage({
        id: `skill-artifact:${String(input.skill_id)}:${artifact.relativePath}`,
        url: await imageDataUrl(bytes, mimeType),
        name: artifact.name,
      }, prompt, context.signal, crop)
      throwIfAborted(context.signal)
      await assertArtifactWorkspace(artifact)
      const visuallyInspected = !!result.visualAnalysis?.trim()
      const data = {
        skill_id: input.skill_id,
        path: artifact.relativePath,
        method: result.method,
        visuallyInspected,
        width: result.width,
        height: result.height,
        crop,
        ocrText: result.ocrText,
        visualAnalysis: result.visualAnalysis,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
      }
      if (!visuallyInspected) {
        return {
          ok: false,
          message: `Visual inspection incomplete: ${result.errorMessage || 'The vision model did not return a valid page analysis.'} OCR text is only for cross-checking and cannot confirm the layout is correct.`,
          error: result.errorCode === 'not_configured'
            ? 'VISION_MODEL_NOT_CONFIGURED'
            : result.errorCode ? `ARTIFACT_VISUAL_${result.errorCode.toUpperCase()}` : 'ARTIFACT_VISUAL_ANALYSIS_UNAVAILABLE',
          data,
        }
      }
      return { ok: true, message: `Inspected artifact page ${artifact.relativePath}. Judge layout issues from the returned visual analysis.`, data }
    } catch (error) {
      return artifactFailure(error)
    }
  },
}

const skillReadArtifactTool: AgentTool = {
  name: 'skill_read_artifact',
  title: 'Read Skill text artifact',
  description: 'Read an existing UTF-8 text, XML, JSON, Markdown, or other supported text artifact under outputs/<skill_id>/ in the current workspace. Limited to 100 KiB. Binary documents must first be extracted or converted using the document runtime.',
  category: 'skill',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      skill_id: { type: 'string', description: 'Exact installed Skill ID.' },
      path: { type: 'string', description: 'Existing workspace-relative outputs/<skill_id>/... text path, or a path relative to that Skill output directory.' },
    },
    required: ['skill_id', 'path'],
    additionalProperties: false,
  },
  execute: async (input, context) => {
    try {
      const artifact = await resolveArtifact(input.skill_id, input.path, context.workspaceIdentity)
      if (!TEXT_EXTENSIONS.has(artifact.extension)) {
        throw new ArtifactAccessError('ARTIFACT_NOT_TEXT', 'This artifact is not a supported text format and cannot be read as UTF-8 text.')
      }
      const bytes = await readArtifactBytes(artifact, MAX_TEXT_BYTES, context.signal)
      const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      if (content.includes('\0')) throw new ArtifactAccessError('ARTIFACT_NOT_TEXT', 'The artifact contains binary data and cannot be read as text.')
      return {
        ok: true,
        message: `Read text artifact ${artifact.relativePath}.`,
        data: { skill_id: input.skill_id, path: artifact.relativePath, content, bytes: bytes.length, truncated: false },
      }
    } catch (error) {
      return artifactFailure(error)
    }
  },
}

export const skillArtifactTools: AgentTool[] = [skillInspectArtifactTool, skillReadArtifactTool]
