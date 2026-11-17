// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

'use client'

import { BookOpen, Cog, MessageSquare, Palette, PanelLeft, PanelRight, ScanLine, Settings, SquarePen } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { useSidebarStore } from '@/stores/sidebar'
import { PluginTitleBar } from '../plugins/plugin-title-bar'
import AppStatus from '../app-status'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Button } from '@/components/ui/button'
import useSettingStore from '@/stores/setting'
import useUpdateStore from '@/stores/update'
import { ControlText } from '@/app/core/main/mark/control-text'
import { ControlRecording } from '@/app/core/main/mark/control-recording'
import { ControlImage } from '@/app/core/main/mark/control-image'
import { ControlLink } from '@/app/core/main/mark/control-link'
import { ControlFile } from '@/app/core/main/mark/control-file'
import { ControlTodo } from '@/app/core/main/mark/control-todo'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  SortableContext,
  horizontalListSortingStrategy,
} from '@dnd-kit/sortable'
import { DraggableToolbarItem } from '../draggable-toolbar-item'
import { useToolbarShortcuts } from '@/hooks/use-toolbar-shortcuts'
import { useSettingsDialogStore } from '@/stores/settings-dialog'
import { useWikiNavigation } from '@/components/wiki/use-wiki-navigation'
import { useIsMobile } from '@/hooks/use-mobile'
import { DisabledFeatureButton } from './disabled-feature'
import { SessionMenu } from './session-menu'

/**
 * Top app bar for the web shell. Replacement for the desktop TitleBar
 * (src/components/title-bar.tsx), which stays in the repo untouched for
 * the desktop build.
 *
 * Removed, because the browser owns the window: minimize, maximize,
 * restore, and close controls, the always-on-top pin toggle, the Tauri
 * drag region attributes, the macOS traffic-light padding, and Tauri
 * platform detection. The bar hides on narrow viewports via
 * useIsMobile (viewport based, matching the two-shell routing), instead
 * of hiding on Tauri platform detection.
 *
 * Kept from TitleBar without behavior change: the three panel toggles
 * with the never-close-the-last-panel guard, the draggable record
 * toolbar with its stored order, the wiki button, the settings button,
 * AppStatus, and the three PluginTitleBar slots. Bar height stays
 * 36px so the core layout offset below it is unchanged.
 *
 * The scan toolbar item does not mount ControlScan: screenshot capture
 * has no web equivalent, so it renders an explicit disabled state
 * through the disabled-feature framework. AI chat and canvas, both
 * outside the Phase 1 scope, render as disabled buttons in the right
 * cluster; activating any of them opens the centralized dialog with
 * the explicit explanation. See disabled-feature-panels.tsx for the
 * full-surface wiring points.
 */
