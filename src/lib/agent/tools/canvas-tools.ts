import emitter from '@/lib/emitter'
import { applyCanvasOperations } from '@/lib/canvas/operations'
import type { CanvasDocument } from '@/types/canvas'
import type { AgentTool, AgentToolExecutionContext, AgentToolResult } from '../types'
import { FLOWCHART_NODE_TYPES } from '@/lib/canvas/shapes'

const CANVAS_NODE_TYPES = [
  ...FLOWCHART_NODE_TYPES,
  'text',
] as const

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asNonEmptyString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function isFiniteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateCanvasOperations(document: CanvasDocument, rawOperations: unknown[]) {
  const nodeIds = new Set(document.nodes.map(node => node.id))
  const edgeIds = new Set(document.edges.map(edge => edge.id))

  for (const [index, rawOperation] of rawOperations.entries()) {
    const operation = asRecord(rawOperation)
    const type = asNonEmptyString(operation.type)
    const item = `operations[${index}]`

    if (type === 'clear') {
      nodeIds.clear()
      edgeIds.clear()
      continue
    }

    if (type === 'add_node') {
      const id = asNonEmptyString(operation.id)
      const nodeType = asNonEmptyString(operation.nodeType)
      const label = asNonEmptyString(operation.label)
      if (!id || !nodeType || !label || !isFiniteNumber(operation.x) || !isFiniteNumber(operation.y)) {
        return `${item} Adding a node requires a non-empty id, nodeType, and label, plus finite numeric x and y.`
      }
      if (!CANVAS_NODE_TYPES.includes(nodeType as typeof CANVAS_NODE_TYPES[number])) {
        return `${item}.nodeType must be one of ${CANVAS_NODE_TYPES.join(', ')}.`
      }
      if (nodeIds.has(id)) {
        return `${item}.id="${id}" already exists. New nodes must use a unique and stable ID.`
      }
      nodeIds.add(id)
      continue
    }

    if (type === 'update_node') {
      const id = asNonEmptyString(operation.id)
      if (!id || !nodeIds.has(id)) {
        return `${item} must provide the id of a node that actually exists on the current canvas.`
      }
      const hasUpdate = typeof operation.label === 'string'
        || typeof operation.description === 'string'
        || isFiniteNumber(operation.x)
        || isFiniteNumber(operation.y)
      if (!hasUpdate) {
        return `${item} must provide at least one change among label, description, x, and y.`
      }
      continue
    }

    if (type === 'delete_node') {
      const id = asNonEmptyString(operation.id)
      if (!id || !nodeIds.has(id)) {
        return `${item} must provide the id of a node that actually exists on the current canvas.`
      }
      nodeIds.delete(id)
      continue
    }

    if (type === 'add_edge') {
      const id = asNonEmptyString(operation.id)
      const source = asNonEmptyString(operation.source)
      const target = asNonEmptyString(operation.target)
      if (!id || !source || !target) {
        return `${item} Adding an edge requires a non-empty id, source, and target.`
      }
      if (!nodeIds.has(source) || !nodeIds.has(target)) {
        return `${item} source and target must reference node IDs that exist on the current canvas or were added earlier in this batch.`
      }
      if (source === target) {
        return `${item} cannot connect a node to itself.`
      }
      if (edgeIds.has(id)) {
        return `${item}.id="${id}" already exists. New edges must use a unique and stable ID.`
      }
      edgeIds.add(id)
      continue
    }

    if (type === 'delete_edge') {
      const id = asNonEmptyString(operation.id)
      if (!id || !edgeIds.has(id)) {
        return `${item} must provide the id of an edge that actually exists on the current canvas.`
      }
      edgeIds.delete(id)
      continue
    }

    return `${item}.type is not a supported canvas operation.`
  }

  return null
}

