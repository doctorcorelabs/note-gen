import { Tool, ToolResult } from '../types'
import {
  clearAllMemories,
  deleteMemory,
  getAllMemories,
  getMemoriesByCategory,
  permanentlyDeleteMemory,
  updateMemory,
  upsertMemory,
  type Memory,
} from '@/db/memories'
import { getCurrentMemoryWorkspaceId } from '@/lib/context/loader'
import { decideMemoryConsolidation } from '@/lib/memory/consolidation'
import { containsPotentialSecret } from '@/lib/memory/safety'

function normalizeExplicitConflictKey(content: string, provided?: string) {
  const normalized = content.toLocaleLowerCase()
  const isPreferredName = /称呼|叫我|叫用户|call me|address me|refer to me as/.test(normalized)
  if (isPreferredName) return 'user.preferred_name'
  return provided
}

/**
 * Tool: List all memories
 */
export const listMemoriesTool: Tool = {
  name: 'list_memories',
  description: `Query all saved memories (preferences and memory).

Use cases:
- Before adding a new memory, use this tool to check existing memories
- Check for conflicting memories (e.g., existing "answer in Chinese" vs new "answer in English")
- Get memory IDs for delete operations

  Returns memory ID, content, and type (preference/memory).`,
  category: 'system',
  requiresConfirmation: false,
  parameters: [
    {
      name: 'category',
      type: 'string',
      description: 'Optional: Filter memory type (preference or memory)',
      required: false,
    },
  ],
  execute: async (params): Promise<ToolResult> => {
    try {
      let memories: Memory[]
      if (params.category) {
        memories = await getMemoriesByCategory(params.category as 'preference' | 'memory')
      } else {
        memories = await getAllMemories()
      }

      const formatted = memories.map(m =>
        `ID: ${m.id} [${m.category === 'preference' ? 'Preference' : 'Memory'}] ${m.content}`
      ).join('\n')

      return {
        success: true,
        message: `Found ${memories.length} memories:\n${formatted}`,
      }
    } catch {
      return {
        success: false,
        error: `Failed to get memory list`,
      }
    }
  },
}

/**
 * Tool: Delete a specific memory
 */
export const deleteMemoryTool: Tool = {
  name: 'delete_memory',
  description: `Delete one saved memory by ID when the user explicitly asks to remove it.

Deletion is complete on its own. Save a replacement only when the user separately and explicitly asks to remember replacement information.`,
  category: 'system',
  requiresConfirmation: true,
  parameters: [
    {
      name: 'id',
      type: 'string',
      description: 'Memory ID (from list_memories result)',
      required: true,
    },
  ],
  execute: async (params): Promise<ToolResult> => {
    try {
      const memories = await getAllMemories()
      if (!memories.some(memory => memory.id === params.id)) {
        return {
          success: true,
          data: { id: params.id, alreadyAbsent: true },
          message: `Memory already absent`,
        }
      }
      await deleteMemory(params.id)
      return {
        success: true,
        data: { id: params.id, alreadyAbsent: false },
        message: `Memory deleted`,
      }
    } catch {
      return {
        success: false,
        error: `Failed to delete memory`,
      }
    }
  },
}

/**
 * Tool: Save or update memory
 */
