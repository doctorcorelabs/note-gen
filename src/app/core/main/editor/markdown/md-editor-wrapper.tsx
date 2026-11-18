'use client'
// Modified for the web fork on 2026-11-16; see FORK.md.

import useArticleStore, { hasUnsavedArticleChanges } from '@/stores/article'
import { useEffect, useState, useCallback, useRef, useId, RefObject } from 'react'
import { TipTapEditor } from './tiptap-editor'
import { Outline } from './outline'
import { Loader2, Download } from 'lucide-react'
import { useTranslations } from 'next-intl'
import emitter, { type Events } from '@/lib/emitter'
import {
  DEFAULT_OUTLINE_WIDTH,
  getFileOutlineOpenStoreKey,
  normalizeOutlineWidth,
  OUTLINE_WIDTH_STORE_KEY,
} from '@/lib/outline-preferences'
import { platform } from '@/lib/platform'
import { Button } from '@/components/ui/button'
import { RevisionConflictDialog } from './revision-conflict-dialog'
import { ArticleSaveStatus } from './article-save-status'
import { isAlreadyExistsLike, type RevisionConflictChoice } from './revision-conflict'
import { useShallow } from 'zustand/react/shallow'
import useSettingStore, { useSettingsHydrationStore } from '@/stores/setting'
import { useSidebarStore } from '@/stores/sidebar'
import {
  editorPathsReferToSameFile,
  getCurrentEditorWorkspaceRoot,
  prepareActiveEditorDeactivation,
  prepareActiveEditorDeactivationDurably,
  workspaceRootsReferToSameLocation,
} from '@/lib/editor-deactivation'
import { writeSelfHostedWorkspaceText } from '@/lib/self-hosted-sync/files'
import {
  installUnsavedChangesUnloadGuard,
  registerUnsavedChangesFlush,
  registerUnsavedChangesProbe,
} from '@/lib/web/unsaved-changes-guard'

interface MdEditorProps {
  tabContentsRef: RefObject<Record<string, string>>
  filePath: string
  isActive: boolean
  disabled?: boolean
}

