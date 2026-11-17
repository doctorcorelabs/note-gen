"use client"
import { Send, Square } from "lucide-react"
import useSettingStore from "@/stores/setting"
import useChatStore from "@/stores/chat"
import useTagStore from "@/stores/tag"
import { TooltipButton } from "@/components/tooltip-button"
import { useEffect, useImperativeHandle, forwardRef, useRef } from "react"
import { useTranslations } from "next-intl"
import { LinkedResource, isLinkedFolder, type MarkdownFile } from "@/lib/files"
import { platform } from "@/lib/platform"
import { getFilePathOptions, getWorkspacePath } from "@/lib/workspace"
import { AgentHandler } from "@/lib/agent/agent-handler"
import { requestChatUiInteraction } from '@/lib/chat-ui/interaction'
import { getChatResponseCompletion } from '@/lib/chat-ui/serialization'
import { fingerprintWorkspaceIdentity } from '@/lib/chat-ui/workspace'
import { getSkillWorkspaceIdentity } from '@/lib/skills/runtime'
import { agentSessionManager } from '@/lib/agent/agent-session-manager'
import { isRequestAbortError } from "@/lib/agent/runtime"
import { agentDebugLog, previewText } from "@/lib/agent/debug-log"
import { notifyPendingAgentApproval } from "@/lib/agent/approval-notification"
import { getToolByName } from "@/lib/agent/tools"
import { getSessionApprovalScope, matchesSessionApproval } from "@/lib/agent/session-approval"
import { ImageAttachment } from "./image-attachments"
import { cn } from "@/lib/utils"
import type { AgentEditPreview, AgentTraceEvent, ConfirmationRecord } from "@/lib/agent/types"
import type { AgentApprovalDecision, AgentSteeringPayload } from "@/lib/agent/types"
import { serializeChatAttachments, type RuntimeChatAttachment } from '@/lib/chat-attachments'
import { retainCompletedAgentTraceEvents } from '@/lib/agent/trace-retention'
import { noteGenModelDisplayName } from '@/components/notegen-model-label'
import { getAISettingsByModelId } from '@/lib/ai/utils'
import { applyChatReasoningOverride } from '@/lib/ai/chat-reasoning'
import type { AiConfig } from '@/app/core/setting/config'
import {
  buildChatImageContext,
  buildHistoricalImageContext,
  collectAgentImageAttachments,
  createPendingChatImageAnalyses,
  serializeChatImageAnalyses,
  type PersistedChatImageAnalysis,
} from '@/lib/chat-image-context'
import type { Chat } from '@/db/chats'
import {
  confirmEstimatedContextWindow,
  learnContextWindow,
  parseContextOverflowError,
  reduceLearnedContextWindow,
} from '@/lib/ai/model-capacity'
import type { CanvasSelectionContext } from '@/types/canvas'
import { useIsMobile } from '@/hooks/use-mobile'
import { chatAgentStateAdapter } from './chat-agent-state-adapter'
import { chatAgentResourceAdapter } from './chat-agent-resource-adapter'
import {
  buildAgentSteeringContext,
  buildBrowserPageContext,
  buildCanvasSelectionContext,
  buildMentionedContext,
  getContextualArticleSnapshot,
  type AgentQuoteData,
  type AgentRequestSnapshot,
} from './agent-session-context'
import { useChatAgentSession } from './use-chat-agent-session'

function resolveRecordedApprovalEvent(event: AgentTraceEvent, records: ConfirmationRecord[]): AgentTraceEvent {
  if (event.type !== 'approval' || event.approvalDecision) return event
  const record = records.findLast(item => item.traceEventId === event.id && item.runId === event.runId)
  if (!record || record.status === 'pending') return event
  const approved = record.status === 'confirmed'
  return {
    ...event,
    approvalDecision: approved ? 'approved' : record.status === 'superseded' ? 'steered' : 'denied',
    editOutcome: !approved && event.approvalPreview ? 'cancelled' : event.editOutcome,
    status: approved ? 'success' : 'error',
    message: approved ? '用户已确认操作。' : 'This confirmation was cancelled.',
  }
}

function finalizeInterruptedAgentEvent(event: AgentTraceEvent, finishedAt: number): AgentTraceEvent {
  if (event.status !== 'running' && event.status !== 'pending') return event
  if (event.type === 'approval') {
    return {
      ...event,
      approvalDecision: 'denied',
      editOutcome: event.approvalPreview ? 'cancelled' : event.editOutcome,
      status: 'success',
      message: 'This confirmation was cancelled.',
      duration: event.duration ?? Math.max(0, finishedAt - event.timestamp),
    }
  }
  if (event.approvalPreview && (event.type === 'tool_call' || event.type === 'tool_result')) {
    return {
      ...event,
      editOutcome: event.status === 'pending' ? 'cancelled' : 'unverified',
      status: 'error',
      message: event.status === 'pending' ? 'Change cancelled.' : 'The result needs verification. Check the current file.',
      duration: event.duration ?? Math.max(0, finishedAt - event.timestamp),
    }
  }
  return event
}

function getLastDisplayableAgentContent(
  liveContent: string | undefined,
  traceEvents: AgentTraceEvent[]
) {
  const currentContent = liveContent?.trim()
  if (currentContent) {
    return currentContent
  }

  for (let index = traceEvents.length - 1; index >= 0; index -= 1) {
    const event = traceEvents[index]
    if (
      (event.type === 'model_call' || event.type === 'model_response')
      && typeof event.output === 'string'
      && event.output.trim()
    ) {
      return event.output.trim()
    }

    if (event.type === 'final' && event.message?.trim()) {
      return event.message.trim()
    }
  }

  return ''
}

function isUnknownProviderError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error)
  return /500 Internal Server Error/i.test(text)
    && /"code"\s*:\s*60000/.test(text)
    && /Unknown error/i.test(text)
}

interface ChatSendProps {
  inputValue: string;
  preparingAttachments?: boolean;
  onSent?: () => void;
  linkedResource?: LinkedResource | null;
  attachedImages?: ImageAttachment[];
  fileAttachments?: RuntimeChatAttachment[];
  quoteData?: AgentQuoteData | null;
  canvasSelectionContext?: CanvasSelectionContext | null;
  selectedSkillIds?: string[];
  mentionedFiles?: MarkdownFile[];
  mentionedRecords?: AgentQuoteData[];
  mentionedCanvases?: CanvasSelectionContext[];
  browserTabId?: string | null;
  browserPageContextOverrides?: string[];
  browserExpectedUrl?: string | null;
  dockStyle?: boolean;
}