async function getActiveCanvas(contextCanvasId?: string) {
  const { default: useCanvasStore } = await import('@/stores/canvas')
  const store = useCanvasStore.getState()
  const canvasId = contextCanvasId || store.activeCanvasId || ''
  const document = canvasId ? store.documents[canvasId] : undefined
  const project = store.projects.find(item => item.id === canvasId)
  return { store, canvasId, document, project }
}

function summarizeDocument(document: CanvasDocument) {
  return {
    settings: document.settings,
    viewport: document.viewport,
    nodes: document.nodes.map(node => ({
      id: node.id,
      type: node.type,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      label: node.data.label || '',
      description: node.data.description || '',
    })),
    edges: document.edges.map(edge => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      label: edge.label || '',
    })),
  }
}

async function executeCanvasOperations(
  operations: unknown[],
  context: AgentToolExecutionContext
): Promise<AgentToolResult> {
  const { store, canvasId, document, project } = await getActiveCanvas(context.context.activeCanvasId)
  if (!canvasId || !document) {
    return { ok: false, message: 'There is no open canvas.', error: 'NO_ACTIVE_CANVAS' }
  }
  if (operations.length === 0) {
    return { ok: false, message: 'No executable canvas operations were provided.', error: 'EMPTY_OPERATIONS' }
  }
  const validationError = validateCanvasOperations(document, operations)
  if (validationError) {
    return {
      ok: false,
      message: `Invalid canvas operation parameters; the whole batch was not executed: ${validationError}`,
      error: 'INVALID_CANVAS_OPERATIONS',
    }
  }

  const before = JSON.stringify(summarizeDocument(document))
  const result = applyCanvasOperations(document, operations)
  if (result.applied !== operations.length) {
    return {
      ok: false,
      message: 'The canvas operations could not be applied completely, so the whole batch was not written.',
      error: 'INCOMPLETE_CANVAS_OPERATIONS',
    }
  }
  store.updateDocument(canvasId, result.document)
  emitter.emit('canvas-document-replace', { canvasId, document: result.document })
  requestAnimationFrame(() => {
    emitter.emit('canvas-auto-layout', { recordHistory: false })
  })

  return {
    ok: true,
    message: `Applied ${result.applied} changes to the canvas "${project?.title || canvasId}".`,
    data: summarizeDocument(result.document),
    changes: [{
      id: crypto.randomUUID(),
      type: 'canvas',
      target: canvasId,
      before,
      after: JSON.stringify(summarizeDocument(result.document)),
      reversible: true,
      summary: `Modify the canvas "${project?.title || canvasId}"`,
    }],
  }
}

const getCanvasStateTool: AgentTool = {
  name: 'canvas_get_state',
  title: 'Read Current Canvas',
  description: 'Read the native visual canvas currently open in NoteGen, including nodes, edges, positions, and settings. Use only when the user wants to inspect or operate on the current canvas; general questions about charts, nodes, or edges do not need the canvas to be read.',
  category: 'canvas',
  risk: 'read',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  execute: async (_input, context): Promise<AgentToolResult> => {
    const { canvasId, document, project } = await getActiveCanvas(context.context.activeCanvasId)
    if (!canvasId || !document) {
      return { ok: false, message: 'There is no open canvas.', error: 'NO_ACTIVE_CANVAS' }
    }
    return {
      ok: true,
      message: `Read the canvas "${project?.title || canvasId}" with ${document.nodes.length} nodes and ${document.edges.length} edges in total.`,
      data: { canvasId, title: project?.title || '', ...summarizeDocument(document) },
    }
  },
}

