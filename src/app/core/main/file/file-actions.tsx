"use client"

import { TooltipButton } from "@/components/tooltip-button"
import { FilePlus, FolderPlus, RefreshCw } from "lucide-react"
import { useTranslations } from "next-intl"
import { useState } from "react"
import useArticleStore from "@/stores/article"
import { debounce } from "lodash-es"
import { FileMoreMenu } from './file-more-menu'
import { useMarkdownImport } from './use-markdown-import'
import { checkIsTauri } from '@/lib/check'
import { toast } from '@/hooks/use-toast'
import { DocumentToMarkdownDialog } from './document-to-markdown-dialog'

export function FileActions() {
  const { newFolder, newFile, loadFileTree, loadRemoteSyncFiles, fileTreeLoading } = useArticleStore()
  const t = useTranslations('article.file.toolbar')
  const { isImporting, importMarkdown, importNotionZip, convertDocumentsToMarkdown } = useMarkdownImport()
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [convertDialogOpen, setConvertDialogOpen] = useState(false)

  const debounceNewFile = debounce(newFile, 200)
  const debounceNewFolder = debounce(newFolder, 200)

  // Web fork (Fase 1, IMP-03): document conversion and Notion
  // import need the path-shaped dialog plus desktop-only backends
  // (parse_document is a Phase 2 stub; the Notion import endpoint
  // does not exist yet), so both always fail in web mode. Show the
  // explicit marker instead; the menu entries stay visible and
  // the convert dialog never opens. Desktop behavior is unchanged.
  function handleConvertDocuments() {
    if (!checkIsTauri()) {
      toast({ title: t('importUnavailableWeb'), description: t('importUnavailableWebDesc') })
      return
    }
    setConvertDialogOpen(true)
  }

  function handleImportNotion() {
    if (!checkIsTauri()) {
      toast({ title: t('importUnavailableWeb'), description: t('importUnavailableWebDesc') })
      return
    }
    void importNotionZip()
  }

  async function handleRefresh() {
    if (isRefreshing) return

    setIsRefreshing(true)
    try {
      await loadFileTree({ skipRemoteSync: true })
      await loadRemoteSyncFiles()
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <>
      <div className="flex items-center gap-1">
        <TooltipButton
          icon={<FilePlus className="h-4 w-4" />}
          tooltipText={t('newArticle')}
          onClick={debounceNewFile}
          side="bottom"
        />
        <TooltipButton
          icon={<FolderPlus className="h-4 w-4" />}
          tooltipText={t('newFolder')}
          onClick={debounceNewFolder}
          side="bottom"
        />
        <TooltipButton
          icon={<RefreshCw className={`h-4 w-4 ${fileTreeLoading || isRefreshing ? 'animate-spin' : ''}`} />}
          tooltipText={t('refresh')}
          onClick={() => void handleRefresh()}
          disabled={fileTreeLoading || isRefreshing}
          side="bottom"
        />
        <FileMoreMenu
          isImporting={isImporting}
          onImportMarkdown={() => void importMarkdown()}
          onConvertDocuments={handleConvertDocuments}
          onImportNotion={handleImportNotion}
        />
      </div>
      <DocumentToMarkdownDialog
        open={convertDialogOpen}
        importing={isImporting}
        onOpenChange={setConvertDialogOpen}
        onSelect={() => void convertDocumentsToMarkdown()}
      />
    </>
  )
}
