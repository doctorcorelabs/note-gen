// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { DisabledFeature } from './disabled-feature'

/**
 * Drop-in disabled panels for the features demonstrated by the web
 * chrome framework: AI chat, canvas, and plugins.
 *
 * Wiring points (owned by the integrator; this file only provides the
 * panels, it does not mount them into the sidebar, tab system, or
 * settings dialog):
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
 * 3. Plugins: the settings page in
 *    src/app/core/setting/plugins/page.tsx (surface A2 in
 *    fase1/inventaris-plugin-off.md) must render PluginsDisabledPanel
 *    in place of its whole tab set while the 'plugins' flag is off, and
 *    must not call initialize() or refreshMarket(). The same panel is
 *    the fallback for a restored plugin settings section (A14) and for
 *    the mobile plugins page (A15). Two surfaces need the message
 *    override form of DisabledFeature instead of this panel: the plugin
 *    theme packages row (B4) and a restored plugin view editor tab
 *    (C3); their proposed variant keys and fallback texts are listed in
 *    the inventory. The flag alone does not stop plugin code: the host
 *    kill switch is owned separately (V2-31), and this panel must never
 *    be read as proof that no plugin code runs.
 *
 * The top app bar already demonstrates the AI chat and canvas panels'
 * framework through disabled toolbar buttons; these panels are the
 * full-surface form for the wiring points above. Plugins get no top
 * app bar button: the inventory forbids a global plugin status
 * indicator, and the settings panel is the single status statement.
 */

export function AiChatDisabledPanel({ className }: { className?: string }) {
  return <DisabledFeature feature="ai-chat" variant="panel" className={className} />
}

export function CanvasDisabledPanel({ className }: { className?: string }) {
  return <DisabledFeature feature="canvas" variant="panel" className={className} />
}

export function PluginsDisabledPanel({ className }: { className?: string }) {
  return <DisabledFeature feature="plugins" variant="panel" className={className} />
}
