import { buildEditorTextEdits, EDITOR_EDIT_SKIPPED, EditorEditSkipped } from './editor-adapter'
import type OpenAI from 'openai'
import { takeToolDisplayTitle } from './tool-display'
import { createAssistantToolCallMessage, createChatCompletionStreamWithToolChoiceFallback, createOpenAIClient, getAISettings, getChatTokenLimitParams, getSystemPromptContent, handleAIError, validateAIService, withFastAiRequestOptions } from '@/lib/ai/utils'
import { estimateTokens } from '@/lib/ai/token-counter'
import { AgentContextManager } from './context-manager'
import { agentEventBus } from './event-bus'
import { AgentPermissionEngine } from './permission-engine'
import { AgentPromptAssembler, hasInlineCurrentEditorSelection, hasInlineCurrentEditorState } from './prompt-assembler'
import { memoryContextService } from '@/lib/context/loader'
import { AgentRecoveryManager } from './recovery-manager'
import { PendingMessageQueue } from './pending-message-queue'
import { createAgentId, AgentTraceRecorder } from './trace-recorder'
import { agentToolRegistry, buildEditorApprovalPreview, hasFileEditPreview, validateEditApprovalPreview, LOADED_SKILL_TOOL_NAMES } from './tool-registry'
import { skillManager } from '@/lib/skills'
import { getSkillWorkspaceIdentity } from '@/lib/skills/runtime'
import { getWorkspacePath } from '@/lib/workspace'
import { buildMcpAgentToolCatalog } from '@/lib/mcp/agent-tools'
import { agentDebugLog, agentDebugText, isAgentDebugEnabled, previewText } from './debug-log'
import { getRagAgentPolicy } from '@/lib/rag-agent-policy'
import { WebSearchBudget } from './web-search-budget'
import { parseKnowledgeSourceKey, type KnowledgeWikiPageGrant } from '@/types/knowledge'
import { getChatResponseText, parseChatResponseSpec } from '@/lib/chat-ui/response-catalog'
import { createChatResponseStream } from '@/lib/chat-ui/response-stream'
import type {
  AgentChange,
  AgentContextSnapshot,
  AgentPermissionMode,
  AgentRuntimeCallbacks,
  AgentRuntimeInput,
  AgentRuntimeResult,
  AgentSteeringPayload,
  AgentStep,
  AgentTool,
  AgentToolResult,
  AgentToolExecutionContext,
  ToolCall,
  ToolResult,
} from './types'

const ABSOLUTE_MAX_MODEL_ROUNDS = 30
const MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS = 2
const MAX_IDENTICAL_READ_RESULT_REPEATS = 2
const STREAM_RENDER_INTERVAL_MS = 33
const MUTATING_TOOL_RISKS = new Set(['editor-write', 'file-create', 'file-update', 'delete', 'medium'])

export function isRequestAbortError(error: unknown) {
  if (typeof error === 'string') {
    return /(?:request (?:was )?aborted|operation (?:was )?aborted|aborterror)/i.test(error)
  }

  if (!error || typeof error !== 'object') {
    return false
  }

  const errorWithCode = error as { name?: string; code?: string; message?: string }
  return errorWithCode.name === 'AbortError'
    || errorWithCode.code === 'ABORT_ERR'
    || /(?:request (?:was )?aborted|operation (?:was )?aborted|aborterror)/i.test(errorWithCode.message || '')
}

async function executeAgentTool(
  tool: AgentTool,
  args: Record<string, unknown>,
  runId: string,
  signal: AbortSignal | undefined,
  context: AgentContextSnapshot,
  requestUserQuestion?: AgentToolExecutionContext['requestUserQuestion'],
  workspaceIdentity?: string,
  requestUserInteraction?: AgentToolExecutionContext['requestUserInteraction'],
): Promise<AgentToolResult> {
  try {
    return await tool.execute(args, { runId, signal, context, requestUserQuestion, requestUserInteraction, workspaceIdentity })
  } catch (error) {
    if (isRequestAbortError(error)) {
      throw error
    }

    const message = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      message: `${tool.title} threw an exception while running: ${message}`,
      error: message,
    }
  }
}

function parseToolArguments(rawArguments: string | undefined): Record<string, unknown> {
  if (!rawArguments || !rawArguments.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(rawArguments)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {}
  } catch (error) {
    throw new Error(`Invalid tool arguments JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toolResultToLegacy(result: AgentToolResult): ToolResult {
  return {
    success: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    changes: result.changes,
  }
}

function stringifyToolResult(result: AgentToolResult) {
  const payload = {
    ok: result.ok,
    message: result.message,
    data: result.data,
    error: result.error,
    changes: result.changes,
    wikiPages: result.wikiPages?.map(page => ({ pageId: page.pageId, title: page.title,
      excerpt: page.excerpt, sourceCount: page.sourceRefs.length,
      relevanceScore: page.relevanceScore, updatedAt: page.updatedAt })),
  }

  return JSON.stringify(payload)
}

function stringifyMessageContent(content: unknown) {
  if (typeof content === 'string') {
    return content
  }

  if (content === null || content === undefined) {
    return ''
  }

  try {
    return JSON.stringify(content)
  } catch {
    return String(content)
  }
}

function normalizeBaseMessage(message: OpenAI.Chat.ChatCompletionMessageParam): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'system') {
    return message
  }

  return {
    role: 'user',
    content: `## App Context\n${stringifyMessageContent(message.content)}`,
  }
}

interface StreamingToolCallAccumulator {
  id?: string
  index: number
  type?: 'function'
  function: {
    name: string
    arguments: string
  }
}

function toToolCallList(
  toolCalls: Map<number, StreamingToolCallAccumulator>
): OpenAI.Chat.ChatCompletionMessageToolCall[] {
  return [...toolCalls.values()]
    .sort((a, b) => a.index - b.index)
    .filter((toolCall) => toolCall.function.name)
    .map((toolCall) => ({
      id: toolCall.id || createAgentId('tool-call'),
      type: 'function' as const,
      function: {
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      },
    }))
}

function resolveStreamingToolCallIndex(
  toolCalls: Map<number, StreamingToolCallAccumulator>,
  toolCall: OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta.ToolCall
) {
  if (Number.isInteger(toolCall.index)) {
    return toolCall.index
  }

  if (toolCall.id) {
    const existing = [...toolCalls.entries()].find(([, current]) => current.id === toolCall.id)
    if (existing) {
      return existing[0]
    }
    const indexes = [...toolCalls.keys()]
    return indexes.length > 0 ? Math.max(...indexes) + 1 : 0
  }

  const indexes = [...toolCalls.keys()]
  return indexes.length > 0 ? Math.max(...indexes) : 0
}

function summarizeMessage(message: OpenAI.Chat.ChatCompletionMessageParam, index: number) {
  const content = 'content' in message ? message.content : undefined
  const text = stringifyMessageContent(content)

  return {
    index,
    role: message.role,
    contentLength: text.length,
    preview: previewText(text),
  }
}

function estimateMessageTextTokens(message: OpenAI.Chat.ChatCompletionMessageParam) {
  if (!('content' in message)) {
    return 0
  }

  if (typeof message.content === 'string') {
    return estimateTokens(message.content)
  }

  if (!Array.isArray(message.content)) {
    return 0
  }

  return message.content.reduce((sum, item) => {
    if (
      typeof item === 'object'
      && item !== null
      && 'type' in item
      && item.type === 'text'
      && 'text' in item
      && typeof item.text === 'string'
    ) {
      return sum + estimateTokens(item.text)
    }
    return sum
  }, 0)
}

function normalizeFilePathForCompare(filePath: string) {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').trim()
}

function rewriteWorkspaceReadAsAttachmentRead(
  toolCall: OpenAI.Chat.ChatCompletionMessageToolCall,
  context: AgentContextSnapshot
) {
  const folderAttachments = (context.attachments || []).filter((attachment) => attachment.kind === 'folder')
  if (toolCall.function.name === 'note_list_files' && folderAttachments.length === 1) {
    return {
      ...toolCall,
      function: {
        name: 'attachment_list',
        arguments: JSON.stringify({ attachmentId: folderAttachments[0].id }),
      },
    } satisfies OpenAI.Chat.ChatCompletionMessageToolCall
  }

  if (toolCall.function.name !== 'note_open_file' && toolCall.function.name !== 'note_read_file') {
    return toolCall
  }

  let args: Record<string, unknown>
  try {
    args = parseToolArguments(toolCall.function.arguments)
  } catch {
    return toolCall
  }

  const requestedPath = typeof args.filePath === 'string'
    ? normalizeFilePathForCompare(args.filePath)
    : ''
  const requestedName = requestedPath.split('/').pop()?.toLocaleLowerCase() || ''
  if (!requestedName) return toolCall

  const matches = (context.attachments || []).filter((attachment) =>
    attachment.kind === 'file'
    && attachment.name.toLocaleLowerCase() === requestedName
  )
  if (matches.length === 1) {
    return {
      ...toolCall,
      function: {
        name: 'attachment_read',
        arguments: JSON.stringify({ attachmentId: matches[0].id }),
      },
    } satisfies OpenAI.Chat.ChatCompletionMessageToolCall
  }

  if (folderAttachments.length === 1) {
    const folder = folderAttachments[0]
    const folderPrefix = `${folder.name.toLocaleLowerCase()}/`
    const relativePath = requestedPath.toLocaleLowerCase().startsWith(folderPrefix)
      ? requestedPath.slice(folder.name.length + 1)
      : requestedPath
    return {
      ...toolCall,
      function: {
        name: 'attachment_read',
        arguments: JSON.stringify({ attachmentId: folder.id, relativePath }),
      },
    } satisfies OpenAI.Chat.ChatCompletionMessageToolCall
  }

  return toolCall
}

function repairAttachmentToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  context: AgentContextSnapshot
) {
  if (toolName !== 'attachment_list' && toolName !== 'attachment_read') {
    return args
  }

  const attachments = context.attachments || []
  const requestedAttachmentId = typeof args.attachmentId === 'string' ? args.attachmentId : ''
  if (attachments.some((attachment) => attachment.id === requestedAttachmentId)) {
    return args
  }

  const relativePath = typeof args.relativePath === 'string' ? args.relativePath : ''
  const hasRelativePaths = Array.isArray(args.relativePaths) && args.relativePaths.length > 0
  const candidates = toolName === 'attachment_list' || relativePath || hasRelativePaths
    ? attachments.filter((attachment) => attachment.kind === 'folder')
    : attachments.filter((attachment) => attachment.kind === 'file')

  if (candidates.length !== 1) {
    return args
  }

  return {
    ...args,
    attachmentId: candidates[0].id,
  }
}

function getNumberArg(args: Record<string, unknown>, key: string) {
  const value = args[key]
  return typeof value === 'number' ? value : undefined
}

