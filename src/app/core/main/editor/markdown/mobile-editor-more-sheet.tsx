'use client'

import type { Editor } from '@tiptap/core'
import { useTranslations } from 'next-intl'
import { TEXT_COLORS, HIGHLIGHT_COLORS } from './color-marks'
import { PluginIcon } from '@/components/plugins/plugin-icon'
import { usePluginEditorCommands } from '@/components/plugins/use-plugin-editor-commands'
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { FieldSet, FieldLegend } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import {
  executePluginUserCommand,
  type RegisteredPluginCommand,
} from '@/lib/plugins/command-registry'
import { toast } from '@/hooks/use-toast'

type MobileSheetMode =
  | 'insert'
  | 'format'
  | 'ai'
  | 'ai-write'
  | 'ai-custom'
  | 'mobile-more'
  | 'image-src'
  | 'image-alt'
  | 'table-align'
  | 'table-more'
  | null

interface MobileEditorMoreSheetProps {
  editor?: Editor | null
  pluginsEnabled?: boolean
  open: boolean
  mode: MobileSheetMode
  imageSrc: string
  imageAlt: string
  customAiInstruction: string
  onOpenChange: (open: boolean) => void
  onImageSrcChange: (value: string) => void
  onImageAltChange: (value: string) => void
  onCustomAiInstructionChange: (value: string) => void
  onSubmitImageSrc: () => void
  onSubmitImageAlt: () => void
  onSubmitCustomAiInstruction: () => void
  onAction: (action: string) => void
}

function ActionButton({
  label,
  description,
  onClick,
  destructive = false,
  icon,
  disabled,
}: {
  label: string
  description?: string
  onClick: () => void
  destructive?: boolean
  icon?: string
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`w-full rounded-xl border px-3 py-3 text-left ${destructive ? 'border-destructive/30 text-destructive' : 'border-border text-foreground'}`}
      onClick={onClick}
    >
      <span className="flex items-center gap-2 text-sm font-medium">{icon ? <PluginIcon name={icon} className="size-4" /> : null}{label}</span>
      {description ? <span className="mt-1 block text-xs text-muted-foreground">{description}</span> : null}
    </button>
  )
}