const createCanvasDiagramTool: AgentTool = {
  name: 'canvas_create_diagram',
  title: 'Create Complete Canvas Diagram',
  description: 'Create a complete diagram of multiple named nodes and edges in the current native canvas at once. Prefer this when creating a new flowchart, mind map, or relationship diagram; do not split it into operations that lack names or endpoints. Each node needs a unique ID, a type, a visible name, and coordinates, and each edge must reference those node IDs precisely with source and target.',
  category: 'canvas',
  risk: 'editor-write',
  inputSchema: {
    type: 'object',
    properties: {
      replaceExisting: {
        type: 'boolean',
        description: 'When true, clear the current canvas first; when false, keep the existing content and append the diagram.',
      },
      nodes: {
        type: 'array',
        description: 'All nodes of the diagram. IDs must be unique within this call and are referenced verbatim by edges.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A unique and stable node ID.' },
            nodeType: {
              type: 'string',
              enum: [...CANVAS_NODE_TYPES],
              description: 'Node shape. Choose a standard flowchart shape by meaning, for example process for a step, decision for a check, terminator for start/end, input-output for input/output, document/multi-document for documents, predefined-process for a subprocess, manual-input for manual input, preparation for preparation, delay for a delay, display for display, connector/off-page-connector for connectors, internal-storage/database/stored-data for data storage, and text for plain text.',
            },
            label: { type: 'string', description: 'A non-empty name shown on the node.' },
            description: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['id', 'nodeType', 'label', 'x', 'y'],
          additionalProperties: false,
        },
      },
      edges: {
        type: 'array',
        description: 'All edges of the diagram. source and target must reference the IDs in nodes verbatim.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'A unique and stable edge ID.' },
            source: { type: 'string', description: 'The source node ID.' },
            target: { type: 'string', description: 'The target node ID.' },
            label: { type: 'string', description: 'A visible edge name such as a branch condition.' },
          },
          required: ['id', 'source', 'target'],
          additionalProperties: false,
        },
      },
    },
    required: ['replaceExisting', 'nodes', 'edges'],
    additionalProperties: false,
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const nodes = Array.isArray(input.nodes) ? input.nodes : []
    const edges = Array.isArray(input.edges) ? input.edges : []
    const operations: unknown[] = [
      ...(input.replaceExisting === true ? [{ type: 'clear' }] : []),
      ...nodes.map(node => ({ type: 'add_node', ...asRecord(node) })),
      ...edges.map(edge => ({ type: 'add_edge', ...asRecord(edge) })),
    ]
    return executeCanvasOperations(operations, context)
  },
}

const applyCanvasOperationsTool: AgentTool = {
  name: 'canvas_apply_operations',
  title: 'Edit Current Canvas',
  description: 'Edit the native visual canvas currently open in NoteGen incrementally, for example by updating, moving, or deleting existing nodes and edges. To create a complete diagram with multiple new nodes and edges, use canvas_create_diagram instead. All operations are validated as a batch first, and nothing is written when any parameter is missing.',
  category: 'canvas',
  risk: 'editor-write',
  inputSchema: {
    type: 'object',
    properties: {
      operations: {
        type: 'array',
        description: 'Atomic canvas edits executed in order. Add nodes first, then add edges with the same stable node IDs; if any item is invalid, the whole batch is not executed.',
        minItems: 1,
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: ['add_node', 'update_node', 'delete_node', 'add_edge', 'delete_edge', 'clear'],
              description: 'The operation type. The fields each type needs are determined by the tool description and runtime validation.',
            },
            id: { type: 'string', description: 'The stable ID of a node or edge. Required for all types except clear.' },
            nodeType: {
              type: 'string',
              enum: [...CANVAS_NODE_TYPES],
              description: 'The node shape for add_node.',
            },
            label: { type: 'string' },
            description: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            source: { type: 'string', description: 'The source node ID for add_edge.' },
            target: { type: 'string', description: 'The target node ID for add_edge.' },
          },
          required: ['type'],
          additionalProperties: false,
        },
      },
    },
    required: ['operations'],
    additionalProperties: false,
  },
  execute: async (input, context): Promise<AgentToolResult> => {
    const operations = Array.isArray(input.operations) ? input.operations : []
    return executeCanvasOperations(operations, context)
  },
}

export const canvasTools: AgentTool[] = [
  getCanvasStateTool,
  createCanvasDiagramTool,
  applyCanvasOperationsTool,
]