function claimsUserNoteEvidence(content: string) {
  const positiveAttribution = /根据(?:您|你).{0,12}(?:知识库|笔记|记录|文章|画布)|(?:according to|based on).{0,24}(?:your|the user's).{0,16}(?:knowledge base|notes?|records?|articles?|canvases?)|(?:あなた|ユーザー).{0,16}(?:ナレッジベース|ノート|記録)|segundo.{0,24}(?:suas?|os seus).{0,16}(?:notas?|registros?)/i
  const unsupportedAbsence = /(?:(?:知识库|笔记|记录|文章|画布|记忆|当前对话|上下文).{0,24}(?:没有|未找到|找不到|不存在|无法确认|不能确认)|(?:没有|未找到|找不到|无法).{0,24}(?:知识库|笔记|记录|文章|画布|记忆|当前对话|上下文))|(?:(?:could not|couldn't|did not|didn't|no).{0,24}(?:find|confirm|evidence).{0,24}(?:knowledge base|notes?|records?|articles?|canvases?|memory|conversation|context))|(?:(?:ナレッジベース|ノート|記録|メモリ|会話|コンテキスト).{0,24}(?:見つかりません|確認できません))|(?:(?:não|nenhum).{0,24}(?:encontrei|confirmar).{0,24}(?:notas?|registros?|memória|conversa|contexto))/i
  return positiveAttribution.test(content) || unsupportedAbsence.test(content)
}

function explicitlyRequestsKnowledgeLookup(content: string) {
  return /(?:(?:只|仅|只从|仅从|不要查(?:其他|其它|别的)).{0,12}(?:知识库|笔记|记录|文章|画布)|(?:知识库|笔记|记录|文章|画布).{0,12}(?:里|中|内).{0,8}(?:找|查|搜索|检索))|(?:(?:only|exclusively).{0,16}(?:knowledge base|notes?|records?|articles?|canvases?))/i.test(content)
}

function requestsSavedPersonalFact(content: string) {
  return /(?:我的|我(?:之前|上次|曾经|过去)).{1,24}(?:是(?:什么|多少|哪|谁)?|叫什么|多少|何时|什么时候|哪天|在哪里|地址|号码|编号|计划|决定|偏好|习惯)(?:[？?]|$)/i.test(content)
    || /(?:what|which|when|where|who).{0,16}(?:is|was|are|were).{0,12}my\b/i.test(content)
}

function validateQuotedEditorWrite(
  context: AgentContextSnapshot,
  toolName: string,
  args: Record<string, unknown>
): AgentToolResult | null {
  const quote = context.currentQuote
  if (!quote) {
    return null
  }

  const hasExactRange = quote.from >= 0 && quote.to >= quote.from
  const hasExactLines = quote.startLine >= 1 && quote.endLine >= quote.startLine
  const editorWriteTools = new Set([
    'editor_insert_at_cursor',
    'editor_replace_range',
    'editor_replace_lines',
    'editor_apply_transaction',
  ])

  if (editorWriteTools.has(toolName)) {
    const quotePath = quote.articlePath
    const activeFilePath = context.activeFilePath
    if (
      !quotePath
      || !activeFilePath
      || normalizeFilePathForCompare(quotePath) !== normalizeFilePathForCompare(activeFilePath)
    ) {
      return {
        ok: false,
        message: 'The quoted content does not belong to the currently active editor. Reopen and quote the target file before editing.',
        error: 'QUOTED_EDITOR_TARGET_CHANGED',
      }
    }
  }

  if (!hasExactRange && !hasExactLines && editorWriteTools.has(toolName)) {
    if (
      toolName === 'editor_insert_at_cursor'
      && args.replaceSelection === true
      && typeof quote.fullContent === 'string'
      && typeof quote.selectionToken === 'string'
    ) {
      return null
    }
    return {
      ok: false,
      message: 'The selected text can be read now, but it cannot be safely mapped to a Markdown source position. Only use editor_insert_at_cursor with replaceSelection=true; if the selection has changed, the operation will fail automatically.',
      error: 'SELECTION_TARGET_UNAVAILABLE',
    }
  }

  if (toolName === 'editor_replace_range' && hasExactRange) {
    const from = getNumberArg(args, 'from')
    const to = getNumberArg(args, 'to')
    if (from !== quote.from || to !== quote.to) {
      return {
        ok: false,
        message: `Tool arguments out of bounds: the current request can only replace the user selection from=${quote.from}, to=${quote.to}. Retry with this exact range.`,
        error: 'INVALID_QUOTED_RANGE',
      }
    }
  }

  return null
}

function validateEditorTargetFile(
  context: AgentContextSnapshot,
  tool: AgentTool,
  args: Record<string, unknown>
): AgentToolResult | null {
  if (tool.category !== 'editor' || tool.risk === 'read') {
    return null
  }

  const activeFilePath = context.activeFilePath
  const targetFilePath = typeof args.filePath === 'string' ? args.filePath : ''

  if (!activeFilePath) {
    return {
      ok: false,
      message: 'No editor file is open, so editor_* write tools cannot run. Use note_* tools with an explicit filePath instead.',
      error: 'EDITOR_TOOL_WITHOUT_ACTIVE_FILE',
    }
  }

  if (!targetFilePath) {
    return {
      ok: false,
      message: `editor_* write tools must declare the target file in the structured filePath argument. The current editor file is ${activeFilePath}; retry with this full path.`,
      error: 'EDITOR_TOOL_MISSING_TARGET_FILE',
    }
  }

  if (normalizeFilePathForCompare(targetFilePath) === normalizeFilePathForCompare(activeFilePath)) {
    return null
  }

  return {
    ok: false,
    message: `The target file in the tool arguments is ${targetFilePath}, but the current editor file is ${activeFilePath}. Do not use editor_* tools; use note_read_file and note_update_file for the target file instead.`,
    error: 'EDITOR_TOOL_WRONG_TARGET_FILE',
  }
}

function validateToolInputShape(tool: AgentTool, args: Record<string, unknown>): AgentToolResult | null {
  const properties = tool.inputSchema.properties || {}
  const allowedKeys = new Set(Object.keys(properties))
  const unknownKeys = Object.keys(args).filter((key) => !allowedKeys.has(key))
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      message: `The tool arguments contain undeclared fields: ${unknownKeys.join(', ')}. Only use the arguments from the structured tool definition.`,
      error: 'UNKNOWN_TOOL_ARGUMENTS',
    }
  }

  const missingKeys = (tool.inputSchema.required || []).filter((key) =>
    args[key] === undefined || args[key] === null
  )
  if (missingKeys.length > 0) {
    return {
      ok: false,
      message: `The tool call is missing required arguments: ${missingKeys.join(', ')}.`,
      error: 'MISSING_TOOL_ARGUMENTS',
    }
  }

  return null
}