export function MobileEditorMoreSheet({
  editor,
  pluginsEnabled = false,
  open,
  mode,
  imageSrc,
  imageAlt,
  customAiInstruction,
  onOpenChange,
  onImageSrcChange,
  onImageAltChange,
  onCustomAiInstructionChange,
  onSubmitImageSrc,
  onSubmitImageAlt,
  onSubmitCustomAiInstruction,
  onAction,
}: MobileEditorMoreSheetProps) {
  const colorLabel = useTranslations('editor.bubbleMenu.colors')
  const contributions = usePluginEditorCommands('mobile/writing/overflow', editor)
  const pluginCommands = pluginsEnabled ? contributions : []

  const runPluginCommand = (command: RegisteredPluginCommand) => {
    onOpenChange(false)
    void executePluginUserCommand(command.id).catch((error) => {
      toast({
        title: command.title,
        description: error instanceof Error ? error.message : String(error),
        variant: 'destructive',
      })
    })
  }

  const titleMap: Record<Exclude<MobileSheetMode, null>, string> = {
    insert: 'Insert content',
    format: 'Text format',
    ai: 'AI processing',
    'ai-write': 'AI writing',
    'ai-custom': 'Custom AI',
    'mobile-more': 'More writing tools',
    'image-src': 'Edit image URL',
    'image-alt': 'Edit image description',
    'table-align': 'Table alignment',
    'table-more': 'More table actions',
  }

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent className="max-h-[80vh]">
        <DrawerHeader>
          <DrawerTitle>{mode ? titleMap[mode] : 'More actions'}</DrawerTitle>
        </DrawerHeader>

        <div className="flex flex-col gap-3 overflow-y-auto px-4 pb-6">
          {mode === 'insert' && (
            <>
              <ActionButton label="Heading" description="Insert or switch to a level-2 heading" onClick={() => onAction('insert-heading-2')} />
              <ActionButton label="Bulleted list" onClick={() => onAction('insert-bullet-list')} />
              <ActionButton label="Ordered list" onClick={() => onAction('insert-ordered-list')} />
              <ActionButton label="Task list" onClick={() => onAction('insert-task-list')} />
              <ActionButton label="Quote" onClick={() => onAction('insert-blockquote')} />
              <ActionButton label="Code block" onClick={() => onAction('insert-code-block')} />
              <ActionButton label="Divider" onClick={() => onAction('insert-horizontal-rule')} />
              <ActionButton label="Image" description="Choose a local image to insert at the current cursor position" onClick={() => onAction('insert-image')} />
              <ActionButton label="Table" onClick={() => onAction('insert-table')} />
            </>
          )}

          {mode === 'format' && (
            <>
              <ActionButton label="Body text" onClick={() => onAction('format-paragraph')} />
              <ActionButton label="Heading 1" onClick={() => onAction('format-heading-1')} />
              <ActionButton label="Heading 2" onClick={() => onAction('format-heading-2')} />
              <ActionButton label="Heading 3" onClick={() => onAction('format-heading-3')} />
              <ActionButton label="Bold" onClick={() => onAction('format-bold')} />
              <ActionButton label="Italic" onClick={() => onAction('format-italic')} />
              <ActionButton label="Highlight" onClick={() => onAction('format-highlight')} />
              {(['text-color', 'highlight-color'] as const).map(kind => (
                <FieldSet key={kind} className="gap-2">
                  <FieldLegend>{colorLabel(kind === 'text-color' ? 'text' : 'highlight')}</FieldLegend>
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" size="sm" onClick={() => onAction(`${kind}:clear`)}>{colorLabel('clear')}</Button>
                    {(kind === 'text-color' ? TEXT_COLORS : HIGHLIGHT_COLORS).map((color, index) => (
                      <Button key={color} variant="outline" size="sm" onClick={() => onAction(`${kind}:${color}`)}>
                        <span aria-hidden="true" className="size-4 rounded-sm border" style={{ backgroundColor: color }} />
                        {colorLabel(['red', 'orange', 'yellow', 'green', 'blue', 'purple'][index])}
                      </Button>
                    ))}
                  </div>
                </FieldSet>
              ))}
            </>
          )}

          {mode === 'ai' && (
            <>
              <ActionButton label="Polish selected text" onClick={() => onAction('ai-polish')} />
              <ActionButton label="Condense selected text" onClick={() => onAction('ai-concise')} />
              <ActionButton label="Expand selected text" onClick={() => onAction('ai-expand')} />
            </>
          )}

          {mode === 'ai-write' && (
            <>
              <ActionButton label="Continue writing" description="Continue writing from the content around the cursor" onClick={() => onAction('ai-continue')} />
              <ActionButton label="Generate section" description="Add a complete paragraph at the current position" onClick={() => onAction('ai-generate-section')} />
              <ActionButton label="Summarize document" description="Generate a summary from the current note" onClick={() => onAction('ai-generate-summary')} />
              <Textarea
                value={customAiInstruction}
                onChange={(event) => onCustomAiInstructionChange(event.target.value)}
                placeholder="Enter a custom AI instruction, e.g., organize into meeting notes"
                rows={3}
                maxRows={8}
              />
              <Button onClick={onSubmitCustomAiInstruction}>Run custom instruction</Button>
            </>
          )}

          {mode === 'ai-custom' && (
            <>
              <Textarea
                value={customAiInstruction}
                onChange={(event) => onCustomAiInstructionChange(event.target.value)}
                placeholder="Enter a custom AI instruction, e.g., organize into meeting notes"
                rows={3}
                maxRows={8}
              />
              <Button onClick={onSubmitCustomAiInstruction}>Run custom instruction</Button>
            </>
          )}

          {mode === 'mobile-more' && (
            <>
              <ActionButton label="Text format" onClick={() => onAction('open-format-sheet')} />
              <ActionButton label="Search and replace" onClick={() => onAction('open-search-replace')} />
              <ActionButton label="Outline" onClick={() => onAction('toggle-outline')} />
              <ActionButton label="Inline formula" onClick={() => onAction('insert-inline-math')} />
              <ActionButton label="Block formula" onClick={() => onAction('insert-block-math')} />
              <ActionButton label="Mermaid diagram" onClick={() => onAction('insert-mermaid')} />
              {pluginCommands.map((command) => (
                <ActionButton
                  key={command.id}
                  label={command.title}
                  description={command.description}
                  icon={command.icon}
                  disabled={command.disabled}
                  onClick={() => runPluginCommand(command)}
                />
              ))}
            </>
          )}

          {mode === 'image-src' && (
            <>
              <Input value={imageSrc} onChange={(event) => onImageSrcChange(event.target.value)} placeholder="Enter the image URL" />
              <Button onClick={onSubmitImageSrc}>Save URL</Button>
            </>
          )}

          {mode === 'image-alt' && (
            <>
              <Input value={imageAlt} onChange={(event) => onImageAltChange(event.target.value)} placeholder="Enter the image description" />
              <Button onClick={onSubmitImageAlt}>Save description</Button>
            </>
          )}

          {mode === 'table-align' && (
            <>
              <ActionButton label="Align left" onClick={() => onAction('align-left')} />
              <ActionButton label="Center" onClick={() => onAction('align-center')} />
              <ActionButton label="Align right" onClick={() => onAction('align-right')} />
            </>
          )}

          {mode === 'table-more' && (
            <>
              <ActionButton label="Insert row above" onClick={() => onAction('add-row-before')} />
              <ActionButton label="Insert row below" onClick={() => onAction('add-row-after')} />
              <ActionButton label="Insert column left" onClick={() => onAction('add-column-before')} />
              <ActionButton label="Insert column right" onClick={() => onAction('add-column-after')} />
              <ActionButton label="Delete current row" onClick={() => onAction('delete-row')} destructive />
              <ActionButton label="Delete current column" onClick={() => onAction('delete-column')} destructive />
              <ActionButton label="Delete entire table" onClick={() => onAction('delete-table')} destructive />
            </>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  )
}

export default MobileEditorMoreSheet
