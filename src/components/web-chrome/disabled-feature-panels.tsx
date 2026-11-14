// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { DisabledFeature } from './disabled-feature'

/**
 * Drop-in disabled panels for the two Phase 2 features demonstrated by
 * the web chrome framework: AI chat and canvas.
 *
 * Wiring points (owned by the integrator; this file only provides the
 * panels, it does not mount them into the sidebar or tab system):
 *
 * 1. AI chat: the chat surface is mounted by the right sidebar in
 *    src/components/plugins/plugin-right-sidebar.tsx, which imports Chat
 *    from src/app/core/main/chat. Gate that mount on useFeatureFlag
 *    ('ai-chat') and render AiChatDisabledPanel while the flag is off.
 *    Do not mount ChatContent or ChatInput while disabled: their send
 *    path has no web transport in Phase 1.
 *
 * 2. Canvas: the canvases tab is declared in
 *    src/app/core/main/left-sidebar.tsx (SIDEBAR_TABS entry 'canvases',
 *    TabsContent value 'canvases' rendering CanvasSidebar, plus
 *    CanvasActions in the tab header). Gate the TabsContent body on
 *    useFeatureFlag('canvas') and render CanvasDisabledPanel while the
 *    flag is off, and disable CanvasActions. Canvas editor tabs are
 *    rendered separately in src/app/core/main/editor/editor-layout.tsx
 *    (CanvasEditor for canvas tabs); gate that branch the same way so a
 *    restored canvas tab shows the disabled panel instead of an editor
 *    that cannot save.
 *
 * The top app bar already demonstrates both panels' framework through
 * disabled toolbar buttons; these panels are the full-surface form for
 * the wiring points above.
 */

export function AiChatDisabledPanel({ className }: { className?: string }) {
  return <DisabledFeature feature="ai-chat" variant="panel" className={className} />
}

export function CanvasDisabledPanel({ className }: { className?: string }) {
  return <DisabledFeature feature="canvas" variant="panel" className={className} />
}