export function MdEditor({ tabContentsRef, filePath, isActive, disabled = false }: MdEditorProps) {
  const {
    saveCurrentArticle,
    isPulling,
    activeFilePath,
    currentArticle,
    justPulledFile,
    articleLoading,
    setTabDisposition,
    revisionConflicts,
    setLoadedRevision,
    resolveRevisionConflict,
    dismissRevisionConflict,
    reopenRevisionConflict,
    loadFileTree,
  } = useArticleStore(useShallow((state) => ({
    saveCurrentArticle: state.saveCurrentArticle,
    isPulling: state.isPulling,
    activeFilePath: state.activeFilePath,
    currentArticle: state.currentArticle,
    justPulledFile: state.justPulledFile,
    articleLoading: state.loading,
    setTabDisposition: state.setTabDisposition,
    revisionConflicts: state.revisionConflicts,
    setLoadedRevision: state.setLoadedRevision,
    resolveRevisionConflict: state.resolveRevisionConflict,
    dismissRevisionConflict: state.dismissRevisionConflict,
    reopenRevisionConflict: state.reopenRevisionConflict,
    loadFileTree: state.loadFileTree,
  })))
  const {
    enableOutline,
    outlinePosition,
    outlinePlacement,
    workspacePath,
  } = useSettingStore(useShallow((state) => ({
    enableOutline: state.enableOutline,
    outlinePosition: state.outlinePosition,
    outlinePlacement: state.outlinePlacement,
    workspacePath: state.workspacePath,
  })))
  const settingsReady = useSettingsHydrationStore(state => state.status === 'ready')

  const t = useTranslations('article.file.sync')
  const tEditor = useTranslations('editor')
  const tExternalChange = useTranslations('editor.externalChange')
  const tConflict = useTranslations('editor.revisionConflict')
  const [initialContent, setInitialContent] = useState<string | null>(null)
  const isCreatingFileRef = useRef(false)
  // Revision-guard conflict state for this file, owned by the store.
  const conflictEntry = revisionConflicts[filePath]
  const [externalChangeNotice, setExternalChangeNotice] = useState(false)
  const [conflictBusyChoice, setConflictBusyChoice] = useState<RevisionConflictChoice | null>(null)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const [copyNameTaken, setCopyNameTaken] = useState(false)
  // Last content known to be saved on the server. Compared against the
  // tab cache to decide whether an external change may reload silently
  // (clean editor) or must show the banner (unsaved edits).
  const lastSavedContentRef = useRef<string | null>(null)
  // Saves from this tab also arrive as watcher events without an actor,
  // so they are suppressed briefly after the article-saved event.
  const lastOwnSaveAtRef = useRef(0)
  // Track loaded state per file path - Bug fix: make this cleanup possible
  const loadedPathsRef = useRef<Set<string>>(new Set())
  // Bug fix: Track if editor content has been initialized to prevent saving empty content
  const contentInitializedRef = useRef(false)
  // Bug fix: Track expected content to detect if editor is behind
  const expectedContentRef = useRef<string | null>(null)
  // Outline panel state
  const [outlineOpen, setOutlineOpen] = useState(enableOutline)
  const [outlineWidth, setOutlineWidth] = useState(DEFAULT_OUTLINE_WIDTH)
  // State for editor instance (to trigger re-render when ready)
  const [editorInstance, setEditorInstance] = useState<any>(null)
  // Track if editor has called onEditorReady (meaning it's fully initialized)
  const [editorReady, setEditorReady] = useState(false)
  // AI streaming state
  const [aiStreaming, setAiStreaming] = useState(false)
  const terminateRef = useRef<(() => void) | undefined>(undefined)
  const guardScopeId = useId()
  // Dirty flag for the editor-side 500 ms debounce window (G28):
  // TipTap holds keystrokes locally before onChange reaches the
  // article store, so the store probe alone cannot see them. Set by
  // onContentDirty, cleared when the change reaches the store queue.
  const editorDirtyRef = useRef(false)

  // Register this tab with the tab-close guard (G28): the probes
  // cover the editor debounce window and the article store queue
  // (including retained failed saves), and the flush callbacks push
  // a pending editor change into the article store queue before the
  // store flush runs (registration order: editor first, then store,
  // within this effect, so the active tab always drains in order).
  // The unload guard itself is installed once per page and never
  // uninstalled: it protects the whole page, not one tab.
  useEffect(() => {
    installUnsavedChangesUnloadGuard()
    const unregisterProbe = registerUnsavedChangesProbe(
      `editor-dirty:${guardScopeId}`,
      () => editorDirtyRef.current,
    )
    const unregisterArticleProbe = registerUnsavedChangesProbe(
      `article-pending:${guardScopeId}`,
      () => hasUnsavedArticleChanges(),
    )
    const unregisterFlush = registerUnsavedChangesFlush(
      `editor-flush:${guardScopeId}`,
      () => {
        if (isActive) prepareActiveEditorDeactivation()
      },
    )
    const unregisterArticleFlush = registerUnsavedChangesFlush(
      `article-flush:${guardScopeId}`,
      () => useArticleStore.getState().flushAllPendingArticleSaves(),
    )
    return () => {
      unregisterProbe()
      unregisterArticleProbe()
      unregisterFlush()
      unregisterArticleFlush()
    }
  }, [guardScopeId, filePath, isActive])

  // Bug fix: Listen for file close events to clean up loaded state
  useEffect(() => {
    const handleFileClose = (event: { path: string }) => {
      if (event.path === filePath) {
        loadedPathsRef.current.delete(filePath)
      }
    }
    emitter.on('editor-file-close', handleFileClose as any)
    return () => {
      emitter.off('editor-file-close', handleFileClose as any)
      // Also clean up on component unmount
      loadedPathsRef.current.delete(filePath)
    }
  }, [filePath])

  // Reset per-file notice state when the tab switches files.
  useEffect(() => {
    setExternalChangeNotice(false)
    setConflictError(null)
    setCopyNameTaken(false)
    lastSavedContentRef.current = null
    lastOwnSaveAtRef.current = 0
  }, [filePath])

  // Apply server content to every cache the editor reads from: the tab
  // cache, the shared active document, the TipTap instance (via the
  // remote-content event), and the revision guard. The expected-content
  // ref stops the echo onUpdate from scheduling a save of content that
  // is already on the server.
  const applyServerContent = useCallback((content: string, revision: string | null) => {
    setLoadedRevision(filePath, revision)
    expectedContentRef.current = content
    contentInitializedRef.current = true
    lastSavedContentRef.current = content
    if (tabContentsRef.current) {
      tabContentsRef.current[filePath] = content
    }
    if (useArticleStore.getState().activeFilePath === filePath) {
      useArticleStore.getState().setCurrentArticle(content)
      emitter.emit('editor-content-from-remote', { content })
    }
    setInitialContent(content)
  }, [filePath, setLoadedRevision, tabContentsRef])

  const reloadFromServer = useCallback(async () => {
    try {
      const { getFilePathOptions } = await import('@/lib/workspace')
      const pathOptions = await getFilePathOptions(filePath)
      const detailed = !pathOptions.baseDir
        ? await platform.fs.readTextFileDetailed(pathOptions.path)
        : await platform.fs.readTextFileDetailed(pathOptions.path, { baseDir: pathOptions.baseDir })
      applyServerContent(detailed.content, detailed.revision)
      setExternalChangeNotice(false)
    } catch {
      // Keep the editor content and the notice. The next save is still
      // guarded, so a failed reload can never lose work silently.
    }
  }, [applyServerContent, filePath])

  // Track saves so the external-change check can tell a clean editor
  // from one with unsaved edits, and so own saves do not raise the
  // banner when their watcher event arrives.
  useEffect(() => {
    const handleSaved = (event: { path: string; content: string }) => {
      if (event.path !== filePath) return
      lastSavedContentRef.current = event.content
      lastOwnSaveAtRef.current = Date.now()
    }
    emitter.on('article-saved', handleSaved as any)
    return () => {
      emitter.off('article-saved', handleSaved as any)
    }
  }, [filePath])

  // External changes (V1-09 section 3.9 step 5): a clean editor reloads
  // silently because no work is lost; an editor with unsaved edits gets
  // a non-blocking banner with an explicit reload action. The watcher
  // event carries no actor, so own saves are suppressed by recency.
  useEffect(() => {
    const handleWorkspaceFileChanged = (event: Events['workspace-file-changed']) => {
      if (event.kind !== 'changed') return
      if (!editorPathsReferToSameFile(event.path, filePath, event.workspaceRoot)) return
      if (!contentInitializedRef.current) return
      if (Date.now() - lastOwnSaveAtRef.current < 1500) return
      const cached = tabContentsRef.current?.[filePath]
      const lastSaved = lastSavedContentRef.current
      if (cached === undefined || lastSaved === null || cached === lastSaved) {
        void reloadFromServer()
        return
      }
      setExternalChangeNotice(true)
    }
    emitter.on('workspace-file-changed', handleWorkspaceFileChanged)
    return () => {
      emitter.off('workspace-file-changed', handleWorkspaceFileChanged)
    }
  }, [filePath, tabContentsRef, reloadFromServer])

  // A fresh server revision means a fresh conflict: clear the previous
  // resolution error and copy-name notice.
  const conflictServerRevision = conflictEntry?.serverRevision
  useEffect(() => {
    setConflictError(null)
    setCopyNameTaken(false)
  }, [conflictServerRevision, filePath])

  const handleChooseConflict = useCallback(async (choice: RevisionConflictChoice, copyPath?: string) => {
    if (conflictBusyChoice) return
    setConflictBusyChoice(choice)
    setConflictError(null)
    setCopyNameTaken(false)
    try {
      const result = await resolveRevisionConflict(filePath, choice, copyPath)
      if (!result) return
      if (result.status === 'copy-exists') {
        setCopyNameTaken(true)
        return
      }
      if (result.status === 'reloaded' || result.status === 'copied') {
        applyServerContent(result.content, result.revision)
        if (result.status === 'copied') {
          void loadFileTree()
        }
      } else if (result.status === 'overwritten') {
        lastSavedContentRef.current = conflictEntry?.localContent
          ?? tabContentsRef.current?.[filePath]
          ?? null
      }
    } catch (error) {
      setConflictError(error instanceof Error ? error.message : String(error))
    } finally {
      setConflictBusyChoice(null)
    }
  }, [conflictBusyChoice, resolveRevisionConflict, filePath, applyServerContent, loadFileTree, conflictEntry, tabContentsRef])

  // Keep the wrapper-owned tab cache aligned with snapshots applied by the
  // sync runtime. TipTap handles the same path-scoped event itself; this
  // listener only updates the surrounding React/store caches and must not
  // schedule another save.
  useEffect(() => {
    let disposed = false
    let syncEventSequence = 0
    const currentWorkspaceRootPromise = getCurrentEditorWorkspaceRoot()
      .catch(() => null)
    const handleSyncContentUpdated = async (event: Events['sync-content-updated']) => {
      if (!event || typeof event.content !== 'string') return

      const eventSequence = ++syncEventSequence
      const cachedContentBeforeRootCheck = tabContentsRef.current?.[filePath]
      if (event.workspaceRoot) {
        const currentWorkspaceRoot = await currentWorkspaceRootPromise
        if (
          disposed
          || eventSequence !== syncEventSequence
          || !currentWorkspaceRoot
          || !workspaceRootsReferToSameLocation(
            currentWorkspaceRoot,
            event.workspaceRoot,
          )
          || (
            tabContentsRef.current?.[filePath] !== cachedContentBeforeRootCheck
            && tabContentsRef.current?.[filePath] !== event.content
          )
        ) {
          return
        }
      }
      if (!editorPathsReferToSameFile(event.path, filePath, event.workspaceRoot)) {
        return
      }

      expectedContentRef.current = event.content
      contentInitializedRef.current = true
      const targetIsActive = editorPathsReferToSameFile(
        useArticleStore.getState().activeFilePath,
        filePath,
        event.workspaceRoot,
      )
      if (tabContentsRef.current) {
        tabContentsRef.current[filePath] = event.content
      }
      if (targetIsActive) {
        useArticleStore.getState().setCurrentArticle(event.content)
      }
      setInitialContent(event.content)
    }

    emitter.on('sync-content-updated', handleSyncContentUpdated)
    return () => {
      disposed = true
      emitter.off('sync-content-updated', handleSyncContentUpdated)
    }
  }, [filePath, tabContentsRef, workspacePath])

  // Listen for AI streaming state
  useEffect(() => {
    const handleAiStreaming = (event: { isStreaming: boolean; targetFilePath?: string; terminate?: () => void }) => {
      // Check if this event is for the current file
      if (event.targetFilePath && event.targetFilePath !== filePath) {
        // Event is for a different file, ignore
        return
      }
      if (!event.targetFilePath && !isActive) return
      setAiStreaming(event.isStreaming)
      if (event.terminate) {
        terminateRef.current = event.terminate
      }
    }
    emitter.on('editor-ai-streaming', handleAiStreaming as any)
    return () => {
      emitter.off('editor-ai-streaming', handleAiStreaming as any)
    }
  }, [filePath, isActive])

  // Check store for AI generating state on mount and when filePath changes
  useEffect(() => {
    // Check if this file is currently being generated by AI
    const { aiGeneratingFilePath, aiTerminateFn } = useArticleStore.getState()
    if (aiGeneratingFilePath === filePath) {
      setAiStreaming(true)
      if (aiTerminateFn) {
        terminateRef.current = aiTerminateFn
      }
    }
  }, [filePath])

  const loadOutlineWidth = useCallback(async () => {
    const store = await platform.store.load('store.json')
    setOutlineWidth(normalizeOutlineWidth(await store.get(OUTLINE_WIDTH_STORE_KEY)))
  }, [])

  useEffect(() => {
    loadOutlineWidth()
  }, [loadOutlineWidth])

  useEffect(() => {
    if (!isActive) return

    loadOutlineWidth()
  }, [isActive, loadOutlineWidth])

  useEffect(() => {
    let disposed = false
    const loadOutlineOpen = async () => {
      const store = await platform.store.load('store.json')
      const storedValue = await store.get<boolean>(getFileOutlineOpenStoreKey(workspacePath, filePath))
      if (!disposed) setOutlineOpen(typeof storedValue === 'boolean' ? storedValue : enableOutline)
    }
    void loadOutlineOpen()
    return () => { disposed = true }
  }, [enableOutline, filePath, workspacePath])

  const sidebarOutlineOpen = useSidebarStore(state => state.leftSidebarVisible && state.leftSidebarTab === 'outline')
  const handleToggleOutline = useCallback(() => {
    if (!settingsReady) return

    if (outlinePlacement === 'sidebar') {
      const sidebar = useSidebarStore.getState()
      void sidebar.setLeftSidebarTab(sidebarOutlineOpen ? 'files' : 'outline')
      if (!sidebar.leftSidebarVisible) void sidebar.toggleLeftSidebar()
      return
    }
    setOutlineOpen(current => {
      const next = !current
      void platform.store.load('store.json').then(async store => {
        await store.set(getFileOutlineOpenStoreKey(workspacePath, filePath), next)
        await store.save()
      })
      return next
    })
  }, [filePath, workspacePath, outlinePlacement, settingsReady, sidebarOutlineOpen])

  const handleOutlineWidthChange = useCallback((width: number) => {
    setOutlineWidth(normalizeOutlineWidth(width))
  }, [])

  const handleOutlineWidthCommit = useCallback(async (width: number) => {
    const normalizedWidth = normalizeOutlineWidth(width)
    setOutlineWidth(normalizedWidth)
    const store = await platform.store.load('store.json')
    await store.set(OUTLINE_WIDTH_STORE_KEY, normalizedWidth)
  }, [])

  // Resolve initial content from the shared tab cache, the store's active file,
  // or the file itself. Split groups can restore several files at once, while
  // the article store intentionally has only one globally active document.
  useEffect(() => {
    if (!filePath || loadedPathsRef.current.has(filePath)) return
    let disposed = false

    // Bug fix: Check cache first
    if (tabContentsRef.current && tabContentsRef.current[filePath] !== undefined) {
      setInitialContent(tabContentsRef.current[filePath])
      loadedPathsRef.current.add(filePath)
      contentInitializedRef.current = true
      return
    }

    // Path and content must come from the same render snapshot. A tab switch
    // can change the live store before this effect runs.
    if (activeFilePath === filePath) {
      if (articleLoading) return
      setInitialContent(currentArticle)
      lastSavedContentRef.current = currentArticle
      if (tabContentsRef.current) {
        tabContentsRef.current[filePath] = currentArticle
      }
      loadedPathsRef.current.add(filePath)
      contentInitializedRef.current = true
      return
    }

    void (async () => {
      try {
        const [{ getFilePathOptions }] = await Promise.all([
          import('@/lib/workspace'),
        ])
        const pathOptions = await getFilePathOptions(filePath)
        // Detailed read: the revision guards the next save (V1-09 3.9).
        const detailed = !pathOptions.baseDir
          ? await platform.fs.readTextFileDetailed(pathOptions.path)
          : await platform.fs.readTextFileDetailed(pathOptions.path, { baseDir: pathOptions.baseDir })
        const content = detailed.content
        if (disposed || loadedPathsRef.current.has(filePath)) return
        setLoadedRevision(filePath, detailed.revision)
        lastSavedContentRef.current = content
        if (tabContentsRef.current) tabContentsRef.current[filePath] = content
        loadedPathsRef.current.add(filePath)
        contentInitializedRef.current = true
        setInitialContent(content)
      } catch {
        // The active-file store may still be resolving a remote pull. Its
        // currentArticle subscription below remains the fallback in that case.
      }
    })()

    return () => {
      disposed = true
    }
  }, [activeFilePath, articleLoading, currentArticle, filePath, tabContentsRef, setLoadedRevision])

  // Apply active-document updates only after that document has finished loading.
  useEffect(() => {
    if (activeFilePath !== filePath || articleLoading) return

    if (currentArticle !== initialContent) {
      // Bug fix: Set expected content BEFORE updating initialContent
      // This ensures handleContentChange knows what to expect
      expectedContentRef.current = currentArticle
      lastSavedContentRef.current = currentArticle
      setInitialContent(currentArticle)
      // Update cache
      if (tabContentsRef.current) {
        tabContentsRef.current[filePath] = currentArticle
      }
      // Mark as initialized so that subsequent saves are allowed
      contentInitializedRef.current = true

      // Fix cursor jump: Only trigger remote content update if this is a remote pull
      // This prevents unnecessary setContent during local saves
      if (justPulledFile) {
        emitter.emit('editor-content-from-remote', { content: currentArticle })
      }
    } else if (currentArticle === '' && initialContent === '') {
      // Genuinely empty file - hide loading and mark as initialized
      // Bug fix: Set expected content for empty file
      expectedContentRef.current = ''
      // Mark as initialized for empty files so user can start typing
      contentInitializedRef.current = true
    }
  }, [activeFilePath, articleLoading, currentArticle, filePath, tabContentsRef, initialContent, justPulledFile])

  // Handle content changes for this editor's document. Split groups may edit a
  // document before the global active-file transition has finished, so always
  // use the explicit path override instead of relying on the singleton state.
  const handleContentChange = useCallback((content: string) => {
    // The editor-side change has reached the store queue (or was an
    // echo); the store probe owns it from here.
    editorDirtyRef.current = false
    // Ignore only the initial empty update; clearing an initialized document must still save.
    if (content.length === 0 && !contentInitializedRef.current) {
      return
    }
    // Bug fix: If expected content is set and incoming content doesn't match, skip save
    // This prevents saving stale content during editor initialization race
    // But clear expectedContentRef so subsequent edits can be saved
    if (expectedContentRef.current !== null && content !== expectedContentRef.current) {
      expectedContentRef.current = null
    }
    // Bug fix: Skip if content matches what we just loaded (first onUpdate after init)
    // The editor's onUpdate fires after setContent, so we skip that initial call
    if (expectedContentRef.current !== null && content === expectedContentRef.current) {
      // Clear expectedContentRef after first matching update
      expectedContentRef.current = null
      return
    }
    // Mark as initialized when we receive valid content
    if (!contentInitializedRef.current) {
      contentInitializedRef.current = true
    }
    // Update cache
    if (filePath && tabContentsRef.current) {
      tabContentsRef.current[filePath] = content
    }

    if (filePath) {
      const previewTab = useArticleStore.getState().openTabs.find(tab => (
        tab.path === filePath && tab.preview
      ))
      if (previewTab) void setTabDisposition(previewTab.id, 'regular')
      saveCurrentArticle(content, filePath)
    } else if (!filePath && !isCreatingFileRef.current) {
      // Auto-create untitled file
      isCreatingFileRef.current = true
      void createUntitledFile(content).finally(() => {
        isCreatingFileRef.current = false
      })
    }
  }, [saveCurrentArticle, setTabDisposition, filePath, tabContentsRef])

  // Handle editor ready - store editor instance
  const handleEditorReady = useCallback((editor: any) => {
    setEditorInstance(editor)
    setEditorReady(true)
  }, [])

  // Reset editor instance and ready state when file changes
  useEffect(() => {
    setEditorInstance(null)
    setEditorReady(false)
  }, [filePath])

  // Auto-create untitled.md file
  async function createUntitledFile(content: string) {
    try {
      const articleState = useArticleStore.getState()
      if (!await prepareActiveEditorDeactivationDurably(articleState.activeFilePath)) {
        return
      }
            const workspace = await import('@/lib/workspace').then(m => m.getWorkspacePath())
      const { getFilePathOptions } = await import('@/lib/workspace')

      let fileName = 'untitled.md'
      let counter = 1
      let path = fileName

      // Create-new attempts instead of exists-then-write: the existence
      // check raced between tabs, so the server guard (If-None-Match: *)
      // decides the name. An already_exists answer advances to the next
      // candidate; any other error propagates to the caller below.
      for (;;) {
        if (counter > 1000) {
          throw new Error('Could not find a free untitled file name')
        }
        const pathOptions = await getFilePathOptions(fileName)
        if (await writeSelfHostedWorkspaceText(path, content)) {
          // Rust journal already persisted the file.
          break
        }
        try {
          if (workspace.isCustom) {
            await platform.fs.writeTextFile(pathOptions.path, content, { createNew: true })
          } else {
            await platform.fs.writeTextFile(pathOptions.path, content, { baseDir: pathOptions.baseDir, createNew: true })
          }
          break
        } catch (error) {
          if (!isAlreadyExistsLike(error)) throw error
          fileName = `untitled-${counter}.md`
          path = fileName
          counter++
        }
      }

      await articleState.setActiveFilePath(
        path,
        true,
        { deactivationAlreadyPrepared: true },
      )
      articleState.setCurrentArticle(content)
      await articleState.loadFileTree()
    } catch {
    }
  }

  const isThisEditorPulling = isPulling && activeFilePath === filePath

  // Loading state - wait for content to be loaded
  // 如果正在从远程拉取，优先显示拉取遮罩
  if (isThisEditorPulling) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <div className="relative">
            <Loader2 className="size-8 animate-spin" />
            <Download className="size-4 absolute inset-0 m-auto" />
          </div>
          <div className="text-center">
            <p className="text-sm font-medium">{t('syncingRemote')}</p>
            <p className="text-xs mt-1">{t('pullingRemote')}</p>
          </div>
        </div>
      </div>
    )
  }

  // Never mount the editor against a temporary empty string.
  const showContent = initialContent !== null
  if (!showContent) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="size-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const showOutline = settingsReady && outlinePlacement === 'editor' && outlineOpen && !isThisEditorPulling && editorReady && editorInstance
  const renderOutline = () => editorInstance ? (
    <Outline
      editor={editorInstance}
      isOpen={outlineOpen}
      position={outlinePosition}
      documentKey={filePath}
      width={outlineWidth}
      onWidthChange={handleOutlineWidthChange}
      onWidthCommit={handleOutlineWidthCommit}
    />
  ) : null

  return (
    <div id={isActive ? "onboarding-target-editor-content" : undefined} className="relative flex h-full w-full flex-1 min-w-0 flex-col">
      {externalChangeNotice ? (
        <div className="flex items-center gap-3 border-b bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/40">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{tExternalChange('title')}</span>{' '}
            {tExternalChange('description')}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => void reloadFromServer()}>
            {tExternalChange('reloadButton')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setExternalChangeNotice(false)}>
            {tExternalChange('dismissButton')}
          </Button>
        </div>
      ) : null}

      {conflictEntry?.dismissed ? (
        <div className="flex items-center gap-3 border-b bg-amber-50 px-3 py-2 text-xs dark:bg-amber-950/40">
          <p className="min-w-0 flex-1">
            <span className="font-medium">{tConflict('heldTitle')}</span>{' '}
            {tConflict('heldDescription')}
          </p>
          <Button type="button" size="sm" variant="outline" onClick={() => reopenRevisionConflict(filePath)}>
            {tConflict('resolveButton')}
          </Button>
        </div>
      ) : null}

      <div className="relative flex min-h-0 min-w-0 flex-1">
      {/* Pull loading overlay */}
      {isThisEditorPulling && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 text-muted-foreground">
            <div className="relative">
              <Loader2 className="size-8 animate-spin" />
              <Download className="size-4 absolute inset-0 m-auto" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">{t('syncingRemote')}</p>
              <p className="text-xs mt-1">{t('pullingRemote')}</p>
            </div>
          </div>
        </div>
      )}

      {showOutline && outlinePosition === 'left' ? renderOutline() : null}

      <div className="relative h-full min-w-0 flex-1">
      {/* Editor - initialContent only set once on mount */}
      <TipTapEditor
        initialContent={initialContent ?? ''}
        onChange={handleContentChange}
        placeholder={tEditor('placeholder')}
        activeFilePath={filePath}
        onEditorReady={handleEditorReady}
        onContentDirty={() => { editorDirtyRef.current = true }}
        outlineOpen={settingsReady && (outlinePlacement === 'sidebar' ? sidebarOutlineOpen : outlineOpen)}
        outlinePosition={outlinePosition}
        outlineWidth={outlineWidth}
        outlineInLayout
        onToggleOutline={handleToggleOutline}
        applyLayoutPreferences
        isActive={isActive}
        editable={!disabled && !isThisEditorPulling && !aiStreaming}
        autoScroll={aiStreaming}
        showOverlay={aiStreaming}
        onTerminate={() => {
          if (terminateRef.current) {
            terminateRef.current()
          } else {
            // If terminateRef is not set, emit abort event
            emitter.emit('abort-ai-streaming')
          }}
        }
      />
      </div>

      {showOutline && outlinePosition === 'right' ? renderOutline() : null}
      </div>

      <ArticleSaveStatus filePath={filePath} />

      {conflictEntry ? (
        <RevisionConflictDialog
          open={!conflictEntry.dismissed}
          conflict={conflictEntry}
          busyChoice={conflictBusyChoice}
          error={conflictError}
          copyNameTaken={copyNameTaken}
          onChoose={handleChooseConflict}
          onDismiss={() => dismissRevisionConflict(filePath)}
        />
      ) : null}
    </div>
  )
}

export default MdEditor
