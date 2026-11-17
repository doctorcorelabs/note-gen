'use client'

import { Editor } from '@tiptap/react'
import { Copy, FileCode, FileJson, FileText } from 'lucide-react'
import { useCallback, useState } from 'react'
import { toast } from '@/hooks/use-toast'
import { markdownToPlainText } from '@/lib/markdown-to-plain-text'
import { parseMarkdownToJson, renderMarkdownToHtml } from '../markdown-export'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

interface CopyButtonProps {
  editor: Editor
  markdown?: string
  getMarkdown?: () => string
}

type CopyFormat = 'markdown' | 'html' | 'json' | 'text'

export function CopyButton({ editor, markdown, getMarkdown }: CopyButtonProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [copying, setCopying] = useState<CopyFormat | null>(null)

  const copyToClipboard = useCallback(async (
    getContent: string | (() => string | Promise<string>),
    format: CopyFormat
  ) => {
    try {
      setCopying(format)
      const content = typeof getContent === 'function'
        ? await getContent()
        : getContent
      await navigator.clipboard.writeText(content)
      toast({
        title: 'Copy Success',
        description: `Copied as ${format.toUpperCase()} format`
      })
    } catch {
      toast({
        title: 'Copy Failed',
        description: 'Unable to copy to the clipboard.',
        variant: 'destructive'
      })
    } finally {
      setCopying(null)
      setIsOpen(false)
    }
  }, [])

  const getCurrentMarkdown = useCallback(
    () => getMarkdown?.() ?? markdown ?? editor.getMarkdown(),
    [editor, getMarkdown, markdown],
  )

  const handleCopyMarkdown = useCallback(() => {
    void copyToClipboard(getCurrentMarkdown, 'markdown')
  }, [copyToClipboard, getCurrentMarkdown])

  const handleCopyHtml = useCallback(() => {
    void copyToClipboard(
      () => getMarkdown || markdown !== undefined
        ? renderMarkdownToHtml(getCurrentMarkdown())
        : editor.getHTML(),
      'html'
    )
  }, [copyToClipboard, editor, getCurrentMarkdown, getMarkdown, markdown])

  const handleCopyJson = useCallback(() => {
    void copyToClipboard(
      () => JSON.stringify(
        getMarkdown || markdown !== undefined ? parseMarkdownToJson(getCurrentMarkdown()) : editor.getJSON(),
        null,
        2
      ),
      'json'
    )
  }, [copyToClipboard, editor, getCurrentMarkdown, getMarkdown, markdown])

  const handleCopyText = useCallback(() => {
    void copyToClipboard(
      () => getMarkdown || markdown !== undefined
        ? markdownToPlainText(getCurrentMarkdown())
        : editor.getText(),
      'text'
    )
  }, [copyToClipboard, editor, getCurrentMarkdown, getMarkdown, markdown])

  return (
    <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
      <DropdownMenuTrigger asChild>
        <button
          title="Copy"
          className="flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-0"
        >
          <Copy className="size-3" />
          <span>Copy</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={4}
      >
        <DropdownMenuItem onClick={handleCopyMarkdown} disabled={copying !== null}>
          <FileText size={12} />
          <span>Markdown</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyHtml} disabled={copying !== null}>
          <FileCode size={12} />
          <span>HTML</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyJson} disabled={copying !== null}>
          <FileJson size={12} />
          <span>JSON</span>
        </DropdownMenuItem>
        <DropdownMenuItem onClick={handleCopyText} disabled={copying !== null}>
          <FileText size={12} />
          <span>Plain text</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default CopyButton