export const saveMemoryTool: Tool = {
  name: 'save_memory',
  description: `Save or update a memory only when the user expresses clear persistent intent, such as explicitly asking NoteGen to remember something for future conversations.

Do not persist one-turn instructions merely because they mention a language, format, tone, or temporary preference. If a persistent request conflicts with an existing memory, inspect existing memories, then call save_memory once with the replacement content and the same stable conflict_key. save_memory consolidates the replacement atomically. Never delete the old memory first unless the user explicitly asks to forget it without saving a replacement.

Treat direct phrases such as "please remember...", "remember this...", and "keep in mind..." as explicit requests to save a memory.
Also save clear future-facing defaults or standing instructions, even when the user does not say "remember", for example:
- "From now on..." / "Always... from now on" / "Starting now..."
- "By default..." / "Every time..." / "Always..."
- "Never ... again" / "From now on ..." / "Do not ... anymore"

Judge the meaning, not the presence of a keyword. A question or prediction containing "future" is not a memory request. These explicit persistent actions remain available even when automatic learning from conversations is disabled.

Supports two types:
- preference: User preferences like language, format, style - always included in conversations
- memory: User's facts, experience, expertise - matched intelligently via context

Examples:
- "Please remember, I want you to always answer in Chinese from now on" -> preference
- "Always answer me in English from now on" -> preference
- "From now on, release notes should by default start with user-visible changes" -> preference
- "From now on, do not use too many subheadings in articles" -> preference
- "Remember, the NoteGen project uses pnpm" -> memory
- "Remember that I prefer concise English answers in future conversations" -> preference
- "From now on, use pnpm commands for this workspace" -> preference
- "Remember that I maintain a React library" -> memory
- "How will AI develop in the future?" -> do not save
- "Answer this message in English" -> do not save`,
  category: 'system',
  requiresConfirmation: true,
  parameters: [
    {
      name: 'content',
      type: 'string',
      description: 'Content to remember',
      required: true,
    },
    {
      name: 'category',
      type: 'string',
      description: 'Memory type: preference (user settings) or memory (facts/expertise). Auto-detected if not specified',
      required: false,
    },
    {
      name: 'scope',
      type: 'string',
      description: 'Memory scope: global or workspace. Preferences normally use global; project facts normally use workspace.',
      required: false,
    },
    {
      name: 'conflict_key',
      type: 'string',
      description: 'Optional stable topic key used to detect updates or contradictions, for example user.response_language.',
      required: false,
    },
  ],
  execute: async (params): Promise<ToolResult> => {
    try {
      const content = String(params.content || '').trim()
      const scope = params.scope === 'workspace' ? 'workspace' : 'global'
      const scopeId = scope === 'workspace' ? await getCurrentMemoryWorkspaceId() : undefined
      const providedConflictKey = typeof params.conflict_key === 'string'
        ? params.conflict_key.trim() || undefined
        : undefined
      const conflictKey = normalizeExplicitConflictKey(content, providedConflictKey)
      const sensitive = containsPotentialSecret(content)
      const category = params.category === 'preference' ? 'preference' : 'memory'
      const kind = category === 'preference' ? 'preference' : 'fact'
      const decision = sensitive
        ? { action: 'new' as const, conflictKey }
        : await decideMemoryConsolidation({
            content,
            kind,
            scopeType: scope,
            scopeId,
            conflictKey,
          })

      if (decision.action === 'duplicate' && decision.existing) {
        if (
          decision.conflictKey
          && decision.existing.conflictKey !== decision.conflictKey
        ) {
          await updateMemory(decision.existing.id, {
            conflictKey: decision.conflictKey,
          })
        }
        return {
          success: true,
          data: {
            id: decision.existing.id,
            action: 'duplicate',
            merged: true,
          },
          message: 'An equivalent memory already exists; reused the existing memory.',
        }
      }

      const status = sensitive ? 'pending' : 'active'
      const result = await upsertMemory({
        content,
        category,
        scopeType: scope,
        scopeId,
        applyMode: category === 'preference' ? 'always' : 'relevant',
        origin: 'explicit_chat',
        conflictKey: decision.conflictKey,
        sensitivity: sensitive ? 'suspected_sensitive' : 'normal',
        status,
      })
      if (
        (decision.action === 'replace' || decision.action === 'review')
        && decision.existing
        && decision.existing.id !== result.id
      ) {
        await permanentlyDeleteMemory(decision.existing.id)
      }

      return {
        success: true,
        data: {
          id: result.id,
          action: decision.action,
          replaced: result.replaced,
          indexingStatus: result.indexingStatus,
          pendingReview: status === 'pending',
        },
        message: sensitive
          ? 'Memory contains potentially sensitive content and was saved as pending review; it will not be recalled until the user approves it.'
          : result.indexingStatus === 'pending'
            ? 'Memory saved. Semantic indexing is pending; text recall remains available.'
            : 'Memory saved',
      }
    } catch (error) {
      console.error('[Memory] Failed to save memory:', error)
      const detail = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        error: `Failed to save memory: ${detail}`,
      }
    }
  },
}

/**
 * Tool: Clear all memories
 */
export const clearMemoriesTool: Tool = {
  name: 'clear_all_memories',
  description: `Clear all memories.

Use cases:
- When user explicitly requests to clear all memories
- Reset all memory data

WARNING: This operation is irreversible, use with caution`,
  category: 'system',
  requiresConfirmation: true,
  parameters: [],
  execute: async (): Promise<ToolResult> => {
    try {
      const memories = await getAllMemories()
      if (memories.length === 0) {
        return {
          success: true,
          data: { scope: 'all', alreadyAbsent: true },
          message: `All memories are already cleared`,
        }
      }
      await clearAllMemories()
      return {
        success: true,
        data: { scope: 'all', alreadyAbsent: false },
        message: `All memories cleared`,
      }
    } catch {
      return {
        success: false,
        error: `Failed to clear memories`,
      }
    }
  },
}

export const memoryTools: Tool[] = [
  saveMemoryTool,
  listMemoriesTool,
  deleteMemoryTool,
  clearMemoriesTool,
]