function preserveOriginalMarkdownPrefix(
  context: AgentContextSnapshot,
  lineNumber: number,
  content: string
) {
  if (content.includes('\n')) {
    return content
  }

  const numberedLine = context.currentEditorState?.numberedLines
    .split('\n')
    .find((line) => new RegExp(`^\\s*${lineNumber}\\s*\\|`).test(line))
  const originalLine = numberedLine?.replace(/^\s*\d+\s*\|\s?/, '') || ''
  const originalPrefix = originalLine.match(/^(\s*#{1,6}\s+)/)?.[1]
  const replacementHasPrefix = /^\s*#{1,6}\s+/.test(content)
  const requestsPlainText = /(?:改为|改成|转换为|变成).*(?:正文|普通文本|段落|plain\s+text|paragraph)/i
    .test(context.userInput)

  return originalPrefix && !replacementHasPrefix && !requestsPlainText
    ? `${originalPrefix}${content}`
    : content
}

function repairEditorWriteArgs(
  toolName: string,
  args: Record<string, unknown>,
  context: AgentContextSnapshot
): Record<string, unknown> {
  const editorToolsWithTarget = new Set([
    'editor_insert_at_cursor',
    'editor_replace_range',
    'editor_replace_lines',
    'editor_apply_transaction',
  ])
  const editorToolsWithVersion = new Set([
    'editor_replace_range',
    'editor_replace_lines',
    'editor_apply_transaction',
  ])
  let repairedArgs = args

  if (
    editorToolsWithTarget.has(toolName) &&
    (typeof repairedArgs.filePath !== 'string' || !repairedArgs.filePath.trim()) &&
    context.activeFilePath
  ) {
    repairedArgs = {
      ...repairedArgs,
      filePath: context.activeFilePath,
    }
  }

  if (
    editorToolsWithVersion.has(toolName) &&
    typeof repairedArgs.version !== 'number' &&
    typeof context.currentEditorState?.version === 'number'
  ) {
    repairedArgs = {
      ...repairedArgs,
      version: context.currentEditorState.version,
    }
  }

  if (
    toolName === 'editor_replace_lines' &&
    Number.isInteger(repairedArgs.startLine) &&
    repairedArgs.startLine === repairedArgs.endLine &&
    typeof repairedArgs.replaceContent === 'string'
  ) {
    const replaceContent = preserveOriginalMarkdownPrefix(
      context,
      repairedArgs.startLine as number,
      repairedArgs.replaceContent
    )
    if (replaceContent !== repairedArgs.replaceContent) {
      repairedArgs = { ...repairedArgs, replaceContent }
    }
  }

  if (toolName !== 'editor_apply_transaction' || !Array.isArray(repairedArgs.operations)) {
    return repairedArgs
  }

  let repaired = false
  const operations = repairedArgs.operations.map((rawOperation) => {
    if (!rawOperation || typeof rawOperation !== 'object' || Array.isArray(rawOperation)) {
      return rawOperation
    }

    const operation = rawOperation as Record<string, unknown>
    if (
      operation.type === 'insert_after_line' &&
      !Number.isInteger(operation.line) &&
      Number.isInteger(context.currentEditorState?.totalLines)
    ) {
      repaired = true
      return {
        ...operation,
        line: context.currentEditorState?.totalLines,
      }
    }

    if (
      operation.type === 'insert_before_line' &&
      !Number.isInteger(operation.line)
    ) {
      repaired = true
      return {
        ...operation,
        line: 1,
      }
    }

    if (
      operation.type === 'replace_lines' &&
      Number.isInteger(operation.startLine) &&
      operation.startLine === operation.endLine &&
      typeof operation.content === 'string'
    ) {
      const content = preserveOriginalMarkdownPrefix(
        context,
        operation.startLine as number,
        operation.content
      )
      if (content !== operation.content) {
        repaired = true
        return { ...operation, content }
      }
      return rawOperation
    }

    if (operation.type !== 'replace_range') {
      return rawOperation
    }

    const startLine = Number.isInteger(operation.startLine)
      ? operation.startLine
      : operation.from
    const endLine = Number.isInteger(operation.endLine)
      ? operation.endLine
      : operation.to
    let content = typeof operation.content === 'string'
      ? operation.content
      : operation.replaceContent

    if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || typeof content !== 'string') {
      return rawOperation
    }

    if (startLine === endLine) {
      content = preserveOriginalMarkdownPrefix(context, startLine as number, content)
    }

    repaired = true
    return {
      type: 'replace_lines',
      startLine,
      endLine,
      content,
    }
  })

  return repaired ? { ...repairedArgs, operations } : repairedArgs
}

function selectToolsForContext(
  context: AgentContextSnapshot,
  tools: AgentTool[],
  permissionMode: AgentPermissionMode = 'ask'
) {
  let selectedTools = tools

  if (permissionMode === 'read-only') {
    selectedTools = selectedTools.filter((tool) =>
      tool.risk === 'read' || tool.risk === 'external'
    )
  }

  if (!context.activeFilePath) {
    selectedTools = selectedTools.filter((tool) => tool.category !== 'editor')
  }

  if (!context.activeCanvasId) {
    selectedTools = selectedTools.filter((tool) => tool.category !== 'canvas')
  }

  if (!context.attachments?.length) {
    selectedTools = selectedTools.filter((tool) => tool.category !== 'attachment')
  }

  if (!context.imageAttachments?.length) {
    selectedTools = selectedTools.filter((tool) => tool.category !== 'image')
  }

  return selectedTools
}

function buildStep(tool: AgentTool, input: Record<string, unknown>, result: AgentToolResult, duration: number): AgentStep {
  return {
    thought: `${tool.title}`,
    action: {
      tool: tool.name,
      params: input,
    },
    observation: result.message,
    duration,
  }
}

function isMutatingTool(tool: AgentTool) {
  return MUTATING_TOOL_RISKS.has(tool.risk)
}

function guardsFailedToolCall(tool: AgentTool) {
  return isMutatingTool(tool) || tool.risk === 'script' || tool.risk === 'skill-install'
}

function getReadToolCallSignature(tool: AgentTool, args: Record<string, unknown>) {
  if (tool.risk !== 'read') {
    return undefined
  }

  return `${tool.name}:${JSON.stringify(args)}`
}

function isEditorStateStaleResult(tool: AgentTool, result: AgentToolResult) {
  if (result.ok || !isMutatingTool(tool)) {
    return false
  }

  return /content has changed|editor content.*changed|内容已变化|版本.*(?:变化|不匹配)/i.test(
    `${result.error || ''}\n${result.message || ''}`
  )
}

export class AgentRuntime {
  private readonly contextManager = new AgentContextManager()
  private readonly promptAssembler = new AgentPromptAssembler()
  private readonly permissionEngine = new AgentPermissionEngine()
  private readonly recoveryManager = new AgentRecoveryManager()
  private abortController: AbortController | null = null
  private stopped = false
  private steeringRequested = false
  private readonly steeringQueue = new PendingMessageQueue<AgentSteeringPayload>(
    'one-at-a-time',
    (left, right) => left.sequence - right.sequence
  )

  stop() {
    this.stopped = true
    this.steeringQueue.clear()
    this.steeringRequested = false
    this.abortController?.abort()
  }

  steer(payload: AgentSteeringPayload) {
    if (this.stopped) return
    this.steeringRequested = true
    this.steeringQueue.enqueue(payload)
  }

  clearSteeringQueue() {
    this.steeringQueue.clear()
    this.steeringRequested = false
  }

  removeSteering(sequence: number) {
    this.steeringQueue.remove(payload => payload.sequence === sequence)
    this.steeringRequested = this.steeringQueue.hasItems()
  }

  async run(input: AgentRuntimeInput, callbacks: AgentRuntimeCallbacks = {}): Promise<AgentRuntimeResult> {
    this.stopped = false
    this.abortController = new AbortController()

    const recorder = new AgentTraceRecorder()
    const runId = recorder.getRunId()
    const steps: AgentStep[] = []
    const toolCalls: ToolCall[] = []
    const changes: AgentChange[] = []
    const runWorkspaceIdentity = getSkillWorkspaceIdentity(await getWorkspacePath())
    const assertRunWorkspace = async () => {
      if (getSkillWorkspaceIdentity(await getWorkspacePath()) !== runWorkspaceIdentity) {
        throw new Error('WORKSPACE_CHANGED: The workspace has changed and this task has stopped. Start a new request in the target workspace.')
      }
    }

    const context: AgentContextSnapshot = {
      activeChatId: input.activeChatId,
      activeFilePath: input.activeFilePath,
      activeCanvasId: input.activeCanvasId,
      currentEditorState: input.currentEditorState,
      userInput: input.userInput,
      currentQuote: input.currentQuote,
      availableSkills: input.availableSkills,
      selectedSkills: input.selectedSkills,
      selectedMcpServerIds: input.selectedMcpServerIds,
      attachments: input.attachments,
      imageAttachments: input.imageAttachments,
    }

    // A supplied turn snapshot must outlive changes to the global model picker.
    const aiConfig = input.aiConfig ?? await getAISettings()
    const validatedBaseURL = await validateAIService(aiConfig?.baseURL)
    if (!aiConfig || validatedBaseURL === null) {
      agentDebugLog('ai_service_invalid', { runId })
      return {
        runId,
        content: '',
        stopped: false,
        steps,
        toolCalls,
        changes,
        trace: recorder.all(),
      }
    }

    const mcpToolCatalog = buildMcpAgentToolCatalog(input.selectedMcpServerIds)

    agentDebugLog('run_start', {
      runId,
      activeChatId: input.activeChatId,
      activeFilePath: input.activeFilePath || null,
      activeCanvasId: input.activeCanvasId || null,
      userInput: input.userInput,
      imageCount: input.imageUrls?.length || 0,
      hasQuote: Boolean(input.currentQuote),
      hasEditorState: Boolean(input.currentEditorState),
      availableSkillCount: input.availableSkills?.length || 0,
      selectedSkills: input.selectedSkills || [],
      directMcpToolCount: mcpToolCatalog.directTools.length,
      deferredMcpToolCount: mcpToolCatalog.deferredEntries.length,
      mcpSchemaTokens: mcpToolCatalog.schemaTokens,
    })

    const ragAgentPolicy = await getRagAgentPolicy()
    const allTools = [...agentToolRegistry.listTools(), ...mcpToolCatalog.directTools]
      .filter(tool =>
        (ragAgentPolicy.automaticSearchEnabled || tool.name !== 'knowledge_search')
        && (aiConfig.enableWebSearch === true || tool.category !== 'web')
      )
    const toolMap = new Map(allTools.map((tool) => [tool.name, tool]))
    let tools = selectToolsForContext(context, allTools, input.permissionMode)
    const customSystemPrompt = await getSystemPromptContent()
    let memoryContext = input.useMemories === false
      ? {
          memories: [],
          usedTokens: 0,
          policyEnabled: false,
          workspaceId: input.workspaceId || 'default',
        }
      : await memoryContextService.getMemoryContext({
          query: input.userInput,
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
        })
    let systemPrompt = this.promptAssembler.assemble(
      context,
      tools,
      customSystemPrompt,
      memoryContextService.formatMemoryContext(memoryContext)
    )
    const baseMessages = this.contextManager.prepareMessages(input.messages || [])
      .map(normalizeBaseMessage)

    const currentUserMessage = await this.contextManager.buildCurrentUserMessage(
      input.userInput,
      input.imageUrls
    )

    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: systemPrompt },
      ...baseMessages,
      currentUserMessage,
    ]

    agentDebugLog('context_prepared', {
      runId,
      systemPromptLength: systemPrompt.length,
      systemPromptTokens: estimateTokens(systemPrompt),
      toolCount: tools.length,
      rawMessageCount: input.messages?.length || 0,
      preparedMessageCount: messages.length,
      preparedMessageTextTokens: messages.reduce(
        (sum, message) => sum + estimateMessageTextTokens(message),
        0
      ),
      currentImageCount: input.imageUrls?.length || 0,
      appContextMessageCount: baseMessages.filter((message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.startsWith('## App Context')
      ).length,
      messages: messages.map(summarizeMessage),
    })
    callbacks.onStatus?.('preparing_context')

    const client = await createOpenAIClient(aiConfig)
    let editorStateReadLocked = hasInlineCurrentEditorState(context)
    let lastLoggedEditorContext: string | undefined
    let editorSelectionReadLocked = hasInlineCurrentEditorSelection(context)
    let finalContent = ''
    let writeActionCompleted = false
    const readToolResultHistory = new Map<string, {
      result: string
      repeatCount: number
    }>()
    const failedToolResultHistory = new Map<string, {
      result: string
      repeatCount: number
    }>()
    const successfulMutationCalls = new Set<string>()
    const toolResultEvidence = new Set<string>()
    const webSearchBudget = new WebSearchBudget()
    let knowledgeSearchCount = 0
    const readKnowledgeSourceKeys = new Set<string>()
    const originalSourceGrants = new Set<string>()
    const readWikiPageIds = new Set<string>()
    const readEvidenceSourceKeys = new Set<string>()
    const wikiPageGrants = new Map<string, KnowledgeWikiPageGrant[]>()
    const knowledgeReadLimit = ragAgentPolicy.strategy === 'fast'
      ? 1
      : ragAgentPolicy.strategy === 'deep' ? 5 : 3
    let directAnswerEvidenceChecked = false
    let knowledgeCitationChecked = false
    const isExplicitSource = (sourceKey: string) => {
      const source = parseKnowledgeSourceKey(sourceKey)
      if (source?.sourceType === 'canvas') return source.sourceId === context.activeCanvasId
      if (source?.sourceType !== 'article') return false
      const normalize = (path: string) => path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/')
      return [context.activeFilePath, context.currentQuote?.articlePath]
        .some(path => typeof path === 'string' && normalize(path) === normalize(source.sourceId))
    }
    const executeToolWithBudget = async (
      tool: AgentTool,
      args: Record<string, unknown>
    ): Promise<AgentToolResult> => {
      await assertRunWorkspace()
      if (tool.name === 'web_search') {
        const blockedResult = webSearchBudget.startSearch()
        if (blockedResult) return blockedResult
      }
      if (tool.name === 'knowledge_search') {
        if (knowledgeSearchCount >= ragAgentPolicy.maxSearchRounds) {
          return {
            ok: false,
            message: `This task has reached the knowledge search limit of ${ragAgentPolicy.maxSearchRounds} rounds allowed by the "${ragAgentPolicy.strategy}" strategy. Complete the answer from the evidence already gathered.`,
            error: 'KNOWLEDGE_SEARCH_BUDGET_EXHAUSTED',
          }
        }
        knowledgeSearchCount += 1
      }
      if (tool.name === 'knowledge_read_sources') {
        const requests = Array.isArray(args.requests) ? args.requests : []
        const requestedKeys = requests.flatMap(request => {
          if (!request || typeof request !== 'object') return []
          const sourceKey = (request as { sourceKey?: unknown }).sourceKey
          return typeof sourceKey === 'string' ? [sourceKey] : []
        })
        const nextKeys = requestedKeys.filter(sourceKey => !readKnowledgeSourceKeys.has(sourceKey))
        if (requestedKeys.some(sourceKey => !originalSourceGrants.has(sourceKey) && !isExplicitSource(sourceKey))) {
          return { ok: false, message: 'Use knowledge_search to search the target source text first, then read the returned source candidates; Wiki page evidence does not automatically authorize reading all source texts.',
            error: 'KNOWLEDGE_SEARCH_REQUIRED' }
        }
        if (readKnowledgeSourceKeys.size + new Set(nextKeys).size > knowledgeReadLimit) {
          return {
            ok: false,
            message: `The "${ragAgentPolicy.strategy}" strategy allows targeted reading of at most ${knowledgeReadLimit} knowledge sources. Read only the most relevant candidates.`,
            error: 'KNOWLEDGE_READ_BUDGET_EXHAUSTED',
          }
        }
        requestedKeys.forEach(sourceKey => readKnowledgeSourceKeys.add(sourceKey))
      }
      if (tool.name === 'knowledge_read_wiki') {
        const requests = Array.isArray(args.requests) ? args.requests : []
        const pageIds = requests.flatMap(request => {
          if (!request || typeof request !== 'object') return []
          const pageId = (request as { pageId?: unknown }).pageId
          return typeof pageId === 'string' ? [pageId] : []
        })
        if (pageIds.some(pageId => !wikiPageGrants.has(pageId))) return {
          ok: false, message: 'Search and read the Wiki pages within the scope of this retrieval first.', error: 'WIKI_SEARCH_REQUIRED',
        }
        const newPages = new Set(pageIds.filter(pageId => !readWikiPageIds.has(pageId)))
        if (readWikiPageIds.size + newPages.size > knowledgeReadLimit) return {
          ok: false, message: 'The knowledge reading budget for this run has been reached. Use the most relevant pages.', error: 'KNOWLEDGE_READ_BUDGET_EXHAUSTED',
        }
        pageIds.forEach(pageId => readWikiPageIds.add(pageId))
        args = { ...args, wikiGrants: Object.fromEntries(pageIds.map(pageId => [pageId, wikiPageGrants.get(pageId)!])) }
      }
      if (tool.name === 'knowledge_cite_sources') {
        const keys = Array.isArray(args.sourceKeys) ? args.sourceKeys : []
        if (keys.some(key => typeof key !== 'string' || !readEvidenceSourceKeys.has(key))) return {
          ok: false, message: 'Only cite Wiki evidence or source texts already read in this run.', error: 'KNOWLEDGE_EVIDENCE_NOT_READ',
        }
      }

      const result = await executeAgentTool(
        tool,
        args,
        runId,
        this.abortController?.signal,
        context,
        callbacks.requestUserQuestion,
        runWorkspaceIdentity,
        callbacks.requestUserInteraction,
      )
      // Do not discard a completed write if the workspace changed while it ran.
      // The caller records its outcome before checking the workspace again.
      if (tool.name === 'web_search') webSearchBudget.recordResult(result)
      if (result.ok && tool.name === 'knowledge_search') {
        for (const page of result.wikiPages ?? []) {
          const previous = wikiPageGrants.get(page.pageId) ?? []
          wikiPageGrants.set(page.pageId, [...previous, { contextId: page.contextId,
            sourceRefs: page.sourceRefs, scope: page.scope }])
        }
      }
      if (result.ok && Array.isArray(result.data)) {
        for (const item of result.data) {
          if (!item || typeof item !== 'object') continue
          const value = item as { sourceKey?: unknown; sourceRefs?: unknown }
          if (tool.name === 'knowledge_search' && typeof value.sourceKey === 'string') originalSourceGrants.add(value.sourceKey)
          if (tool.name === 'knowledge_read_sources' && typeof value.sourceKey === 'string') readEvidenceSourceKeys.add(value.sourceKey)
          if (tool.name === 'knowledge_read_wiki' && Array.isArray(value.sourceRefs)) {
            for (const reference of value.sourceRefs) {
              if (reference && typeof reference === 'object' && typeof (reference as { sourceKey?: unknown }).sourceKey === 'string') {
                readEvidenceSourceKeys.add((reference as { sourceKey: string }).sourceKey)
              }
            }
          }
        }
      }
      return result
    }
    const appendToolResult = (
      toolCallId: string,
      toolName: string,
      args: Record<string, unknown>,
      result: AgentToolResult
    ) => {
      messages.push({
        role: 'tool',
        tool_call_id: toolCallId,
        content: stringifyToolResult(result),
      })
      if (!result.ok && hasFileEditPreview(toolName)
        && !recorder.all().some(event => event.toolName === toolName && event.input === args)) {
        const event = recorder.add({ type: 'tool_result', title: 'Change not applied', status: 'error',
          toolName, input: args, output: result, editSkipped: true,
          editOutcome: /CHANGED|MISMATCH|STALE/.test(result.error || '') ? 'stale' : 'not-applied',
          message: 'This change was not applied.',
        })
        callbacks.onTrace?.(event)
      }
      // Failed attempts may have fresh execution IDs, paths, or timings, but
      // those do not establish progress. Keep the error in model context.
      if (!result.ok) return
      if (toolName === 'web_search') {
        // Query/provider changes are not new evidence, and budget errors add none.
        for (const key of webSearchBudget.evidenceKeys) toolResultEvidence.add(key)
        return
      }
      toolResultEvidence.add([
        toolName,
        JSON.stringify(args),
        stringifyToolResult(result),
      ].join(':'))
    }
    const loadedSkillIds = new Set<string>()
    let consecutiveNoProgressRounds = 0
    let forceFinalResponseReason: string | undefined
    let latestEditorStateResult: AgentToolResult | undefined
    let activeModelTraceId: string | undefined
    let activeModelStartedAt = 0
    let activeModelReasoning = ''
    let activeModelContent = ''
    let activeModelStreamedTokenCount = 0
    const discoveredFolderFiles = new Map<string, Set<string>>()
    const readFolderFiles = new Map<string, Set<string>>()

    const getFolderAttachmentProgress = (
      toolName: string,
      args: Record<string, unknown>,
      result: AgentToolResult
    ) => {
      if (!result.ok || (toolName !== 'attachment_list' && toolName !== 'attachment_read')) {
        return undefined
      }

      const attachmentId = typeof args.attachmentId === 'string' ? args.attachmentId : ''
      const attachment = context.attachments?.find((item) => item.id === attachmentId)
      if (!attachment || attachment.kind !== 'folder') {
        return undefined
      }

      if (toolName === 'attachment_list') {
        const data = result.data && typeof result.data === 'object'
          ? result.data as { relativePath?: unknown; entries?: unknown }
          : undefined
        const relativePath = typeof data?.relativePath === 'string' ? data.relativePath : ''
        const entries = Array.isArray(data?.entries) ? data.entries : []
        const discovered = discoveredFolderFiles.get(attachmentId) || new Set<string>()

        for (const value of entries) {
          if (!value || typeof value !== 'object') continue
          const entry = value as { name?: unknown; kind?: unknown; readable?: unknown }
          if (entry.kind !== 'file' || entry.readable !== true || typeof entry.name !== 'string') continue
          discovered.add(relativePath ? `${relativePath}/${entry.name}` : entry.name)
        }

        discoveredFolderFiles.set(attachmentId, discovered)
        return `Listed ${entries.length} items this time, with ${discovered.size} readable files discovered so far in total.`
      }

      const relativePath = typeof args.relativePath === 'string' ? args.relativePath : ''
      const relativePaths = Array.isArray(args.relativePaths)
        ? args.relativePaths.filter((path): path is string => typeof path === 'string')
        : []
      const resultData = result.data && typeof result.data === 'object'
        ? result.data as { files?: unknown }
        : undefined
      const successfulBatchPaths = Array.isArray(resultData?.files)
        ? resultData.files.flatMap((value) => {
            if (!value || typeof value !== 'object') return []
            const file = value as { path?: unknown; ok?: unknown }
            return file.ok === true && typeof file.path === 'string' ? [file.path] : []
          })
        : []
      const readPaths = successfulBatchPaths.length > 0
        ? successfulBatchPaths
        : relativePaths.length === 0 && relativePath
          ? [relativePath]
          : []
      if (readPaths.length === 0) return undefined
      const read = readFolderFiles.get(attachmentId) || new Set<string>()
      for (const path of readPaths) {
        read.add(path)
      }
      readFolderFiles.set(attachmentId, read)

      const discovered = discoveredFolderFiles.get(attachmentId)
      if (!discovered || discovered.size === 0) {
        return undefined
      }

      const readCount = [...discovered].filter((path) => read.has(path)).length
      const unread = [...discovered].filter((path) => !read.has(path))
      const unreadPreview = unread.slice(0, 20).join('、')
      const omittedCount = Math.max(0, unread.length - 20)
      return [
        `Already read ${readCount} of ${discovered.size} discovered readable files.`,
        unread.length > 0
          ? `Not yet read: ${unreadPreview}${omittedCount > 0 ? `, plus ${omittedCount} more` : ''}. Judge from the user request whether to keep reading.`
          : 'All discovered readable files have been read.',
      ].join('\n')
    }

    const getSafeStoppedContent = () => {
      if (toolCalls.length > 0 && !finalContent) {
        return [
          'Final explanation generation has stopped; for operations already executed successfully, rely on the tool results and the change log.',
          changes.length > 0 ? `Recorded ${changes.length} successful changes this round.` : '',
        ].filter(Boolean).join('\n')
      }

      return activeModelContent || finalContent
    }

    const prepareFinalResponse = (reason: string) => {
      callbacks.onCandidateAnswerClear?.()
      forceFinalResponseReason = reason
      consecutiveNoProgressRounds = 0
      messages.push({
        role: 'user',
        content: [
          '## App Context',
          `The tool execution phase has stopped: ${reason}`,
          'Based on the original user request and the tool results so far, generate a natural, complete final reply directly. Explain what was completed, what was not completed, and why; do not call any more tools.',
        ].join('\n'),
      })
    }

    let responsePreviewDisplayed = false
    const clearResponsePreview = () => {
      if (!responsePreviewDisplayed) return
      callbacks.onResponsePreview?.(undefined, runId)
      responsePreviewDisplayed = false
    }

    // Both Markdown and rendered replies must pass the same evidence checks before publication.
    const getFinalResponseReview = (draft: string, offeredToolNames: ReadonlySet<string>): string | undefined => {
      if (
        knowledgeSearchCount > 0
        && !knowledgeCitationChecked
        && !toolCalls.some(call => call.toolName === 'knowledge_cite_sources' && call.status === 'success')
      ) {
        knowledgeCitationChecked = true
        return [
          '## App Context',
          'A knowledge search occurred, but the draft did not identify which retrieved sources were actually used.',
          'If the draft relies on any retrieved source, call knowledge_cite_sources with only those source keys, then return the final answer.',
          'Do not cite sources that were merely retrieved, rejected, or left unread. If no retrieved source supports the draft, return the answer without claiming support from the knowledge base.',
          'Do not mention this internal citation check.',
        ].join('\n')
      }
      if (
        !forceFinalResponseReason
        && !directAnswerEvidenceChecked
        && knowledgeSearchCount === 0
        && offeredToolNames.has('knowledge_search')
        && (
          claimsUserNoteEvidence(draft)
          || explicitlyRequestsKnowledgeLookup(context.userInput)
          || requestsSavedPersonalFact(context.userInput)
        )
      ) {
        directAnswerEvidenceChecked = true
        return [
          '## App Context',
          'The draft above answers a request that may depend on the user\'s saved knowledge, but no unified knowledge search occurred in this run. Calls to memory_list, tag_list, mark_list, or other tools do not replace knowledge_search.',
          'Verify that attribution semantically, without relying on required keywords or fixed business fields. Do not treat the draft itself as evidence.',
          'If the claimed fact is not already supported by the conversation, current editor context, current canvas, or saved memory context, call knowledge_search now. If the existing context really supports it, return the final answer directly.',
          'Do not mention this internal evidence-attribution check.',
        ].join('\n')
      }
      return undefined
    }

    const appendFinalResponseReview = (draft: string, review: string) => {
      clearResponsePreview()
      callbacks.onCandidateAnswerClear?.()
      messages.push({ role: 'assistant', content: draft }, { role: 'user', content: review })
    }

    const completeFinalResponse = (content: string, renderedToolCallId?: string): AgentRuntimeResult => {
      agentDebugLog('final_answer', {
        runId,
        format: renderedToolCallId ? 'json-render' : 'markdown',
        contentLength: content.length,
        preview: previewText(content),
      })
      const finalTrace = recorder.add({
        type: 'final',
        title: 'Done',
        status: 'success',
        message: content,
        ...(renderedToolCallId ? { output: { format: 'json-render', toolCallId: renderedToolCallId } } : {}),
      })
      callbacks.onTrace?.(finalTrace)
      callbacks.onStatus?.('completed')
      callbacks.onFinalAnswerRender?.(content)
      clearResponsePreview()
      return { runId, content, stopped: false, steps, toolCalls, changes, trace: recorder.all() }
    }

    const drainSteering = async () => {
      if (!this.steeringRequested) return false
      if (this.stopped) return false

      const payloads = this.steeringQueue.drain()
      if (payloads.length === 0) return false
      this.steeringRequested = this.steeringQueue.hasItems()
      callbacks.onSteeringDelivered?.(payloads)
      callbacks.onStatus?.('steering')

      for (const payload of payloads) {
        const text = payload.additionalContext
          ? `## App Context\n${payload.additionalContext}\n\n## User steering message\n${payload.text}`
          : payload.text
        messages.push(await this.contextManager.buildCurrentUserMessage(text, payload.imageUrls))
      }

      const latest = payloads[payloads.length - 1]
      context.userInput = latest.text
      context.currentQuote = latest.currentQuote
      context.attachments = latest.attachments ?? context.attachments
      const steeredSkillIds = payloads.flatMap(payload => payload.selectedSkills || [])
      if (steeredSkillIds.length > 0) {
        context.selectedSkills = [
          ...new Set([...(context.selectedSkills || []), ...steeredSkillIds]),
        ]
        const availableSkillIds = new Set(
          (context.availableSkills || []).map(skill => skill.id)
        )
        for (const skillId of steeredSkillIds) {
          if (availableSkillIds.has(skillId)) continue
          const skill = skillManager.getSkill(skillId)
          if (!skill || skill.metadata.enabled === false) continue
          context.availableSkills = [
            ...(context.availableSkills || []),
            {
              id: skill.metadata.id,
              name: skill.metadata.name,
              description: skill.metadata.description,
              scope: skill.metadata.scope,
            },
          ]
          availableSkillIds.add(skillId)
        }
      }
      if (latest.imageAttachments?.length) {
        context.imageAttachments = [
          ...(context.imageAttachments ?? []),
          ...latest.imageAttachments,
        ].slice(-6)
      }
      context.currentEditorState = undefined
      tools = selectToolsForContext(context, allTools, input.permissionMode)
      editorStateReadLocked = false
      editorSelectionReadLocked = hasInlineCurrentEditorSelection(context)
      consecutiveNoProgressRounds = 0
      forceFinalResponseReason = undefined
      successfulMutationCalls.clear()
      directAnswerEvidenceChecked = false
      memoryContext = input.useMemories === false
        ? {
            memories: [],
            usedTokens: 0,
            policyEnabled: false,
            workspaceId: input.workspaceId || 'default',
          }
        : await memoryContextService.getMemoryContext({
            query: latest.text,
            conversationId: input.conversationId,
            workspaceId: input.workspaceId,
          })
      systemPrompt = this.promptAssembler.assemble(
        context,
        tools,
        customSystemPrompt,
        memoryContextService.formatMemoryContext(memoryContext)
      )
      messages[0] = { role: 'system', content: systemPrompt }

      const steeringTrace = recorder.add({
        type: 'steering',
        title: 'Steering info applied',
        status: 'success',
        message: payloads.map((payload) => payload.text).join('\n'),
      })
      callbacks.onTrace?.(steeringTrace)
      return true
    }

    const finalizeInterruptedModelTrace = (
      status: 'success' | 'error',
      title: string,
      isIntermediateResponse = true
    ) => {
      if (!activeModelTraceId) {
        return
      }

      const interruptedTrace = recorder.update(activeModelTraceId, {
        type: 'model_response',
        title,
        status,
        duration: Date.now() - activeModelStartedAt,
        output: activeModelContent || undefined,
        reasoning: activeModelReasoning || undefined,
        isIntermediateResponse: isIntermediateResponse && Boolean(activeModelContent)
          && activeModelContent !== finalContent,
        streamedTokenCount: activeModelStreamedTokenCount,
      })
      if (interruptedTrace) callbacks.onTrace?.(interruptedTrace)

      activeModelTraceId = undefined
      activeModelStartedAt = 0
      activeModelReasoning = ''
      activeModelContent = ''
      activeModelStreamedTokenCount = 0
    }

    try {
      agentLoop: for (let iteration = 1; iteration <= ABSOLUTE_MAX_MODEL_ROUNDS + 1; iteration += 1) {
        clearResponsePreview()
        if (iteration > ABSOLUTE_MAX_MODEL_ROUNDS && !forceFinalResponseReason) {
          break
        }
        if (this.stopped) {
          callbacks.onStatus?.('stopped')
          const stoppedContent = getSafeStoppedContent()
          if (stoppedContent) {
            callbacks.onFinalAnswerRender?.(stoppedContent)
          }
          return {
            runId,
            content: stoppedContent,
            stopped: true,
            steps,
            toolCalls,
            changes,
            trace: recorder.all(),
          }
        }

        await drainSteering()
        const evidenceCountAtRoundStart = toolResultEvidence.size

        callbacks.onStatus?.('thinking')
        await agentEventBus.emit('before-model-call', { runId })
        agentDebugLog('model_call_start', {
          runId,
          iteration,
          model: aiConfig?.model || '',
          messageCount: messages.length,
          toolCount: tools.length,
        })
        const modelTrace = recorder.add({
          type: 'model_call',
          title: 'Model thinking',
          status: 'running',
          message: `Round ${iteration}`,
          streamedTokenCount: 0,
        })
        activeModelTraceId = modelTrace.id
        activeModelStartedAt = modelTrace.timestamp
        activeModelReasoning = ''
        activeModelContent = ''
        activeModelStreamedTokenCount = 0
        callbacks.onTrace?.(modelTrace)

        const offeredTools = forceFinalResponseReason ? [] : tools.filter((tool) => {
          if (tool.name === 'web_search' && !webSearchBudget.canSearch) {
            return false
          }
          if (editorStateReadLocked && tool.name === 'editor_get_state') {
            return false
          }
          if (editorSelectionReadLocked && tool.name === 'editor_get_selection') {
            return false
          }
          return true
        })
        const offeredToolNames = new Set(offeredTools.map((tool) => tool.name))
        const openAITools = agentToolRegistry.toOpenAITools(offeredTools, loadedSkillIds)
        const requestMessages = this.contextManager.prepareMessages([
          {
            role: 'system',
            content: toolMap.has('web_search')
              ? `${systemPrompt}\n\n${webSearchBudget.formatInstructions()}`
              : systemPrompt,
          },
          ...messages.slice(1),
        ])
        if (isAgentDebugEnabled()) {
          const requestSystemContent = requestMessages[0]?.content
          const prompt = typeof requestSystemContent === 'string' ? requestSystemContent : ''
          const openingTag = '<current_editor_content>\n'
          const contentStart = prompt.indexOf(openingTag)
          const contentEnd = contentStart < 0 ? -1 : prompt.indexOf('\n</current_editor_content>', contentStart + openingTag.length)
          const injectedContent = contentStart >= 0 && contentEnd >= 0
            ? prompt.slice(contentStart + openingTag.length, contentEnd)
            : ''
          agentDebugLog('model_editor_context', {
            runId,
            iteration,
            activeFilePath: context.activeFilePath,
            hasSnapshot: Boolean(context.currentEditorState),
            inlineEligible: hasInlineCurrentEditorState(context),
            inlinePresentInRequest: contentStart >= 0 && contentEnd >= 0,
            snapshotVersion: context.currentEditorState?.version,
            snapshotCharCount: context.currentEditorState?.markdown.length,
            snapshotTotalLines: context.currentEditorState?.totalLines,
            matchesNumberedSnapshot: injectedContent === context.currentEditorState?.numberedLines,
            editorStateToolOffered: offeredToolNames.has('editor_get_state'),
            editorStateReadLocked,
          })
          if (injectedContent !== lastLoggedEditorContext) {
            agentDebugText('model_editor_context_content', injectedContent, { runId, iteration })
            lastLoggedEditorContext = injectedContent
          }
        }
        const messageTextTokens = requestMessages.reduce(
          (sum, message) => sum + estimateMessageTextTokens(message),
          0
        )
        const toolSchemaTokens = estimateTokens(JSON.stringify(openAITools))
        agentDebugLog('model_request_budget', {
          runId,
          iteration,
          messageCount: requestMessages.length,
          messageTextTokens,
          offeredToolCount: offeredTools.length,
          toolSchemaTokens,
          estimatedTextAndToolTokens: messageTextTokens + toolSchemaTokens,
          imageCount: input.imageUrls?.length || 0,
        })
        const toolParams = openAITools.length > 0
          ? {
              tools: openAITools,
              tool_choice: 'auto' as const,
            }
          : {}
        const stream = await this.recoveryManager.withRetry(() =>
          createChatCompletionStreamWithToolChoiceFallback(client, withFastAiRequestOptions({
            model: aiConfig?.model || '',
            messages: requestMessages,
            temperature: aiConfig?.temperature,
            top_p: aiConfig?.topP,
            stream: true,
            ...toolParams,
            ...getChatTokenLimitParams(aiConfig),
          }, aiConfig), {
            signal: this.abortController?.signal,
          })
        )
        let assistantContent = ''
        let finishReason: string | null | undefined
        let toolCallsStarted = false
        let candidateAnswerRendered = false
        let lastCandidateAnswerRenderAt: number | null = null
        let lastCandidateAnswerContent = ''
        let lastStreamYieldAt = Date.now()
        let assistantReasoning = ''
        const assistantReasoningDetails: unknown[] = []
        let streamedText = ''
        let streamedTokenCount = 0
        let lastModelProgressTraceAt = 0
        const streamedToolCalls = new Map<number, StreamingToolCallAccumulator>()
        let responseStream: ReturnType<typeof createChatResponseStream> | undefined
        let responseArgumentOffset = 0
        let lastResponsePreviewAt = 0

        const renderResponsePreview = (force = false) => {
          const call = streamedToolCalls.size === 1 ? streamedToolCalls.values().next().value : undefined
          if (this.stopped || this.steeringRequested || !offeredToolNames.has('render_response')
            || !call || call.function.name !== 'render_response') {
            clearResponsePreview()
            responseStream = undefined
            responseArgumentOffset = 0
            return
          }
          responseStream ??= createChatResponseStream()
          const fragment = call.function.arguments.slice(responseArgumentOffset)
          responseArgumentOffset = call.function.arguments.length
          responseStream.push(fragment)
          const now = Date.now()
          if (!force && now - lastResponsePreviewAt < STREAM_RENDER_INTERVAL_MS) return
          lastResponsePreviewAt = now
          const snapshot = responseStream.snapshot()
          if (snapshot === undefined) return
          if (!snapshot) { clearResponsePreview(); return }
          callbacks.onResponsePreview?.({ ...snapshot, runId,
            toolCallId: call.id || modelTrace.id, workspaceIdentity: runWorkspaceIdentity,
          }, runId)
          responsePreviewDisplayed = true
        }

        const renderCandidateAnswer = (force = false) => {
          if (toolCallsStarted || !assistantContent.trim() || assistantContent === lastCandidateAnswerContent) {
            return
          }
          const now = Date.now()
          if (!force && lastCandidateAnswerRenderAt !== null && now - lastCandidateAnswerRenderAt < STREAM_RENDER_INTERVAL_MS) {
            return
          }
          callbacks.onCandidateAnswerRender?.(assistantContent)
          candidateAnswerRendered = true
          lastCandidateAnswerContent = assistantContent
          lastCandidateAnswerRenderAt = now
        }

        for await (const chunk of stream) {
          if (this.stopped) {
            throw new Error('USER_STOPPED')
          }
          const choice = chunk.choices?.[0]
          if (!choice) {
            continue
          }

          finishReason = choice.finish_reason ?? finishReason
          const delta = choice.delta
          if (!delta) {
            continue
          }
          const extendedDelta = delta as typeof delta & {
            reasoning?: string
            reasoning_content?: string
            reasoning_details?: unknown[]
          }
          const reasoningDelta = extendedDelta.reasoning_content || extendedDelta.reasoning
          if (typeof reasoningDelta === 'string') {
            assistantReasoning += reasoningDelta
            streamedText += reasoningDelta
            activeModelReasoning = assistantReasoning
          }
          if (Array.isArray(extendedDelta.reasoning_details)) {
            assistantReasoningDetails.push(...extendedDelta.reasoning_details)
          }
          if (typeof delta.content === 'string' && delta.content) {
            assistantContent += delta.content
            streamedText += delta.content
            activeModelContent = assistantContent
            renderCandidateAnswer()
          }

          for (const toolCallDelta of delta.tool_calls || []) {
            if (!toolCallsStarted) {
              toolCallsStarted = true
            }

            const index = resolveStreamingToolCallIndex(streamedToolCalls, toolCallDelta)
            const current = streamedToolCalls.get(index) || {
              index,
              id: toolCallDelta.id,
              type: 'function' as const,
              function: {
                name: '',
                arguments: '',
              },
            }

            if (toolCallDelta.id) {
              current.id = toolCallDelta.id
            }
            if (toolCallDelta.type === 'function') {
              current.type = toolCallDelta.type
            }
            if (toolCallDelta.function?.name) {
              current.function.name += toolCallDelta.function.name
              streamedText += toolCallDelta.function.name
            }
            if (toolCallDelta.function?.arguments) {
              current.function.arguments += toolCallDelta.function.arguments
              streamedText += toolCallDelta.function.arguments
            }

            streamedToolCalls.set(index, current)
          }

          renderResponsePreview()

          const now = Date.now()
          if (streamedText && now - lastModelProgressTraceAt >= 100) {
            streamedTokenCount = estimateTokens(streamedText)
            activeModelStreamedTokenCount = streamedTokenCount
            lastModelProgressTraceAt = now
            const progressTrace = recorder.update(modelTrace.id, {
              output: assistantContent || undefined,
              reasoning: assistantReasoning || undefined,
              streamedTokenCount,
            })
            if (progressTrace) callbacks.onTrace?.(progressTrace)
          }

          // Buffered stream chunks can resolve in consecutive microtasks.
          // Give React and the browser a task boundary to finish pending work.
          if (now - lastStreamYieldAt >= STREAM_RENDER_INTERVAL_MS) {
            await new Promise<void>(resolve => setTimeout(resolve, 0))
            lastStreamYieldAt = Date.now()
            if (this.stopped) throw new Error('USER_STOPPED')
            renderCandidateAnswer()
            renderResponsePreview()
          }
        }
        if (this.stopped) throw new Error('USER_STOPPED')
        // Flush the tail before completing or clearing a candidate response.
        // All callbacks stay inside this run's try/catch; no render timer can
        // write stale content after a stop, a new round, or a failed request.
        renderCandidateAnswer(true)
        renderResponsePreview(true)
        streamedTokenCount = estimateTokens(streamedText)
        activeModelStreamedTokenCount = streamedTokenCount
        assistantContent = assistantContent.trim() ? assistantContent : ''
        const rawToolUses = toToolCallList(streamedToolCalls)
        const toolUses = rawToolUses.map((toolCall) => {
          const rewritten = rewriteWorkspaceReadAsAttachmentRead(toolCall, context)
          if (rewritten.function.name !== toolCall.function.name) {
            agentDebugLog('tool_call_auto_routed_to_attachment', {
              runId,
              toolCallId: toolCall.id,
              originalToolName: toolCall.function.name,
              originalArguments: toolCall.function.arguments,
              rewrittenToolName: rewritten.function.name,
              rewrittenArguments: rewritten.function.arguments,
            })
          }
          return rewritten
        })
        agentDebugLog('model_call_end', {
          runId,
          iteration,
          finishReason,
          assistantContentLength: assistantContent.length,
          assistantPreview: previewText(assistantContent),
          toolCalls: toolUses.map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.function.name,
            argumentsPreview: previewText(toolCall.function.arguments || ''),
          })),
        })
        const modelTraceOutput = assistantContent || (
          toolUses.length > 0
            ? {
              finishReason,
              toolCalls: toolUses.map((toolCall) => ({
                id: toolCall.id,
                name: toolCall.function.name,
                argumentsPreview: previewText(toolCall.function.arguments || '', 500),
              })),
            }
            : undefined
        )
        const responseTrace = recorder.update(modelTrace.id, {
          type: 'model_response',
          title: assistantContent ? 'Model response' : toolUses.length > 0 ? 'Model choosing tools' : 'Model thinking',
          status: 'success',
          duration: Date.now() - modelTrace.timestamp,
          output: modelTraceOutput,
          reasoning: assistantReasoning || undefined,
          // Keep every emitted paragraph until this response is accepted as
          // the final reply. A review, steering, or stop can still follow.
          isIntermediateResponse: Boolean(assistantContent),
          streamedTokenCount,
        })
        if (responseTrace) callbacks.onTrace?.(responseTrace)
        activeModelTraceId = undefined
        activeModelStartedAt = 0
        activeModelReasoning = ''
        activeModelContent = ''
        activeModelStreamedTokenCount = 0
        if (toolCallsStarted && candidateAnswerRendered) {
          callbacks.onCandidateAnswerClear?.()
        }
        await agentEventBus.emit('after-model-call', { runId, content: assistantContent })
        if (this.stopped) throw new Error('USER_STOPPED')

        if (toolUses.length === 0) {
          const resolvedContent = assistantContent || finalContent
          if (this.steeringRequested) {
            callbacks.onCandidateAnswerClear?.()
            if (resolvedContent) {
              messages.push({ role: 'assistant', content: resolvedContent })
            }
            await drainSteering()
            continue
          }
          if (!resolvedContent) {
            throw new Error('AI response did not include a message')
          }
          const review = getFinalResponseReview(resolvedContent, offeredToolNames)
          if (review) {
            appendFinalResponseReview(resolvedContent, review)
            continue
          }
          const finalModelTrace = recorder.update(modelTrace.id, { isIntermediateResponse: false })
          if (finalModelTrace) callbacks.onTrace?.(finalModelTrace)
          return completeFinalResponse(resolvedContent)
        }

        messages.push(createAssistantToolCallMessage(
          assistantContent,
          toolUses,
          assistantReasoning,
          assistantReasoningDetails
        ))

        const cancelRemainingToolCalls = (afterIndex: number, reason: string) => {
          for (const pendingToolUse of toolUses.slice(afterIndex + 1)) {
            appendToolResult(pendingToolUse.id, pendingToolUse.function.name, {}, {
              ok: false,
              message: `The runtime guard has stopped further tool calls: ${reason}`,
              error: 'CANCELLED_BY_RUNTIME_GUARD',
            })
          }
        }

        for (let toolIndex = 0; toolIndex < toolUses.length; toolIndex += 1) {
          const toolUse = toolUses[toolIndex]
          if (this.stopped) {
            throw new Error('USER_STOPPED')
          }
          await assertRunWorkspace()
          const toolName = toolUse.function.name
          const tool = toolMap.get(toolName)
          let args: Record<string, unknown>
          let displayTitle: string | undefined
          try {
            args = parseToolArguments(toolUse.function.arguments)
            displayTitle = takeToolDisplayTitle(args)
          } catch (error) {
            if (toolName === 'render_response') clearResponsePreview()
            const parseErrorResult: AgentToolResult = {
              ok: false,
              message: `Invalid tool argument JSON: ${error instanceof Error ? error.message : String(error)}. Retry the same tool call and return valid JSON arguments.`,
              error: 'INVALID_TOOL_ARGUMENTS_JSON',
            }
            const toolCall: ToolCall = {
              id: toolUse.id || createAgentId('tool-call'),
              toolName,
              params: {},
              status: 'error',
              result: toolResultToLegacy(parseErrorResult),
              timestamp: Date.now(),
            }
            toolCalls.push(toolCall)
            callbacks.onToolCall?.(toolCall)
            agentDebugLog('tool_args_parse_error', {
              runId,
              toolCallId: toolUse.id,
              toolName,
              rawArguments: toolUse.function.arguments || '',
              error: parseErrorResult.message,
            })
            appendToolResult(toolUse.id, toolName, {}, parseErrorResult)
            continue
          }

          const repairedEditorArgs = repairEditorWriteArgs(toolName, args, context)
          if (repairedEditorArgs !== args) {
            agentDebugLog('tool_args_auto_repaired', {
              runId,
              toolName,
              originalArgs: args,
              repairedArgs: repairedEditorArgs,
              reason: 'Normalized editor line replacement arguments and preserved Markdown structure.',
            })
            args = repairedEditorArgs
          }

          const repairedAttachmentArgs = repairAttachmentToolArgs(toolName, args, context)
          if (repairedAttachmentArgs !== args) {
            agentDebugLog('attachment_args_auto_repaired', {
              runId,
              toolCallId: toolUse.id,
              toolName,
              originalArgs: args,
              repairedArgs: repairedAttachmentArgs,
            })
            args = repairedAttachmentArgs
          }

          agentDebugLog('tool_call_received', {
            runId,
            toolCallId: toolUse.id,
            toolName,
            args,
          })

          if (!tool) {
            const missingResult: AgentToolResult = {
              ok: false,
              message: `Tool does not exist: ${toolName}`,
              error: `Unknown tool ${toolName}`,
            }
            agentDebugLog('tool_missing', {
              runId,
              toolName,
            })
            appendToolResult(toolUse.id, toolName, args, missingResult)
            continue
          }

          callbacks.onStatus?.('calling_tool')
          const toolCall: ToolCall = {
            id: toolUse.id || createAgentId('tool-call'),
            toolName,
            displayTitle,
            params: args,
            status: 'pending',
            timestamp: Date.now(),
          }
          toolCalls.push(toolCall)
          callbacks.onToolCall?.(toolCall)

          if (!offeredToolNames.has(toolName)) {
            const blockedResult: AgentToolResult = {
              ok: false,
              message: `Blocked a tool call that the current context or permission mode does not provide: ${toolName}.`,
              error: 'BLOCKED_UNAVAILABLE_TOOL',
            }
            agentDebugLog('tool_blocked_as_unavailable', {
              runId,
              toolName,
              args,
              offeredToolNames: [...offeredToolNames],
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(blockedResult)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, blockedResult)
            continue
          }

          if (tool.name === 'render_response' && toolUses.length !== 1) {
            const batchResult: AgentToolResult = {
              ok: false,
              error: 'INVALID_TOOL_BATCH',
              message: 'render_response must be the only tool call in its model response. Complete the other requested operations first, then choose a normal Markdown reply or call render_response alone with the complete final answer.',
            }
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(batchResult)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, batchResult)
            continue
          }

          const invalidToolInput = validateToolInputShape(tool, args)
          if (invalidToolInput) {
            if (tool.name === 'render_response') clearResponsePreview()
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(invalidToolInput)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, invalidToolInput)
            continue
          }

          if (tool.name === 'render_response') {
            if (this.steeringRequested) {
              const supersededResult: AgentToolResult = {
                ok: false,
                error: 'SUPERSEDED_BY_STEERING',
                message: 'A newer user instruction superseded this final reply. Apply it before choosing the final answer.',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(supersededResult)
              callbacks.onToolCall?.(toolCall)
              appendToolResult(toolUse.id, toolName, args, supersededResult)
              continue agentLoop
            }
            let draft: string | undefined
            try {
              draft = getChatResponseText(parseChatResponseSpec(args.spec))
            } catch {
              // Let the tool return its normal actionable spec-validation error.
            }
            if (draft !== undefined) {
              const review = getFinalResponseReview(draft, offeredToolNames)
              if (review) {
                const reviewResult: AgentToolResult = {
                  ok: false,
                  error: 'FINAL_RESPONSE_REQUIRES_EVIDENCE',
                  message: 'The final reply has not been published. Review the following app feedback, complete any necessary knowledge lookup or source citation, then choose the final reply format again.',
                }
                toolCall.status = 'error'
                toolCall.result = toolResultToLegacy(reviewResult)
                callbacks.onToolCall?.(toolCall)
                appendToolResult(toolUse.id, toolName, args, reviewResult)
                appendFinalResponseReview(draft, review)
                continue agentLoop
              }
            }
          }

          if (
            LOADED_SKILL_TOOL_NAMES.has(toolName)
            && (
              typeof args.skill_id !== 'string'
              || !loadedSkillIds.has(args.skill_id)
            )
          ) {
            const notLoadedResult: AgentToolResult = {
              ok: false,
              message: `Skill "${String(args.skill_id || '')}" is not loaded in this task. Call skill_load once before using its resources or scripts.`,
              error: 'SKILL_NOT_LOADED',
            }
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(notLoadedResult)
            callbacks.onToolCall?.(toolCall)
            messages.push({
              role: 'tool',
              tool_call_id: toolUse.id,
              content: stringifyToolResult(notLoadedResult),
            })
            continue
          }

          if (toolName === 'skill_execute_script' && typeof args.skill_id === 'string') {
            const availableScripts = skillManager.getSkill(args.skill_id)?.scripts.map(script => script.name) || []
            if (
              typeof args.script_id !== 'string'
              || !availableScripts.includes(args.script_id)
            ) {
              const invalidScriptResult: AgentToolResult = {
                ok: false,
                message: [
                  `Invalid script_id for loaded Skill "${args.skill_id}": ${String(args.script_id || '')}.`,
                  `Choose one exact registered ID: ${availableScripts.join(', ') || '(none)'}.`,
                  'Do not invent or abbreviate a registered script ID. Use skill_run_code for approved inline or task-specific source.',
                ].join('\n'),
                error: 'INVALID_REGISTERED_SCRIPT_ID',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(invalidScriptResult)
              callbacks.onToolCall?.(toolCall)
              messages.push({
                role: 'tool',
                tool_call_id: toolUse.id,
                content: stringifyToolResult(invalidScriptResult),
              })
              continue
            }
          }

          const invalidEditorTarget = validateEditorTargetFile(context, tool, args)
          if (invalidEditorTarget) {
            agentDebugLog('tool_args_rejected', {
              runId,
              toolName,
              args,
              reason: invalidEditorTarget.message,
              error: invalidEditorTarget.error,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(invalidEditorTarget)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, invalidEditorTarget)
            continue
          }

          const invalidQuotedWrite = validateQuotedEditorWrite(context, toolName, args)
          if (invalidQuotedWrite) {
            agentDebugLog('tool_args_rejected', {
              runId,
              toolName,
              args,
              reason: invalidQuotedWrite.message,
              error: invalidQuotedWrite.error,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(invalidQuotedWrite)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, invalidQuotedWrite)
            continue
          }

          const blockedByHook = await agentEventBus.emit('pre-tool-use', {
            runId,
            tool,
            input: args,
          })

          if (blockedByHook) {
            const blockedResult: AgentToolResult = {
              ok: false,
              message: blockedByHook,
              error: 'BLOCKED_BY_HOOK',
            }
            agentDebugLog('tool_blocked_by_hook', {
              runId,
              toolName,
              reason: blockedByHook,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(blockedResult)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, blockedResult)
            continue
          }

          const permission = this.permissionEngine.evaluate(tool, args, input.permissionMode)
          agentDebugLog('permission_decision', {
            runId,
            toolName,
            risk: tool.risk,
            allowed: permission.allowed,
            requiresApproval: permission.requiresApproval,
            reason: permission.reason,
            canApproveForSession: permission.canApproveForSession,
            sessionApprovalType: permission.sessionApprovalType,
            sessionApprovalKey: permission.sessionApprovalKey,
          })
          if (!permission.allowed) {
            const deniedResult: AgentToolResult = {
              ok: false,
              message: permission.reason || 'The tool call was blocked by the permission policy.',
              error: 'BLOCKED_BY_PERMISSION',
            }
            agentDebugLog('tool_blocked_by_permission', {
              runId,
              toolName,
              reason: deniedResult.message,
            })
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(deniedResult)
            callbacks.onToolCall?.(toolCall)
            appendToolResult(toolUse.id, toolName, args, deniedResult)
            continue
          }

          let approvalPreview: Awaited<ReturnType<typeof buildEditorApprovalPreview>>
          let previewFailure: AgentToolResult | undefined
          if (hasFileEditPreview(tool.name)) {
            try {
              approvalPreview = await buildEditorApprovalPreview(tool.name, args)
              if (approvalPreview) {
                args = approvalPreview.previewParams
                toolCall.params = args
                if (approvalPreview.kind === 'editor' && approvalPreview.from === undefined && approvalPreview.to === undefined) {
                  buildEditorTextEdits(approvalPreview.originalContent, approvalPreview.modifiedContent)
                  if (approvalPreview.originalContent === approvalPreview.modifiedContent) {
                    previewFailure = { ok: false, error: 'EDITOR_NO_CHANGES', message: 'Nothing changed, so no new change was applied.' }
                  }
                }
                previewFailure ??= await validateEditApprovalPreview(approvalPreview)
              }
            } catch (error) {
              previewFailure = { ok: false,
                error: error instanceof EditorEditSkipped ? EDITOR_EDIT_SKIPPED : 'EDIT_PREVIEW_UNAVAILABLE',
                message: 'This change was not applied. The current content can stay; adjust the edit scope from the proposed diff.',
              }
              agentDebugLog('edit_preview_unavailable', { runId, toolName, error: String(error) })
            }
          }
          if (previewFailure) {
            toolCall.status = 'error'
            toolCall.result = toolResultToLegacy(previewFailure)
            callbacks.onToolCall?.(toolCall)
            const skipped = recorder.add({ type: 'tool_result', title: 'Change not applied', status: 'error', toolName,
              editOutcome: /CHANGED|MISMATCH|STALE/.test(previewFailure.error || '') ? 'stale' : 'not-applied',
              editSkipped: true, approvalPreview, input: args, output: previewFailure,
              message: previewFailure.message,
            })
            callbacks.onTrace?.(skipped)
            appendToolResult(toolUse.id, toolName, args, previewFailure)
            return completeFinalResponse(approvalPreview
              ? 'Change not applied; the proposed diff can be reviewed in the conversation.' : 'Change not applied; the original content is unchanged.')
          }
          if (permission.requiresApproval) {
            callbacks.onStatus?.('waiting_approval')
            agentDebugLog('approval_request', {
              runId,
              toolName,
              args,
            })
            const approvalTrace = recorder.add({
              type: 'approval',
              title: 'Waiting for user confirmation',
              status: 'running',
              toolName,
              input: args,
            })
            callbacks.onTrace?.(approvalTrace)

            if (approvalPreview) {
              const previewTrace = recorder.update(approvalTrace.id, { approvalPreview })
              if (previewTrace) callbacks.onTrace?.(previewTrace)
            }
            if (this.stopped) {
              throw new Error('USER_STOPPED')
            }
            let approvalDecision = this.steeringRequested
              ? 'steered'
              : await callbacks.requestConfirmation?.(
                  tool.name,
                  args,
                  approvalPreview ?? { previewParams: args }
                )

            agentDebugLog('approval_result', {
              runId,
              toolName,
              approved: approvalDecision === 'approved',
              decision: approvalDecision,
            })

            if (this.stopped) {
              throw new Error('USER_STOPPED')
            }
            if (this.steeringRequested) {
              approvalDecision = 'steered'
            }

            if (approvalDecision === 'steered') {
              const supersededResult: AgentToolResult = {
                ok: false,
                message: 'The user added new steering info, so this pending operation was cancelled.',
                error: 'SUPERSEDED_BY_STEERING',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(supersededResult)
              callbacks.onToolCall?.(toolCall)
              const updatedApprovalTrace = recorder.update(approvalTrace.id, {
                approvalDecision: 'steered',
                editOutcome: 'cancelled',
                status: 'error',
                message: supersededResult.message,
                output: supersededResult,
              })
              if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
              appendToolResult(toolUse.id, toolName, args, supersededResult)
              continue
            }

            if (approvalDecision !== 'approved') {
              const deniedResult: AgentToolResult = {
                ok: false,
                message: 'The user rejected this operation. Do not call the same high-risk tool again; answer read-only or ask the user for a different approach.',
                error: 'USER_DENIED_TOOL',
              }
              toolCall.status = 'error'
              toolCall.result = toolResultToLegacy(deniedResult)
              callbacks.onToolCall?.(toolCall)
              const updatedApprovalTrace = recorder.update(approvalTrace.id, {
                approvalDecision: 'denied',
                editOutcome: 'cancelled',
                status: 'error',
                message: deniedResult.message,
                output: deniedResult,
              })
              if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
              appendToolResult(toolUse.id, toolName, args, deniedResult)
              finalContent = changes.length > 0
                ? `Cancelled the current pending operation; ${changes.length} changes were already executed successfully, so rely on the change log.`
                : 'Cancelled the current pending operation; the change was not executed.'
              agentDebugLog('approval_denied_final', {
                runId,
                toolName,
                content: finalContent,
              })
              callbacks.onStatus?.('completed')
              callbacks.onFinalAnswerRender?.(finalContent)
              const finalTrace = recorder.add({
                type: 'final',
                title: 'Cancelled',
                status: 'success',
                message: finalContent,
              })
              callbacks.onTrace?.(finalTrace)

              return {
                runId,
                content: finalContent,
                stopped: false,
                steps,
                toolCalls,
                changes,
                trace: recorder.all(),
              }
            }

            const updatedApprovalTrace = recorder.update(approvalTrace.id, {
              approvalDecision: 'approved',
              status: 'success',
              message: 'The user confirmed the operation.',
            })
            if (updatedApprovalTrace) callbacks.onTrace?.(updatedApprovalTrace)
          }

          // Approval can remain open while the user switches workspaces.
          // Recheck its original workspace immediately before any tool executes.
          await assertRunWorkspace()
          callbacks.onStatus?.(
            ['editor-write', 'file-create', 'file-update', 'delete', 'medium'].includes(tool.risk)
              ? 'applying_change'
              : 'calling_tool'
          )

          const trace = recorder.add({
            type: 'tool_call',
            title: displayTitle || tool.title,
            displayTitle,
            status: 'running',
            toolName,
            input: args,
            approvalPreview,
          })
          callbacks.onTrace?.(trace)
          toolCall.status = 'running'
          callbacks.onToolCall?.(toolCall)

          const startedAt = Date.now()
          const reusableEditorStateResult = toolName === 'editor_get_state' && editorStateReadLocked
            ? latestEditorStateResult
            : undefined
          const reusedLockedEditorState = reusableEditorStateResult !== undefined
          const mutationCallSignature = isMutatingTool(tool)
            ? `${tool.name}:${JSON.stringify(args)}`
            : undefined
          const failedCallSignature = guardsFailedToolCall(tool)
            ? `${tool.name}:${JSON.stringify(args)}`
            : undefined
          const repeatedFailedMutation = Boolean(
            failedCallSignature && failedToolResultHistory.has(failedCallSignature)
          )
          const repeatedSuccessfulMutation = Boolean(
            mutationCallSignature && successfulMutationCalls.has(mutationCallSignature)
          )
          agentDebugLog('tool_execute_start', {
            runId,
            iteration,
            toolName,
            args,
            reusedLockedEditorState,
            repeatedFailedMutation,
            repeatedSuccessfulMutation,
          })
          const proposalConflict = approvalPreview
            ? await validateEditApprovalPreview(approvalPreview).catch((): AgentToolResult => ({
                ok: false, error: 'EDIT_SNAPSHOT_UNAVAILABLE', message: 'The file content cannot be checked right now, so this change was not applied.',
              }))
            : undefined
          if (this.stopped) throw new Error('USER_STOPPED')
          const result: AgentToolResult = proposalConflict ?? (repeatedSuccessfulMutation
            ? {
                ok: true,
                message: 'The same write operation already succeeded in this task, so this repeated call was ignored. Finish the answer directly.',
                data: { deduplicated: true },
              }
            : repeatedFailedMutation
            ? {
                ok: false,
                message: 'The same operation already failed before, so this repeated execution was blocked. Adjust the arguments, use a different tool, or explain the failure to the user.',
                error: 'REPEATED_FAILED_MUTATION_BLOCKED',
              }
            : reusableEditorStateResult
            ? {
                ...reusableEditorStateResult,
                message: [
                  reusableEditorStateResult.message,
                  'The same editor state was already read this round. Use the content returned earlier directly; do not read it again.',
                ].join('\n\n'),
              }
            : await executeToolWithBudget(tool, args))
          const actualChange = result.changes?.at(-1)
          if (result.ok && approvalPreview && actualChange?.after !== undefined
            && approvalPreview.from === undefined && approvalPreview.to === undefined
            && approvalPreview.operation !== 'delete' && actualChange.after !== approvalPreview.modifiedContent) {
            result.ok = false
            result.error = 'EDITOR_RESULT_DIFFERS'
            result.message = 'The content was updated, but the actual result differs from the proposed diff. Check the applied changes.'
          }
          const folderAttachmentProgress = getFolderAttachmentProgress(tool.name, args, result)
          const duration = Date.now() - startedAt
          agentDebugLog('tool_execute_end', {
            runId,
            iteration,
            toolName,
            ok: result.ok,
            duration,
            message: result.message,
            error: result.error,
            changeCount: result.changes?.length || 0,
          })

          if (result.changes) {
            for (const change of result.changes) {
              change.workspacePath = runWorkspaceIdentity
              change.outcome = /(?:EDITOR|FILE)_CHANGE_VERIFICATION_FAILED|EDITOR_RESULT_DIFFERS/.test(result.error || '')
                ? 'unverified' : 'applied'
              changes.push(change)
              callbacks.onChange?.(change)
              const changeTrace = recorder.add({
                type: 'change',
                title: change.summary || 'Record change',
                status: 'success',
                toolName,
                output: change,
                message: change.target,
              })
              callbacks.onTrace?.(changeTrace)
            }
          }

          toolCall.status = result.ok ? 'success' : 'error'
          toolCall.result = toolResultToLegacy(result)
          callbacks.onToolCall?.(toolCall)

          const step = buildStep(tool, args, result, duration)
          steps.push(step)
          callbacks.onStep?.(step)

          const editOutcome = hasFileEditPreview(tool.name)
            ? /(?:EDITOR|FILE)_CHANGE_VERIFICATION_FAILED|EDITOR_RESULT_DIFFERS/.test(result.error || '') ? 'unverified' as const
              : result.ok ? 'applied' as const
              : /CHANGED|MISMATCH|STALE/.test(result.error || '') ? 'stale' as const : 'not-applied' as const
            : undefined
          const updatedTrace = recorder.update(trace.id, {
            status: result.ok ? 'success' : 'error',
            duration,
            output: result,
            editOutcome,
            editSkipped: editOutcome === 'not-applied' || editOutcome === 'stale',
            approvalPreview,
            message: editOutcome === 'unverified' ? result.message : editOutcome === 'stale'
              ? 'The content or edit position has changed, so this change was not applied.'
              : editOutcome === 'not-applied' ? 'This change was not applied.'
                : [result.message, folderAttachmentProgress].filter(Boolean).join('\n\n'),
          })
          if (updatedTrace) callbacks.onTrace?.(updatedTrace)
          // An in-flight write can finish after Stop. Record its actual result first.
          if (this.stopped) throw new Error('USER_STOPPED')
          await assertRunWorkspace()
          if (editOutcome === 'unverified') {
            appendToolResult(toolUse.id, toolName, args, result)
            return completeFinalResponse(result.message)
          }
          if (editOutcome === 'not-applied' || editOutcome === 'stale') {
            appendToolResult(toolUse.id, toolName, args, result)
            return completeFinalResponse(approvalPreview
              ? 'Change not applied; the proposed diff can be reviewed in the conversation.' : 'Change not applied.')
          }

          if (tool.name === 'render_response' && !result.ok) clearResponsePreview()

          // An unanswered interaction must not let the remaining batch act on guessed input.
          const cancelledQuestion = tool.name === 'ask_user_question' && result.error === 'USER_CANCELLED_QUESTION'
          const cancelledUi = tool.name === 'show_ui' && result.error === 'USER_CANCELLED_UI'
          if (cancelledQuestion || cancelledUi) {
            appendToolResult(toolUse.id, tool.name, args, result)
            cancelRemainingToolCalls(toolIndex, 'The user interaction was cancelled or superseded by a new instruction.')
            if (this.steeringRequested) continue agentLoop
            const cancellationTitle = tool.name === 'show_ui' ? 'Interaction cancelled' : 'Question cancelled'
            finalContent = changes.length > 0
              ? `${cancellationTitle}; this round will not continue. ${changes.length} changes were already made; rely on the change log.`
              : `${cancellationTitle}; this round will not continue.`
            callbacks.onStatus?.('completed')
            callbacks.onFinalAnswerRender?.(finalContent)
            const finalTrace = recorder.add({ type: 'final', title: cancellationTitle, status: 'success', message: finalContent })
            callbacks.onTrace?.(finalTrace)
            return { runId, content: finalContent, stopped: false, steps, toolCalls, changes, trace: recorder.all() }
          }

          await agentEventBus.emit('post-tool-use', {
            runId,
            tool,
            input: args,
            result,
          })

          if (tool.name === 'render_response' && result.ok) {
            const data = result.data && typeof result.data === 'object' && !Array.isArray(result.data)
              ? result.data as Record<string, unknown>
              : undefined
            const content = typeof data?.content === 'string' ? data.content : ''
            if (content.trim()) {
              appendToolResult(toolUse.id, tool.name, args, result)
              await assertRunWorkspace()
              if (this.stopped) throw new Error('USER_STOPPED')
              if (this.steeringRequested) {
                callbacks.onCandidateAnswerClear?.()
                continue agentLoop
              }
              return completeFinalResponse(content, toolCall.id)
            }
          }

          let modelFacingResult = result
          let identicalReadResultRepeatCount = 0
          const readToolCallSignature = reusedLockedEditorState
            ? undefined
            : getReadToolCallSignature(tool, args)
          if (result.ok && readToolCallSignature) {
            const serializedResult = stringifyToolResult(result)
            const previousRead = readToolResultHistory.get(readToolCallSignature)

            if (previousRead?.result === serializedResult) {
              identicalReadResultRepeatCount = previousRead.repeatCount + 1
              readToolResultHistory.set(readToolCallSignature, {
                result: serializedResult,
                repeatCount: identicalReadResultRepeatCount,
              })
              modelFacingResult = {
                ...result,
                message: [
                  result.message,
                  'This read is identical to the previous one, and the previous result is still in context. Do not read again; use the existing result for the next write, or finish the answer directly.',
                ].join('\n\n'),
              }
            } else {
              readToolResultHistory.set(readToolCallSignature, {
                result: serializedResult,
                repeatCount: 0,
              })
            }
          }

          if (result.ok && isMutatingTool(tool) && !repeatedSuccessfulMutation) {
            modelFacingResult = {
              ...result,
              message: [
                result.message || 'The operation completed successfully.',
                'This operation already succeeded. Do not call the same tool again with the same arguments. If the user request is complete, give the final answer directly.',
              ].join('\n\n'),
            }
          } else if (!result.ok) {
            modelFacingResult = {
              ...result,
              message: [
                result.message || result.error || 'The tool did not return a confirmable success result.',
                guardsFailedToolCall(tool)
                  ? 'This operation was not confirmed successful. Do not repeat it with the same arguments; adjust the approach, use a different tool, or explain the situation to the user.'
                  : 'Adjust the arguments from this result, use a different tool, or explain the situation to the user directly; do not end the conversation while ignoring the error.',
              ].join('\n\n'),
            }
          }

          if (folderAttachmentProgress) {
            modelFacingResult = {
              ...modelFacingResult,
              message: [modelFacingResult.message, folderAttachmentProgress].filter(Boolean).join('\n\n'),
            }
          }

          appendToolResult(toolUse.id, tool.name, args, modelFacingResult)

          if (repeatedSuccessfulMutation || repeatedFailedMutation) {
            const reason = repeatedSuccessfulMutation
              ? `The same ${tool.title} operation already succeeded before, so this repeated call was not executed again.`
              : `The same ${tool.title} operation already failed before, so this repeated call was blocked.`
            cancelRemainingToolCalls(toolIndex, reason)
            prepareFinalResponse(reason)
            continue agentLoop
          }

          if (result.ok && tool.name === 'skill_load' && typeof args.skill_id === 'string') {
            loadedSkillIds.add(args.skill_id)
          }

          if (result.ok && mutationCallSignature && !repeatedSuccessfulMutation) {
            successfulMutationCalls.add(mutationCallSignature)
          }

          if (result.ok && typeof args.skill_id === 'string'
            && (tool.name === 'skill_install_node_dependencies' || tool.name === 'skill_install_python_dependencies')) {
            // Installing a missing dependency changes this Skill's execution
            // environment, so its exact previously failed source may be retried.
            for (const signature of failedToolResultHistory.keys()) {
              const separator = signature.indexOf(':')
              const failedToolName = signature.slice(0, separator)
              if (failedToolName !== 'skill_run_code' && failedToolName !== 'skill_execute_script') continue
              try {
                const failedArgs: unknown = JSON.parse(signature.slice(separator + 1))
                if (failedArgs && typeof failedArgs === 'object' && !Array.isArray(failedArgs)
                  && (failedArgs as Record<string, unknown>).skill_id === args.skill_id) {
                  failedToolResultHistory.delete(signature)
                }
              } catch {
                // An unrecognized signature must not reset unrelated failures.
                continue
              }
            }
          }

          if (!result.ok) {
            const failedCallSignature = `${tool.name}:${JSON.stringify(args)}`
            const serializedResult = stringifyToolResult(result)
            const previousFailure = failedToolResultHistory.get(failedCallSignature)
            const repeatCount = previousFailure ? previousFailure.repeatCount + 1 : 0
            failedToolResultHistory.set(failedCallSignature, {
              result: serializedResult,
              repeatCount,
            })
          } else {
            failedToolResultHistory.delete(`${tool.name}:${JSON.stringify(args)}`)
          }

          if (identicalReadResultRepeatCount >= MAX_IDENTICAL_READ_RESULT_REPEATS) {
            const reason = [
              `The model kept calling ${toolName} repeatedly while the read results never changed, so execution stopped to avoid a loop.`,
              writeActionCompleted ? 'Modifications completed earlier were kept.' : 'The modification is not complete yet.',
            ].join('\n')
            cancelRemainingToolCalls(toolIndex, reason)
            prepareFinalResponse(reason)
            continue agentLoop
          }

          if (result.ok && isMutatingTool(tool)) {
            writeActionCompleted = true
            readToolResultHistory.clear()
            latestEditorStateResult = undefined
            editorStateReadLocked = false
            editorSelectionReadLocked = false
          } else if (isEditorStateStaleResult(tool, result)) {
            latestEditorStateResult = undefined
            editorStateReadLocked = false
            editorSelectionReadLocked = false
          }

          if (result.ok && tool.name === 'editor_get_state') {
            if (!reusedLockedEditorState) {
              latestEditorStateResult = result
            }
            editorStateReadLocked = true
            const editorStateData = result.data && typeof result.data === 'object'
              ? result.data as { selection?: unknown }
              : undefined
            if (editorStateData?.selection) {
              editorSelectionReadLocked = true
            }
          }

          if (result.ok && tool.name === 'editor_get_selection') {
            editorSelectionReadLocked = true
          }

        }

        const madeProgress = toolResultEvidence.size > evidenceCountAtRoundStart
        consecutiveNoProgressRounds = madeProgress
          ? 0
          : consecutiveNoProgressRounds + 1
        agentDebugLog('agent_round_progress', {
          runId,
          iteration,
          madeProgress,
          newEvidenceCount: toolResultEvidence.size - evidenceCountAtRoundStart,
          consecutiveNoProgressRounds,
        })

        if (consecutiveNoProgressRounds >= MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS) {
          const completedWrite = writeActionCompleted || changes.length > 0
          const reason = completedWrite
            ? [
                'The modification executed successfully; the model produced no new tool results afterwards, so repeated calls were stopped.',
                changes.length > 0 ? `Recorded ${changes.length} successful changes this round in total.` : 'Repeated writes were ignored.',
              ].join('\n')
            : [
                `No new tool results for ${MAX_CONSECUTIVE_NO_PROGRESS_ROUNDS} consecutive rounds, so execution stopped to avoid a futile loop.`,
                'This task is not confirmed complete yet.',
              ].join('\n')
          prepareFinalResponse(reason)
          continue
        }

        if (iteration >= ABSOLUTE_MAX_MODEL_ROUNDS && !forceFinalResponseReason) {
          prepareFinalResponse(`Reached the tool execution safety limit of ${ABSOLUTE_MAX_MODEL_ROUNDS} rounds.`)
        }

      }

      finalContent = finalContent || `Reached the absolute safety limit of ${ABSOLUTE_MAX_MODEL_ROUNDS} rounds; the task may not be fully complete.`
      callbacks.onFinalAnswerRender?.(finalContent)
      return {
        runId,
        content: finalContent,
        stopped: false,
        steps,
        toolCalls,
        changes,
        trace: recorder.all(),
      }
    } catch (error) {
      clearResponsePreview()
      if (error instanceof Error && error.message.startsWith('WORKSPACE_CHANGED:')) {
        this.abortController?.abort()
        finalContent = 'The workspace has changed and this task has stopped. Start a new request in the target workspace.'
        finalizeInterruptedModelTrace('error', 'Workspace changed')
        const trace = recorder.add({ type: 'error', title: 'Workspace changed', status: 'error', message: finalContent, output: { error: 'WORKSPACE_CHANGED' } })
        callbacks.onTrace?.(trace)
        callbacks.onStatus?.('stopped')
        callbacks.onFinalAnswerRender?.(finalContent)
        return { runId, content: finalContent, stopped: true, steps, toolCalls, changes, trace: recorder.all() }
      }
      if (
        this.stopped
        || (error instanceof Error && error.message === 'USER_STOPPED')
        || isRequestAbortError(error)
      ) {
        // AbortController may surface an AbortError before the stream loop can throw
        // USER_STOPPED. Treat both paths as a normal stop and preserve what the
        // current model has already streamed to the user.
        finalContent = getSafeStoppedContent()
        finalizeInterruptedModelTrace('success', 'Model response stopped')
        callbacks.onStatus?.('stopped')
        if (finalContent) {
          callbacks.onFinalAnswerRender?.(finalContent)
        }
        return {
          runId,
          content: finalContent,
          stopped: true,
          steps,
          toolCalls,
          changes,
          trace: recorder.all(),
        }
      }

      callbacks.onStatus?.('failed')
      finalizeInterruptedModelTrace('error', 'Model response failed')
      const message = await handleAIError(error, false) || (error instanceof Error ? error.message : String(error))
      const errorTrace = recorder.add({
        type: 'error',
        title: 'Execution failed',
        status: 'error',
        message,
      })
      callbacks.onTrace?.(errorTrace)
      throw new Error(message, { cause: error })
    }
  }
}
