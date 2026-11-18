'use client'

import { useCallback, useState } from 'react'
import { platform, type DialogPickedFile } from '@/lib/platform'
import { checkIsTauri } from '@/lib/check'
import { useTranslations } from 'next-intl'
import { toast } from '@/hooks/use-toast'
import { getWorkspacePath } from '@/lib/workspace'
import useArticleStore from '@/stores/article'
import { getDocumentFileName, parseLocalDocument } from '@/lib/document-parser'

export const DOCUMENT_TO_MARKDOWN_EXTENSIONS = [
  'doc', 'docx', 'docm',
  'ppt', 'pps', 'pot', 'pptx', 'pptm', 'ppsx', 'ppsm',
  'xls', 'xlsx', 'xlsm', 'xlsb',
  'odt', 'ods', 'odp',
  'rtf', 'epub', 'csv', 'pdf',
]

function markdownNameFromDocumentName(fileName: string) {
  const extensionIndex = fileName.lastIndexOf('.')
  const baseName = extensionIndex > 0 ? fileName.slice(0, extensionIndex) : fileName
  return `${baseName || 'document'}.md`
}

async function getAvailableMarkdownPath(targetDir: string, fileName: string) {
  const markdownName = markdownNameFromDocumentName(fileName)
  const baseName = markdownName.slice(0, -3)
  let candidate = await platform.path.join(targetDir, markdownName)
  let suffix = 1

  while (await platform.fs.exists(candidate)) {
    candidate = await platform.path.join(targetDir, `${baseName} (${suffix}).md`)
    suffix += 1
  }

  return candidate
}

async function copyMarkdownFilesRecursively(
  sourceDir: string,
  targetDir: string,
  relativePath = ''
): Promise<number> {
  let copiedCount = 0
  const entries = await platform.fs.readDir(sourceDir)

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue
    }

    const sourcePath = await platform.path.join(sourceDir, entry.name)
    const nextRelativePath = relativePath ? await platform.path.join(relativePath, entry.name) : entry.name
    const targetPath = await platform.path.join(targetDir, nextRelativePath)

    if (entry.isDirectory) {
      copiedCount += await copyMarkdownFilesRecursively(sourcePath, targetDir, nextRelativePath)
      continue
    }

    if (!entry.isFile) {
      continue
    }

    const isMarkdown = entry.name.endsWith('.md')
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(entry.name)
    if (!isMarkdown && !isImage) {
      continue
    }

    const targetDirectory = relativePath ? await platform.path.join(targetDir, relativePath) : targetDir
    if (!await platform.fs.exists(targetDirectory)) {
      await platform.fs.mkdir(targetDirectory, { recursive: true })
    }

    await platform.fs.copyFile(sourcePath, targetPath)
    copiedCount++
  }

  return copiedCount
}

async function copyPickedMarkdownFiles(
  picked: DialogPickedFile[],
  targetDir: string,
): Promise<number> {
  let copiedCount = 0

  for (const entry of picked) {
    // Directory picks report paths relative to the picked directory
    // through the File System Access API, but the hidden-input
    // fallback reports webkitRelativePath, which prefixes the picked
    // directory name. Handles only exist on the first shape, so a
    // handle-less relative path loses its first segment.
    const reported = entry.relativePath.replace(/\\/g, '/')
    const relativePath = entry.handle
      ? reported
      : reported.split('/').slice(1).join('/') || entry.name
    const parts = relativePath.split('/').filter(part => part !== '' && part !== '.')
    if (parts.length === 0 || parts.some(part => part === '..')) {
      continue
    }

    // Hidden files and hidden directories are skipped, matching the
    // desktop recursive copy.
    if (parts.some(part => part.startsWith('.'))) {
      continue
    }
    const fileName = parts[parts.length - 1]
    const isMarkdown = fileName.endsWith('.md')
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(fileName)
    if (!isMarkdown && !isImage) {
      continue
    }

    const targetDirectory = parts.length > 1
      ? await platform.path.join(targetDir, ...parts.slice(0, -1))
      : targetDir
    if (!await platform.fs.exists(targetDirectory)) {
      await platform.fs.mkdir(targetDirectory, { recursive: true })
    }

    const targetPath = await platform.path.join(targetDirectory, fileName)
    await platform.fs.writeFile(targetPath, new Uint8Array(await entry.file.arrayBuffer()))
    copiedCount++
  }

  return copiedCount
}