export interface ChatSendHandle {
  sendChat: () => void
  sendPrompt: (prompt: string) => void
}

export const ChatSend = forwardRef<ChatSendHandle, ChatSendProps>(({
  inputValue,
  preparingAttachments = false,
  onSent,
  linkedResource,
  attachedImages = [],
  fileAttachments = [],
  quoteData = null,
  canvasSelectionContext = null,
  selectedSkillIds = [],
  mentionedFiles = [],
  mentionedRecords = [],
  mentionedCanvases = [],
  browserTabId = null,
  browserPageContextOverrides = [],
  browserExpectedUrl = null,
  dockStyle = false,
}, ref) => {
  const { primaryModel, agentPermissionMode } = useSettingStore()
  const { currentTagId } = useTagStore()
  const {
    insert,
    loading,
    setLoading,
    saveChat,
    setAgentState,
    linkedResourcePreview,
  } = useChatStore()
  const abortControllerRef = useRef<AbortController | null>(null)
  const imageAnalysisAbortControllerRef = useRef<AbortController | null>(null)
  const steeringImageAnalysisAbortControllerRef = useRef<AbortController | null>(null)
  const manualStopRequestedRef = useRef(false)
  const repeatedScriptApprovalRef = useRef<{ signature: string; count: number }>({ signature: '', count: 0 })
  const contextOverflowRetryRef = useRef(0)
  const t = useTranslations()
  const isMobile = useIsMobile()
  const { session: agentSession, sessionId: agentSessionId } = useChatAgentSession()

  useEffect(() => agentSession.subscribe(event => {
    if (event.type === 'streaming_changed') {
      setLoading(event.isStreaming)
    }
  }), [agentSession])

  const createRequestSnapshot = (overrideText?: string): AgentRequestSnapshot => ({
    reasoningOverride: useChatStore.getState().reasoningOverride,
    inputValue: overrideText ?? inputValue,
    requestText: (overrideText ?? inputValue).trim() || t('record.chat.input.addAttachment.attachmentOnlyPrompt'),
    linkedResource,
    linkedResourcePreview,
    images: [...attachedImages],
    fileAttachments: [...fileAttachments],
    quoteData,
    canvasSelectionContext,
    selectedSkillIds: [...selectedSkillIds],
    mentionedFiles: [...mentionedFiles],
    mentionedRecords: [...mentionedRecords],
    mentionedCanvases: [...mentionedCanvases],
    browserTabId,
    browserPageContext: '',
  })

  const buildPartialSuccessContent = (result: string, toolCalls: { result?: { success?: boolean; data?: any; error?: string } }[]) => {
    const generatedOutputFiles = toolCalls.flatMap((toolCall) => {
      const outputFiles = toolCall.result?.data?.output_files
      return Array.isArray(outputFiles) ? outputFiles : []
    })

    const uniqueOutputFiles = Array.from(new Set(generatedOutputFiles.filter((file): file is string => typeof file === 'string' && file.trim().length > 0)))
    if (uniqueOutputFiles.length === 0) {
      return null
    }

    const failedToolCall = [...toolCalls].reverse().find((toolCall) => toolCall.result?.success === false)
    const failureMessage = failedToolCall?.result?.error || result

    return [
      `Files generated successfully:`,
      uniqueOutputFiles.map((file) => `- ${file}`).join('\n'),
      '',
      `Follow-up validation or additional steps failed: ${failureMessage}`,
    ].join('\n')
  }

  const sanitizeAgentFinalContent = (content: string) => {
    const trimmed = content.trim()
    if (!trimmed) {
      return trimmed
    }

    const markers = ['\nThought:', '\nAction:', '\nAction Input:']
    let cutoff = trimmed.length

    for (const marker of markers) {
      const index = trimmed.indexOf(marker)
      if (index !== -1) {
        cutoff = Math.min(cutoff, index)
      }
    }

    const leadingActionIndex = trimmed.search(/^(Thought:|Action:|Action Input:)/)
    if (leadingActionIndex === 0) {
      const finalAnswerMatch = trimmed.match(/Final Answer[:：]\s*([\s\S]*)/i)
      if (finalAnswerMatch) {
        return finalAnswerMatch[1].trim()
      }
    }

    return trimmed.slice(0, cutoff).trim()
  }

  const startProactiveCompaction = () => {
    const chatState = useChatStore.getState()
    if (
      chatState.isTemporaryConversation
      || !chatState.currentConversationId
    ) {
      return
    }

    const conversationId = chatState.currentConversationId
    void Promise.all([
      import('@/lib/ai/condense'),
      import('@/stores/article'),
    ])
      .then(([{ prepareConversationHistory }, { default: useArticleStore }]) => {
        const latestChatState = useChatStore.getState()
        if (latestChatState.currentConversationId !== conversationId) {
          return
        }

        const articleState = useArticleStore.getState()
        const activeArticle = getContextualArticleSnapshot(articleState, isMobile)
        const additionalContext = activeArticle.activeFilePath
          ? activeArticle.currentArticle || ''
          : ''

        return prepareConversationHistory({
          conversationId,
          chats: latestChatState.chats,
          currentUserInput: '',
          additionalContext,
          imageCount: 0,
          proactive: true,
        })
      })
      .catch(error => {
        console.error('[ConversationCompaction] Background compaction failed:', error)
      })
  }

  useImperativeHandle(ref, () => ({
    sendChat: () => void handleSubmit(),
    sendPrompt: (prompt: string) => void handleSubmit(prompt),
  }))

  // Agent 确认回调 - 使用内联确认而不是弹窗
  const requestConfirmation = (
    toolName: string,
    params: Record<string, any>,
    context?: AgentEditPreview,
    target?: { chatId: number; conversationId?: number; workspacePath: string },
  ): Promise<AgentApprovalDecision> => {
    const tool = getToolByName(toolName)
    const sessionApprovalScope = getSessionApprovalScope(toolName, tool, params)
    const canApproveForSession = !!sessionApprovalScope
    const approvalSignature = sessionApprovalScope
      ? `${toolName}:${JSON.stringify(params)}`
      : ''
    if (approvalSignature) {
      repeatedScriptApprovalRef.current = repeatedScriptApprovalRef.current.signature === approvalSignature
        ? { signature: approvalSignature, count: repeatedScriptApprovalRef.current.count + 1 }
        : { signature: approvalSignature, count: 1 }
    }
    const requiresRepeatConfirmation = repeatedScriptApprovalRef.current.count >= 3
    if (requiresRepeatConfirmation) {
      repeatedScriptApprovalRef.current = { signature: '', count: 0 }
    }

    const currentChatState = useChatStore.getState()
    const activeConversationId = target ? target.conversationId ?? null : currentChatState.currentConversationId
    const activeState = currentChatState.agentState
    const workspacePath = target?.workspacePath ?? useSettingStore.getState().workspacePath
    if ((target && activeState.activeChatId !== target.chatId)
      || useSettingStore.getState().workspacePath !== workspacePath) return Promise.resolve('denied')
    const autoApproveConversationId = currentChatState.agentAutoApproveConversationId
    const autoApproveRuntimeScriptKey = currentChatState.agentAutoApproveRuntimeScriptKey

    if (!requiresRepeatConfirmation && matchesSessionApproval(
      autoApproveConversationId,
      activeConversationId,
      autoApproveRuntimeScriptKey,
      sessionApprovalScope
    )) {
      agentDebugLog('approval_auto_approved', {
        toolName,
        params,
        activeConversationId,
        sessionApprovalScope,
      })
      return Promise.resolve('approved')
    }

    return new Promise((resolve) => {
      const id = crypto.randomUUID()
      const runId = activeState.runId
      const chatId = target?.chatId ?? activeState.activeChatId
      const traceEventId = activeState.traceEvents?.findLast(event =>
        event.runId === runId && event.type === 'approval' && event.toolName === toolName && event.status === 'running'
      )?.id
      let settled = false
      let unsubscribeChat = () => {}
      let unsubscribeSettings = () => {}
      const finish = (decision: AgentApprovalDecision) => {
        if (settled) return
        settled = true
        unsubscribeChat()
        unsubscribeSettings()
        const latest = useChatStore.getState()
        if (latest.agentState.pendingConfirmation?.id === id) {
          latest.setAgentState({ pendingConfirmation: undefined })
        }
        resolve(decision)
      }
      agentDebugLog('approval_pending_set', { id, toolName, params, context, canApproveForSession, sessionApprovalScope })
      setAgentState({
        pendingConfirmation: {
          ...context,
          id, runId, chatId, conversationId: activeConversationId ?? undefined,
          traceEventId, workspacePath, toolName, params,
          previewParams: context?.previewParams,
          canApproveForSession,
          sessionApprovalType: sessionApprovalScope?.type,
          sessionApprovalKey: sessionApprovalScope?.permissionKey,
        },
      })
      unsubscribeChat = useChatStore.subscribe(state => {
        if (state.agentState.pendingConfirmation?.id !== id) {
          const record = state.agentState.confirmationHistory.findLast(item => item.id === id)
          finish(record?.status === 'confirmed' ? 'approved' : record?.status === 'superseded' ? 'steered' : 'denied')
        } else if (state.agentState.runId !== runId || state.agentState.activeChatId !== chatId
          || !state.agentState.isRunning
          || (chatId !== undefined && chatId < 0 && (!state.isTemporaryConversation || !state.chats.some(chat => chat.id === chatId)))) {
          finish('denied')
        }
      })
      unsubscribeSettings = useSettingStore.subscribe(state => {
        if (state.workspacePath !== workspacePath) finish('denied')
      })
      void notifyPendingAgentApproval({
        title: t('record.chat.input.agent.confirmation.notification.title'),
        body: t('record.chat.input.agent.confirmation.notification.description'),
      })
    })
  }

  // Agent 模式处理
  const requestUserQuestion = (questions: import('@/lib/agent/types').AgentUserQuestion[], signal?: AbortSignal, conversationId?: number): Promise<import('@/lib/agent/types').AgentUserAnswer[] | null> => {
    if (signal?.aborted) return Promise.resolve(null)
    return new Promise((resolve) => {
      const id = crypto.randomUUID()
      const source = useChatStore.getState().agentState
      const chatId = source.activeChatId
      const runId = source.runId
      const workspacePath = useSettingStore.getState().workspacePath
      const traceEventId = source.traceEvents?.findLast(event => event.runId === runId && event.toolName === 'ask_user_question' && event.type === 'tool_call' && event.status === 'running')?.id
      const toolCallId = source.toolCalls.findLast(call => call.toolName === 'ask_user_question' && call.status === 'running')?.id
      let settled = false
      let unsubscribe = () => {}
      let unsubscribeSettings = () => {}
      const finish = (answers: import('@/lib/agent/types').AgentUserAnswer[] | null) => {
        if (settled) return
        settled = true
        unsubscribe()
        unsubscribeSettings()
        signal?.removeEventListener('abort', abort)
        if (useChatStore.getState().agentState.pendingQuestion?.id === id) {
          setAgentState({ pendingQuestion: undefined, ...(useChatStore.getState().agentState.runId === runId && useChatStore.getState().agentState.isRunning ? { status: 'calling_tool' as const } : {}) })
        }
        resolve(answers)
      }
      const abort = () => finish(null)
      setAgentState({ pendingQuestion: { id, conversationId, chatId, runId, traceEventId, toolCallId, workspacePath, questions }, status: 'waiting_answer', isThinking: false })
      unsubscribe = useChatStore.subscribe((state) => {
        const pending = state.agentState.pendingQuestion
        if (pending?.id !== id || state.agentState.runId !== runId || !state.agentState.isRunning
          || (chatId !== undefined && chatId < 0 && (!state.isTemporaryConversation || !state.chats.some(chat => chat.id === chatId)))) finish(null)
        else if (pending.response !== undefined) finish(pending.response)
      })
      unsubscribeSettings = useSettingStore.subscribe(state => { if (state.workspacePath !== workspacePath) finish(null) })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      void notifyPendingAgentApproval({
        title: t('record.chat.input.agent.question.notificationTitle'),
        body: t('record.chat.input.agent.question.notificationBody'),
      })
    })
  }

  async function handleAgentMode(
    request: AgentRequestSnapshot,
    userMessage: Chat,
    modelSnapshot: { id: string; name: string; config?: AiConfig }
  ) {
    // 先创建一个占位的 AI 消息
    const placeholderMessage = await insert({
      tagId: currentTagId,
      role: 'system',
      content: '',
      type: 'chat',
      inserted: false,
    })

    if (!placeholderMessage) return

    setAgentState({
      activeChatId: placeholderMessage.id,
    })

    const useArticleStore = (await import('@/stores/article')).default
    const articleStore = useArticleStore.getState()
    const activeArticle = getContextualArticleSnapshot(articleStore, isMobile)
    const useCanvasStore = (await import('@/stores/canvas')).default
    const canvasStore = useCanvasStore.getState()
    const mobileContexts = useChatStore.getState().mobileActiveContexts
    const activeCanvasId = !isMobile || mobileContexts.canvasId
      ? canvasStore.activeCanvasId
      : null
    let pendingCapacityProbe: { contextWindow: number } | undefined
    let deferredOverflowError: string | undefined
    let contextCapacityProbeActive = false
    const agentImageAttachments = collectAgentImageAttachments(
      useChatStore.getState().chats.filter(chat => chat.id !== userMessage.id)
    )

    const persistAgentError = async (error: string) => {
      const currentState = useChatStore.getState()
      const currentMessage = currentState.chats.find(c => c.id === placeholderMessage.id)
      const resolvedRagSources = currentState.agentState.ragSources?.length
        ? JSON.stringify(currentState.agentState.ragSources)
        : currentMessage?.ragSources
      const resolvedRagSourceDetails = currentState.agentState.ragSourceDetails?.length
        ? JSON.stringify(currentState.agentState.ragSourceDetails)
        : currentMessage?.ragSourceDetails
      const aborted = manualStopRequestedRef.current || isRequestAbortError(error)
      const preservedContent = getLastDisplayableAgentContent(
        currentState.agentState.finalAnswerContent,
        currentState.agentState.traceEvents || []
      )
      const stoppedAt = Date.now()
      const completedTraceEvents = (currentState.agentState.traceEvents || []).map(rawEvent => {
        const event = finalizeInterruptedAgentEvent(
          resolveRecordedApprovalEvent(rawEvent, currentState.agentState.confirmationHistory), stoppedAt
        )
        if (event.status !== 'running') {
          return event
        }

        return {
          ...event,
          status: aborted ? 'success' as const : 'error' as const,
          duration: event.duration ?? Math.max(0, stoppedAt - event.timestamp),
        }
      })
      const traceEvents = retainCompletedAgentTraceEvents(completedTraceEvents)
      const agentHistory = {
        modelId: modelSnapshot.id,
        modelName: modelSnapshot.name,
        steps: currentState.agentState.completedSteps || [],
        toolCalls: currentState.agentState.toolCalls,
        traceEvents,
        changes: currentState.agentState.changes || [],
        runId: currentState.agentState.runId,
        workspaceFingerprint,
        status: aborted ? 'stopped' : 'failed',
        loadedSkills: currentState.agentState.loadedSkills || [],
        selectedSkills: currentState.agentState.selectedSkills || [],
        iterations: currentState.agentState.currentIteration,
      }

      await saveChat({
        id: placeholderMessage.id,
        tagId: placeholderMessage.tagId,
        conversationId: placeholderMessage.conversationId,
        role: placeholderMessage.role,
        type: placeholderMessage.type,
        inserted: placeholderMessage.inserted,
        createdAt: placeholderMessage.createdAt,
        ragSources: resolvedRagSources,
        ragSourceDetails: resolvedRagSourceDetails,
        content: aborted
          ? preservedContent || t('record.chat.input.stopped')
          : `Error: ${error}`,
        agentHistory: JSON.stringify(agentHistory),
      }, true)

      setAgentState({
        activeChatId: undefined,
        isFinalAnswerMode: false,
        finalAnswerContent: undefined,
        status: aborted ? 'stopped' : 'failed',
        isRunning: false,
        isThinking: false,
        traceEvents,
      })
    }

    // 每次都创建新的 AgentHandler，使用当前的 placeholderMessage
    const agentWorkspacePath = useSettingStore.getState().workspacePath
    const workspaceFingerprint = await fingerprintWorkspaceIdentity(getSkillWorkspaceIdentity(await getWorkspacePath()))
    if (useSettingStore.getState().workspacePath !== agentWorkspacePath) throw new Error('WORKSPACE_CHANGED')
    const agentHandler = new AgentHandler({
      stateAdapter: chatAgentStateAdapter,
      resourceAdapter: chatAgentResourceAdapter,
      activeChatId: placeholderMessage.id,
      modelId: modelSnapshot.id,
      modelName: modelSnapshot.name,
      aiConfig: modelSnapshot.config,
      conversationId: placeholderMessage.conversationId,
      workspaceId: useSettingStore.getState().workspacePath.trim().replace(/\\/g, '/').replace(/\/+$/, '') || 'default',
      useMemories: !useChatStore.getState().isTemporaryConversation,
      activeFilePath: activeArticle.activeFilePath,
      activeCanvasId: activeCanvasId || undefined,
      permissionMode: agentPermissionMode,
      requestConfirmation: (toolName, params, context) => requestConfirmation(toolName, params, context, { chatId: placeholderMessage.id, conversationId: placeholderMessage.conversationId, workspacePath: agentWorkspacePath }),
      requestUserQuestion: (questions, signal) => requestUserQuestion(questions, signal, placeholderMessage.conversationId),
      requestUserInteraction: (uiRequest, context) => requestChatUiInteraction(uiRequest, context, {
        chatId: placeholderMessage.id,
        conversationId: placeholderMessage.conversationId,
      }),
      currentQuote: request.quoteData
        ? {
            fileName: request.quoteData.fileName,
            articlePath: request.quoteData.articlePath,
            startLine: request.quoteData.startLine,
            endLine: request.quoteData.endLine,
            from: request.quoteData.from,
            to: request.quoteData.to,
            fullContent: request.quoteData.fullContent,
            selectionToken: request.quoteData.selectionToken,
          }
        : undefined,
      attachments: request.fileAttachments,
      imageAttachments: agentImageAttachments,
      selectedSkills: request.selectedSkillIds,
      onSteeringDelivered: sequences => agentSession.acknowledgeSteering(sequences),
      onFinalAnswerRender: (markdownContent) => {
        // 检测到 Final Answer 时触发渲染
        setAgentState({
          activeChatId: placeholderMessage.id,
          isFinalAnswerMode: true,
          finalAnswerContent: markdownContent
        })
      },
      formatAutoFinalAnswer: (key, values) => t(key as any, values),
      onComplete: async (result, steps, stopped) => {
        deferredOverflowError = undefined
        // 获取 Agent 执行历史，保存结构化运行轨迹
        const { agentState } = useChatStore.getState()
        const renderedResponseCompleted = Boolean(getChatResponseCompletion(agentState))
        const effectivelyStopped = Boolean(stopped)
          || manualStopRequestedRef.current
          || (!renderedResponseCompleted && isRequestAbortError(result))
        if (!effectivelyStopped && pendingCapacityProbe) {
          const aiConfig = modelSnapshot.config
          if (aiConfig) {
            await confirmEstimatedContextWindow(
              aiConfig,
              pendingCapacityProbe.contextWindow
            )
          }
          pendingCapacityProbe = undefined
        }
        const completedAt = Date.now()
        const completedTraceEvents = (agentState.traceEvents || []).map(rawEvent => {
          const recordedEvent = resolveRecordedApprovalEvent(rawEvent, agentState.confirmationHistory)
          const event = effectivelyStopped ? finalizeInterruptedAgentEvent(recordedEvent, completedAt) : recordedEvent
          if (event.status !== 'running') {
            return event
          }

          return {
            ...event,
            status: effectivelyStopped ? 'success' as const : event.status,
            duration: event.duration ?? Math.max(0, completedAt - event.timestamp),
          }
        })
        const traceEvents = retainCompletedAgentTraceEvents(completedTraceEvents)
        // 使用 agentState.completedSteps 而不是 steps 参数，因为 completedSteps 包含 duration 信息
        const agentHistory = {
          modelId: modelSnapshot.id,
          modelName: modelSnapshot.name,
          steps: agentState.completedSteps || [],
          toolCalls: agentState.toolCalls,
          traceEvents,
          changes: agentState.changes || [],
          runId: agentState.runId,
          workspaceFingerprint,
          status: effectivelyStopped ? 'stopped' : agentState.status,
          loadedSkills: agentState.loadedSkills || [],
          selectedSkills: agentState.selectedSkills || [],
          iterations: agentState.currentIteration,
        }

        let finalContent = result
        if (effectivelyStopped) {
          const lastDisplayableContent = getLastDisplayableAgentContent(
            agentState.finalAnswerContent,
            completedTraceEvents
          )
          if (lastDisplayableContent) {
            finalContent = lastDisplayableContent
          } else if (isRequestAbortError(finalContent)) {
            finalContent = ''
          }
        }
        if (effectivelyStopped && !finalContent.trim()) {
          // 只有尚未产生任何正文时才显示终止提示；已有的流式正文原样保留。
          finalContent = t('record.chat.input.stopped')
        }

        if (!effectivelyStopped && !renderedResponseCompleted) {
          const partialSuccessContent = buildPartialSuccessContent(result, agentState.toolCalls)
          if (partialSuccessContent && /^工具 .+执行失败：|^工具 .+执行出错：|^Error:/.test(finalContent.trim())) {
            finalContent = partialSuccessContent
          }
        }

        if (!renderedResponseCompleted || effectivelyStopped) {
          finalContent = sanitizeAgentFinalContent(finalContent)
        }

        const currentState = useChatStore.getState()
        const currentMessage = currentState.chats.find(c => c.id === placeholderMessage.id)
        const resolvedRagSources = agentState.ragSources?.length
          ? JSON.stringify(agentState.ragSources)
          : currentMessage?.ragSources
        const resolvedRagSourceDetails = agentState.ragSourceDetails?.length
          ? JSON.stringify(agentState.ragSourceDetails)
          : currentMessage?.ragSourceDetails

        // 更新占位消息，保留 RAG 相关字段
        await saveChat({
          id: placeholderMessage.id,
          tagId: placeholderMessage.tagId,
          conversationId: placeholderMessage.conversationId,
          role: placeholderMessage.role,
          type: placeholderMessage.type,
          inserted: placeholderMessage.inserted,
          createdAt: placeholderMessage.createdAt,
          ragSources: resolvedRagSources,
          ragSourceDetails: resolvedRagSourceDetails,
          // 设置新的内容
          content: finalContent,
          agentHistory: JSON.stringify(agentHistory),
        }, true)

        // 清空 Final Answer 模式状态
        setAgentState({
          activeChatId: undefined,
          isFinalAnswerMode: false,
          finalAnswerContent: undefined,
          traceEvents,
        })

        if (!effectivelyStopped) {
          startProactiveCompaction()
          const { scheduleConversationMemoryExtraction } = await import('@/lib/memory/auto-memory')
          scheduleConversationMemoryExtraction(placeholderMessage.conversationId)
        }

      },
      onError: async (error) => {
        const parsedOverflow = parseContextOverflowError(error)
        const inferredOverflow =
          !parsedOverflow.detected
          && contextCapacityProbeActive
          && isUnknownProviderError(error)
        const overflow = inferredOverflow
          ? { detected: true }
          : parsedOverflow
        if (inferredOverflow) {
          agentDebugLog('context_overflow_inferred_from_provider_error', {
            error,
            reason: 'unknown_provider_error_during_capacity_probe',
          })
        }
        if (overflow.detected) {
          const aiConfig = modelSnapshot.config
          if (aiConfig) {
            if (overflow.contextWindow) {
              await learnContextWindow(aiConfig, overflow.contextWindow)
            } else {
              await reduceLearnedContextWindow(aiConfig)
            }
          }
        }

        const currentState = useChatStore.getState()
        const canRecoverFromOverflow =
          overflow.detected
          && contextOverflowRetryRef.current === 0
          && currentState.agentState.toolCalls.length === 0
          && !currentState.isTemporaryConversation
          && Boolean(currentState.currentConversationId)
        if (canRecoverFromOverflow) {
          deferredOverflowError = error
          agentDebugLog('context_overflow_error_deferred', {
            conversationId: currentState.currentConversationId,
            contextWindow: overflow.contextWindow || null,
          })
          return
        }

        deferredOverflowError = undefined
        await persistAgentError(error)
      },
    })

    agentSession.setActiveRunner(agentHandler)

    try {
      // 构建上下文信息
      let context = ''

      // 1. 图片先由专用视觉模型识别，失败时回退 OCR。
      // 主聊天模型只接收结构化识别结果，不依赖自身的视觉能力。
      if (request.images.length > 0) {
        imageAnalysisAbortControllerRef.current?.abort()
        const imageAnalysisAbortController = new AbortController()
        imageAnalysisAbortControllerRef.current = imageAnalysisAbortController
        let liveAnalyses = createPendingChatImageAnalyses(request.images, request.requestText)
        const updatePersistedAnalysis = (analyses: PersistedChatImageAnalysis[], persist: boolean) => {
          const updatedMessage = {
            ...userMessage,
            imageAnalyses: serializeChatImageAnalyses(analyses),
          }
          if (persist) {
            return saveChat(updatedMessage, true)
          } else {
            useChatStore.getState().updateChat(updatedMessage)
          }
        }

        setAgentState({
          status: 'analyzing_images',
          isRunning: true,
          isThinking: false,
        })
        const imageResult = await buildChatImageContext(request.images, request.requestText, {
          signal: imageAnalysisAbortController.signal,
          onProgress: (progress) => {
            liveAnalyses = liveAnalyses.map(analysis => (
              analysis.imageId === progress.imageId
                ? {
                    ...analysis,
                    status: progress.status,
                    method: progress.method ?? analysis.method,
                    errorCode: progress.errorCode,
                    updatedAt: Date.now(),
                  }
                : analysis
            ))
            updatePersistedAnalysis(liveAnalyses, false)
          },
        })
        imageAnalysisAbortControllerRef.current = null
        await updatePersistedAnalysis(imageResult.analyses, true)
        agentImageAttachments.push(...imageResult.analyses.map(analysis => ({
          ...analysis,
          chatId: userMessage.id,
        })))
        if (imageResult.context) {
          context += `${imageResult.context}\n`
        }

        agentDebugLog('chat_context_images_analyzed', {
          imageCount: request.images.length,
          contextLength: imageResult.context.length,
          preview: previewText(imageResult.context),
        })
      }

      const historicalImageContext = buildHistoricalImageContext(
        useChatStore.getState().chats.filter(chat => chat.id !== userMessage.id)
      )
      if (historicalImageContext) {
        context += `${historicalImageContext}\n`
      }

      // 2. 当前编辑器内容由 AgentHandler 在模型调用前读取实时快照并注入系统提示词。
      // 这里不再重复追加 currentArticle，避免同一篇正文占用两份上下文。

      agentDebugLog('chat_context_active_note', {
        activeFilePath: activeArticle.activeFilePath || null,
        currentArticleLength: activeArticle.currentArticle.length,
        injected: false,
        injectedByRuntimeSnapshot: Boolean(activeArticle.activeFilePath),
        preview: previewText(activeArticle.currentArticle),
      })
      // 3. 关联文件夹作为 Agent 自动检索时的优先范围，不在发送前预先检索。
      if (request.linkedResource && isLinkedFolder(request.linkedResource)) {
        context += [
          '## User-Linked Note Folder',
          `The user linked the folder “${request.linkedResource.name}” (${request.linkedResource.relativePath}).`,
          'If the current request needs to look up user material, prefer knowledge_search with folderPath set to this relative path. Do not search when it is not needed.',
          '',
        ].join('\n')
      }

      // 4. 如果有关联文件（非文件夹），始终注入完整内容作为 Agent 上下文
      const linkedResourceIsActiveFile = request.linkedResource && !isLinkedFolder(request.linkedResource) && (
        request.linkedResource.relativePath === activeArticle.activeFilePath ||
        request.linkedResource.path === activeArticle.activeFilePath ||
        request.linkedResource.name === activeArticle.activeFilePath.split('/').pop()
      )

      if (request.linkedResource && !isLinkedFolder(request.linkedResource) && !linkedResourceIsActiveFile) {
        try {
          const workspace = await getWorkspacePath()
          let linkedFileContent = ''
          if (workspace.isCustom) {
            linkedFileContent = await platform.fs.readTextFile(request.linkedResource.path)
          } else {
            const { path, baseDir } = await getFilePathOptions(request.linkedResource.path)
            linkedFileContent = await platform.fs.readTextFile(path, { baseDir })
          }

          if (request.linkedResourcePreview) {
            context += `\n${request.linkedResourcePreview}\n`
          }

          if (linkedFileContent) {
            context += `\n## Full Content of Linked File\n\nThe full content of the linked file "${request.linkedResource.name}" (${request.linkedResource.relativePath}) is already included below. Do not call tools to read or check this same file again unless the user explicitly asks to refresh it.\n\n---\n${linkedFileContent}\n---\n`
          }

          agentDebugLog('chat_context_linked_file', {
            name: request.linkedResource.name,
            relativePath: request.linkedResource.relativePath,
            contentLength: linkedFileContent.length,
            hasPreview: Boolean(request.linkedResourcePreview),
          })
        } catch (error) {
          console.error('Failed to read linked file in Agent mode:', error)
        }
      } else if (linkedResourceIsActiveFile) {
        agentDebugLog('chat_context_linked_file_skipped', {
          reason: 'linked file is already the active editor file',
          name: request.linkedResource?.name,
          relativePath: request.linkedResource?.relativePath,
        })
      }

      // 5. 如果有引用内容，添加引用上下文（在构建消息之前）
      if (request.quoteData) {
        const { fileName, startLine, endLine, fullContent, from, to } = request.quoteData
        let lineInfo = ''
        const hasValidLineNumbers = startLine !== -1 && endLine !== -1
        const hasValidRange = from >= 0 && to >= from

        if (hasValidLineNumbers) {
          if (startLine === endLine) {
            lineInfo = `line ${startLine}`
          } else {
            lineInfo = `lines ${startLine}-${endLine}`
          }
        }

        context += `\n## 📌 User-Quoted Content

The user quoted the following content from the note "${fileName}" ${lineInfo}:

---
${fullContent}
---

${hasValidRange ? `**Only edit when the user explicitly asks to modify/rewrite/expand/insert.**

If the user is asking a question, or asking for an explanation, summary, analysis, translation, polish suggestions, or code explanation, answer directly from this quoted content and **do not call any editing tools**.

If the user explicitly says "translate this sentence/paragraph/selected content into some language", that is an edit request: use editor_replace_range directly. The existing from/to are sufficient; do not call editor_get_state or editor_get_selection.

**🚨 Only when the user explicitly asks for changes, replace exactly the selected range**: this quoted content comes from an editor selection. Prefer editor_replace_range and replace only this selected content:
- from: ${from}
- to: ${to}
- Pass the new content via content
- Only replace this selection; do not expand to the whole document or beyond the paragraph

**If the user says "insert/add/append before/after/above/below this passage"**:
- Still use editor_replace_range
- Replace the whole current quoted range
- Insert before: new content + original quoted content
- Insert after: original quoted content + new content
- Do not use editor_insert_at_cursor, because chat input blurs the editor and the current cursor position is unreliable

**If the user explicitly asks to "add content both before and after"**:
- Still use editor_replace_range
- Pass the final replacement content directly via content: inserted-before content + original quoted content + inserted-after content
- Do not use extra protocol markers; the tool writes content verbatim into the selection

**Fallback line-number information**:
- Single-line edit: startLine: ${startLine}, endLine: ${endLine}
- Multi-line range: startLine: ${startLine}, endLine: ${endLine}

**Forbidden**:
- Do not call editing tools for explanation/analysis requests
- Do not change content outside the selection
- Do not fetch the whole document and rewrite it entirely
- Do not change startLine/endLine to 1/1 on your own` : hasValidLineNumbers ? `**Only edit when the user explicitly asks to modify/rewrite/expand/insert.**

If the user is asking a question, or asking for an explanation, summary, analysis, translation, polish suggestions, or code explanation, answer directly from this quoted content and **do not call any editing tools**.

If the user explicitly says "translate this sentence/paragraph/selected content into some language", that is an edit request: use editor_replace_lines directly. The existing line numbers are sufficient; do not call editor_get_state or editor_get_selection.

**🚨 Only when the user explicitly asks for changes, edit by line numbers**: when the user quotes content and asks for changes, you must use editor_replace_lines with exact line numbers:
- Single-line edit: startLine: ${startLine}, endLine: ${endLine}
- Multi-line range: startLine: ${startLine}, endLine: ${endLine}
- You must pass the new content via the replaceContent parameter

**Forbidden**:
- Do not call editing tools for explanation/analysis requests
- Do not use from/to position parameters
- Do not use the searchContent text-search mode
- Do not fetch the whole document content before operating` : `**Note**: this quoted content only has the selected text, with no safely usable Markdown source position.

- If the user is only asking, explaining, summarizing, or analyzing, answer directly and do not call editing tools.
- If the user explicitly asks to modify the current selection, only call editor_insert_at_cursor with replaceSelection=true.
- Do not guess from/to or line numbers; if the active selection has changed, the tool fails safely.`}

Answer the user question based on this quoted content.

`

        agentDebugLog('chat_context_quote', {
          fileName,
          startLine,
          endLine,
          from,
          to,
          quoteLength: request.quoteData.quote.length,
          contentLength: fullContent.length,
          quotePreview: previewText(request.quoteData.quote),
          fullContentPreview: previewText(fullContent),
          hasValidRange,
        })
      }

      context += buildCanvasSelectionContext(request.canvasSelectionContext)
      context += request.browserPageContext
      context += await buildMentionedContext({
        files: request.mentionedFiles,
        records: request.mentionedRecords,
        canvases: request.mentionedCanvases,
      })

      // 6. 构建消息数组：较早回合使用会话级锚定摘要，最近完整回合保留原文
      const compactionContext = [
        context,
        activeArticle.activeFilePath ? activeArticle.currentArticle : '',
      ].filter(Boolean).join('\n\n')
      const chatState = useChatStore.getState()
      const { chats } = chatState
      const {
        buildMessagesWithHistory,
        prepareConversationHistory,
      } = await import('@/lib/ai/condense')
      let preparedHistory: Awaited<ReturnType<typeof prepareConversationHistory>> | null = null
      if (!chatState.isTemporaryConversation && chatState.currentConversationId) {
        try {
          preparedHistory = await prepareConversationHistory({
            conversationId: chatState.currentConversationId,
            aiConfig: modelSnapshot.config,
            chats,
            currentUserInput: request.requestText,
            additionalContext: compactionContext,
            imageCount: 0,
          })
          pendingCapacityProbe = preparedHistory.capacityProbe
          contextCapacityProbeActive = Boolean(
            preparedHistory.capacityProbe
            || preparedHistory.capacityLimitProbe
          )
        } catch (error) {
          console.error('[ConversationCompaction] Failed to prepare history:', error)
        }
      }

      // 使用 buildMessagesWithHistory 构建完整的消息数组
      // 注意：Agent 模式下，不传入 systemPrompt（Agent 会自己构建）
      // 将所有上下文（文章、RAG、关联文件、引用）作为 additionalContext
      let messages = buildMessagesWithHistory(
        chats,
        undefined, // systemPrompt - Agent 会自己构建
        context,   // additionalContext - 包含文章、RAG、关联文件、引用等
        undefined, // currentUserInput - AgentRuntime 负责且只注入一次
        {
          // Agent 自己会在 think() 里重新注入当前请求，避免重复。
          // 保留 assistant 历史；已由会话级摘要覆盖的旧回合会在构建阶段排除。
          includeAssistantMessages: true,
          includeLatestUserMessage: false,
          conversationSummary: preparedHistory?.compaction?.summary,
          coveredThroughChatId: preparedHistory?.compaction?.coveredThroughChatId,
        }
      )

      agentDebugLog('chat_messages_built', {
        userInput: request.requestText,
        contextLength: context.length,
        compactionRevision: preparedHistory?.compaction?.revision || null,
        compactionSource: preparedHistory?.capacity.source || null,
        compactionWindow: preparedHistory?.capacity.contextWindow || null,
        messageCount: messages.length,
        messages: messages.map((message, index) => ({
          index,
          role: message.role,
          contentLength: message.content.length,
          preview: previewText(message.content),
        })),
      })

      try {
        await agentHandler.execute(request.requestText, messages)
      } catch (error) {
        const parsedOverflow = parseContextOverflowError(error)
        const overflow =
          !parsedOverflow.detected
          && contextCapacityProbeActive
          && isUnknownProviderError(error)
            ? { detected: true }
            : parsedOverflow
        const canRetry =
          overflow.detected
          && contextOverflowRetryRef.current === 0
          && useChatStore.getState().agentState.toolCalls.length === 0
          && !chatState.isTemporaryConversation
          && Boolean(chatState.currentConversationId)

        if (!canRetry || !chatState.currentConversationId) {
          throw error
        }

        contextOverflowRetryRef.current = 1
        const previousCompactionRevision = preparedHistory?.compaction?.revision
        preparedHistory = await prepareConversationHistory({
          conversationId: chatState.currentConversationId,
          aiConfig: modelSnapshot.config,
          chats: useChatStore.getState().chats,
          currentUserInput: request.requestText,
          additionalContext: compactionContext,
          imageCount: 0,
          force: true,
        })
        pendingCapacityProbe = preparedHistory.capacityProbe
        contextCapacityProbeActive = false
        if (
          !preparedHistory.compacted
          && preparedHistory.compaction?.revision === previousCompactionRevision
        ) {
          throw error
        }
        messages = buildMessagesWithHistory(
          useChatStore.getState().chats,
          undefined,
          context,
          undefined,
          {
            includeAssistantMessages: true,
            includeLatestUserMessage: false,
            conversationSummary: preparedHistory.compaction?.summary,
            coveredThroughChatId: preparedHistory.compaction?.coveredThroughChatId,
          }
        )
        await agentHandler.execute(request.requestText, messages)
      }
    } catch (error) {
      if (deferredOverflowError) {
        await persistAgentError(deferredOverflowError)
        deferredOverflowError = undefined
      }
      console.error('Agent execution error:', error)
    } finally {
      agentSession.setActiveRunner(null)
    }
  }

  const insertUserRequest = async (request: AgentRequestSnapshot) => {
    const imageUrls = request.images.map(image => image.url)
    return insert({
      tagId: currentTagId,
      role: 'user',
      content: request.inputValue,
      type: 'chat',
      inserted: false,
      images: imageUrls.length > 0 ? JSON.stringify(imageUrls) : undefined,
      imageAnalyses: request.images.length > 0
        ? serializeChatImageAnalyses(createPendingChatImageAnalyses(request.images, request.requestText))
        : undefined,
      attachments: request.fileAttachments.length > 0
        ? serializeChatAttachments(request.fileAttachments)
        : undefined,
      quoteData: request.quoteData ? JSON.stringify(request.quoteData) : undefined,
    })
  }

  const prepareSteering = async (
    request: AgentRequestSnapshot,
    sequence: number
  ): Promise<AgentSteeringPayload> => {
    let additionalContext = ''
    let steeringImageAttachments: PersistedChatImageAnalysis[] | undefined

    try {
      additionalContext = await buildAgentSteeringContext(request, isMobile)
    } catch (error) {
      console.error('Failed to build steering context:', error)
    }

    if (request.images.length > 0) {
      steeringImageAnalysisAbortControllerRef.current?.abort()
      const controller = new AbortController()
      steeringImageAnalysisAbortControllerRef.current = controller
      try {
        const imageResult = await buildChatImageContext(request.images, request.requestText, {
          signal: controller.signal,
        })
        additionalContext = [additionalContext, imageResult.context].filter(Boolean).join('\n\n')
        steeringImageAttachments = imageResult.analyses
      } finally {
        if (steeringImageAnalysisAbortControllerRef.current === controller) {
          steeringImageAnalysisAbortControllerRef.current = null
        }
      }
    }

    return {
      sequence,
      text: request.requestText,
      selectedSkills: request.selectedSkillIds,
      additionalContext,
      currentQuote: request.quoteData ? {
        fileName: request.quoteData.fileName,
        articlePath: request.quoteData.articlePath,
        startLine: request.quoteData.startLine,
        endLine: request.quoteData.endLine,
        from: request.quoteData.from,
        to: request.quoteData.to,
        fullContent: request.quoteData.fullContent,
        selectionToken: request.quoteData.selectionToken,
      } : undefined,
      attachments: request.fileAttachments,
      imageAttachments: steeringImageAttachments,
    }
  }

  agentSession.configure({
    execute: async (request) => {
      const modelId = useSettingStore.getState().primaryModel
      const aiConfig = applyChatReasoningOverride(
        await getAISettingsByModelId(modelId), modelId, request.reasoningOverride ?? null,
      )
      const modelSnapshot = {
        id: modelId,
        name: noteGenModelDisplayName(aiConfig?.model || modelId, aiConfig?.key === 'note-gen-free'),
        config: aiConfig,
      }
      setAgentState({
        activeModelId: modelSnapshot.id,
        activeModelName: modelSnapshot.name,
      })
      const userMessage = await insertUserRequest(request)
      if (userMessage) {
        if (typeof userMessage.conversationId === 'number') {
          agentSessionManager.rekey(
            agentSessionId,
            `conversation:${userMessage.conversationId}`
          )
        }
        await handleAgentMode(request, userMessage, modelSnapshot)
      }
    },
    prepareSteering,
    onSteeringError: error => console.error('Failed to prepare steering message:', error),
  })

  // 对话（Agent 模式）
  async function handleSubmit(overrideText?: string) {
    if (preparingAttachments) return
    const request = createRequestSnapshot(overrideText)
    if (!request.inputValue.trim() && request.images.length === 0 && request.fileAttachments.length === 0) return
    const wasStreaming = agentSession.isStreaming
    const waitingState = useChatStore.getState().agentState
    const isReplacingPendingApproval = Boolean(waitingState.pendingConfirmation || waitingState.pendingQuestion || waitingState.pendingUiInteraction)
    if (!wasStreaming) {
      manualStopRequestedRef.current = false
      contextOverflowRetryRef.current = 0
      repeatedScriptApprovalRef.current = { signature: '', count: 0 }
      setLoading(true)
    }
    request.browserPageContext = [
      ...browserPageContextOverrides,
      await buildBrowserPageContext(request.browserTabId, browserExpectedUrl ?? undefined),
    ].filter(Boolean).join('\n\n')
    onSent?.()

    try {
      await agentSession.prompt(request, {
        streamingBehavior: wasStreaming
          ? isReplacingPendingApproval ? 'steer' : 'followUp'
          : undefined,
      })
    } finally {
      if (!wasStreaming) {
        setLoading(false)
      }
    }
  }

  const handleStop = async () => {
    manualStopRequestedRef.current = true
    imageAnalysisAbortControllerRef.current?.abort()
    imageAnalysisAbortControllerRef.current = null
    steeringImageAnalysisAbortControllerRef.current?.abort()
    steeringImageAnalysisAbortControllerRef.current = null

    // 停止普通对话的流式输出
    if (abortControllerRef.current) {
      abortControllerRef.current.abort()
      abortControllerRef.current = null
    }

    agentSession.abort()

    // 重置 loading 状态
    setLoading(false)
  }

  const hasInput = Boolean(inputValue.trim() || attachedImages.length > 0 || fileAttachments.length > 0)
  const showStop = loading && !hasInput

  return (
    <span className="relative inline-flex">
      <TooltipButton
        variant={dockStyle ? "ghost" : showStop ? "destructive" : "default"}
        size={dockStyle ? "icon" : "sm"}
        icon={showStop ? <Square className="fill-current" /> : <Send />}
        disabled={!showStop && (preparingAttachments || !primaryModel || !hasInput)}
        tooltipText={showStop
          ? t('record.chat.input.stop')
          : preparingAttachments
            ? t('record.chat.input.composerMenu.loading')
            : loading
              ? t('record.chat.input.agent.deliveryMode.pending.add')
              : t('record.chat.input.send')}
        onClick={showStop ? handleStop : () => void handleSubmit()}
        buttonClassName={dockStyle ? cn(
          "size-8 rounded-full border border-border/50 bg-[hsl(var(--component-active-bg))] text-foreground shadow-none hover:bg-[hsl(var(--component-active-bg))] hover:text-foreground",
          showStop && "border-destructive bg-background text-destructive hover:bg-background hover:text-destructive"
        ) : undefined}
      />
    </span>
  )
})

ChatSend.displayName = 'ChatSend';