export function TopAppBar() {
  const { openFolder: openWikiFolder } = useWikiNavigation()
  const isMobile = useIsMobile()
  const { open: settingsOpen, openSettings, closeSettings } = useSettingsDialogStore()
  const { leftSidebarVisible, centerPanelVisible, rightSidebarVisible, toggleLeftSidebar, toggleCenterPanel, toggleRightSidebar } = useSidebarStore()

  // Guard: closing a panel must never leave zero panels, and must never
  // leave the left panel alone (the layout needs a center or right panel).
  const wouldCauseLeftOnly = (currentVisible: boolean, panel: 'left' | 'center' | 'right') => {
    // Opening a hidden panel is always allowed.
    if (!currentVisible) return false

    const visibleCount = [leftSidebarVisible, centerPanelVisible, rightSidebarVisible].filter(Boolean).length

    if (visibleCount === 1) return true

    if (visibleCount === 2) {
      if (panel === 'center' && leftSidebarVisible && !rightSidebarVisible) return true
      if (panel === 'right' && leftSidebarVisible && !centerPanelVisible) return true
    }

    return false
  }
  const { recordToolbarConfig, setRecordToolbarConfig } = useSettingStore()
  const { hasUpdate } = useUpdateStore()
  const t = useTranslations()
  const { isModifierPressed } = useToolbarShortcuts()

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        delay: 200,
        tolerance: 5,
      },
    })
  )

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event

    if (over && active.id !== over.id) {
      const oldIndex = recordToolbarConfig.findIndex((item) => item.id === active.id)
      const newIndex = recordToolbarConfig.findIndex((item) => item.id === over.id)

      const newItems = arrayMove(recordToolbarConfig, oldIndex, newIndex)
      const updatedItems = newItems.map((item, index) => ({
        ...item,
        order: index
      }))
      setRecordToolbarConfig(updatedItems)
    }
  }

  // Narrow viewports use the mobile shell, which has its own chrome.
  if (isMobile) {
    return null
  }

  return (
    <TooltipProvider>
      <div
        className="fixed top-0 right-0 left-0 z-40 flex h-[36px] w-full shrink-0 flex-nowrap items-center border-b bg-background select-none"
      >
        {/* App identity, on the side window controls used to occupy. */}
        <div className="flex shrink-0 items-center pr-1 pl-3">
          <span className="text-sm font-semibold tracking-tight">NoteGen</span>
        </div>

        {/* Record toolbar buttons */}
        <div id="onboarding-target-record-toolbar" className="flex items-center gap-0.5 px-2 shrink-0">
          <TooltipProvider>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={recordToolbarConfig.filter(item => item.enabled).map(item => item.id)}
                strategy={horizontalListSortingStrategy}
              >
                <div className="flex">
                  {recordToolbarConfig
                    .filter(item => item.enabled)
                    .sort((a, b) => a.order - b.order)
                    .map((item, index) => {
                      const renderToolbarItem = () => {
                        switch (item.id) {
                          case 'text':
                            return <ControlText />
                          case 'recording':
                            return <ControlRecording />
                          case 'scan':
                            return <DisabledFeatureButton feature="screenshot-scan" icon={<ScanLine className="h-4 w-4" />} />
                          case 'image':
                            return <ControlImage />
                          case 'link':
                            return <ControlLink />
                          case 'file':
                            return <ControlFile />
                          case 'todo':
                            return <ControlTodo />
                          default:
                            return null
                        }
                      }

                      return (
                        <DraggableToolbarItem
                          key={item.id}
                          id={item.id}
                          shortcutNumber={index + 1}
                          showShortcut={isModifierPressed && index < 9}
                        >
                          {renderToolbarItem()}
                        </DraggableToolbarItem>
                      )
                    })}
                </div>
              </SortableContext>
            </DndContext>
          </TooltipProvider>
        </div>

        <PluginTitleBar location="title-bar-left" />

        <div className="flex min-w-[120px] flex-1 items-center justify-center self-stretch px-[60px]">
          <PluginTitleBar location="title-bar-center" />
        </div>

        {/* Right-side buttons */}
        <div className="flex items-center gap-0.5 px-2 shrink-0">
          <PluginTitleBar location="title-bar-right" />
          <Tooltip>
            <TooltipTrigger asChild><Button variant="ghost" size="icon" className="size-8" aria-label={t('wiki.open')} onClick={() => void openWikiFolder()}><BookOpen /></Button></TooltipTrigger>
            <TooltipContent side="bottom">{t('wiki.title')}</TooltipContent>
          </Tooltip>
          {/* Disabled Phase 2 features: explicit state, never silent. */}
          <DisabledFeatureButton feature="ai-chat" icon={<MessageSquare className="h-4 w-4" />} />
          <DisabledFeatureButton feature="canvas" icon={<Palette className="h-4 w-4" />} />
          {/* Left sidebar toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 ${wouldCauseLeftOnly(leftSidebarVisible, 'left') ? 'cursor-not-allowed opacity-50' : ''}`}
                onClick={() => {
                  if (!wouldCauseLeftOnly(leftSidebarVisible, 'left')) {
                    toggleLeftSidebar()
                  }
                }}
              >
                <PanelLeft className={`h-4 w-4 ${!leftSidebarVisible ? 'opacity-30' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{leftSidebarVisible ? t('navigation.hideLeftSidebar') : t('navigation.showLeftSidebar')}</p>
            </TooltipContent>
          </Tooltip>

          {/* Center panel toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 ${wouldCauseLeftOnly(centerPanelVisible, 'center') ? 'cursor-not-allowed opacity-50' : ''}`}
                onClick={() => {
                  if (!wouldCauseLeftOnly(centerPanelVisible, 'center')) {
                    toggleCenterPanel()
                  }
                }}
              >
                <SquarePen className={`h-4 w-4 ${!centerPanelVisible ? 'opacity-30' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{centerPanelVisible ? t('navigation.hideCenterPanel') : t('navigation.showCenterPanel')}</p>
            </TooltipContent>
          </Tooltip>

          {/* Right sidebar toggle */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 ${wouldCauseLeftOnly(rightSidebarVisible, 'right') ? 'cursor-not-allowed opacity-50' : ''}`}
                onClick={() => {
                  if (!wouldCauseLeftOnly(rightSidebarVisible, 'right')) {
                    toggleRightSidebar()
                  }
                }}
              >
                <PanelRight className={`h-4 w-4 ${!rightSidebarVisible ? 'opacity-30' : ''}`} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{rightSidebarVisible ? t('navigation.hideRightSidebar') : t('navigation.showRightSidebar')}</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={`h-8 w-8 relative ${settingsOpen ? 'bg-primary/50 hover:bg-primary/60' : ''}`}
                onClick={() => settingsOpen ? closeSettings() : openSettings()}
              >
                {settingsOpen ? (
                  <Cog className="h-4 w-4" />
                ) : (
                  <Settings className="h-4 w-4" />
                )}
                {hasUpdate && !settingsOpen && (
                  <span className="absolute top-1 right-1 h-2 w-2 rounded-full bg-red-500" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <p>{settingsOpen ? t('common.back') : t('common.settings')}</p>
            </TooltipContent>
          </Tooltip>

          <SessionMenu />

          <AppStatus />
        </div>
      </div>
    </TooltipProvider>
  )
}