export function useMarkdownImport() {
  const [isImporting, setIsImporting] = useState(false)
  const loadFileTree = useArticleStore(state => state.loadFileTree)
  const t = useTranslations('article.file.toolbar')

  const importMarkdown = useCallback(async () => {
    if (isImporting) {
      return
    }

    setIsImporting(true)
    try {
      const workspace = await getWorkspacePath()
      const targetDir = workspace.isCustom
        ? workspace.path
        : await platform.path.join(await platform.path.appDataDir(), 'article')
      let copiedCount: number
      if (!checkIsTauri()) {
        // Web mode has no OS paths: the content-shaped directory
        // pick returns the picked files with their content.
        // Path-shaped open() rejects here.
        const picked = await platform.dialog.openFiles({
          directory: true,
          multiple: false,
          title: t('importMarkdown'),
        })
        if (!picked) {
          return
        }
        const pickedFiles = Array.isArray(picked) ? picked : [picked]
        copiedCount = await copyPickedMarkdownFiles(pickedFiles, targetDir)
      } else {
        const selectedPath = await platform.dialog.open({
          directory: true,
          multiple: false,
          title: t('importMarkdown'),
        })

        if (!selectedPath || Array.isArray(selectedPath)) {
          return
        }

        copiedCount = await copyMarkdownFilesRecursively(selectedPath, targetDir)
      }

      await loadFileTree()
      toast({
        title: t('importSuccess'),
        description: t('importSuccessDesc', { count: copiedCount }),
      })
    } catch (error) {
      console.error('Import markdown error:', error)
      toast({
        title: t('importError'),
        description: String(error),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t])

  const importNotionZip = useCallback(async () => {
    if (isImporting) {
      return
    }

    setIsImporting(true)
    try {
      const selectedPath = await platform.dialog.open({
        multiple: false,
        filters: [{ name: 'Notion Export', extensions: ['zip'] }],
        title: t('importNotion'),
      })

      if (!selectedPath || Array.isArray(selectedPath)) {
        return
      }

      const workspace = await getWorkspacePath()
      const targetDir = workspace.isCustom
        ? workspace.path
        : await platform.path.join(await platform.path.appDataDir(), 'article')
      const copiedCount = await platform.invoke.invoke<number>('import_notion_zip', {
        zipPath: selectedPath,
        targetDir,
      })

      await loadFileTree()
      toast({
        title: t('importSuccess'),
        description: t('importSuccessDesc', { count: copiedCount }),
      })
    } catch (error) {
      console.error('Import notion zip error:', error)
      toast({
        title: t('importError'),
        description: String(error),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t])

  const convertDocumentsToMarkdown = useCallback(async () => {
    if (isImporting) {
      return
    }

    setIsImporting(true)
    try {
      const selected = await platform.dialog.open({
        multiple: true,
        directory: false,
        filters: [{
          name: t('convertFileType'),
          extensions: DOCUMENT_TO_MARKDOWN_EXTENSIONS,
        }],
        title: t('convertDialogTitle'),
      })

      if (!selected) {
        return
      }

      const selectedPaths = Array.isArray(selected) ? selected : [selected]
      const workspace = await getWorkspacePath()
      const targetDir = workspace.isCustom
        ? workspace.path
        : await platform.path.join(await platform.path.appDataDir(), 'article')
      let convertedCount = 0
      const failures: string[] = []

      for (const sourcePath of selectedPaths) {
        const fileName = getDocumentFileName(sourcePath)
        try {
          const parsed = await parseLocalDocument(sourcePath, fileName)
          const targetPath = await getAvailableMarkdownPath(targetDir, fileName)
          await platform.fs.writeTextFile(targetPath, parsed.markdown)
          convertedCount += 1
        } catch (error) {
          console.error(`Convert document to Markdown failed: ${fileName}`, error)
          failures.push(fileName)
        }
      }

      if (convertedCount > 0) {
        await loadFileTree()
        toast({
          title: t('convertSuccess'),
          description: failures.length > 0
            ? t('convertPartialDesc', { success: convertedCount, failed: failures.length })
            : t('convertSuccessDesc', { count: convertedCount }),
        })
      } else if (failures.length > 0) {
        toast({
          title: t('convertError'),
          description: failures.join(', '),
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('Convert documents to Markdown error:', error)
      toast({
        title: t('convertError'),
        description: String(error),
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t])

  return { isImporting, importMarkdown, importNotionZip, convertDocumentsToMarkdown }
}
