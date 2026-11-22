'use client'

import { useCallback, useState } from 'react'
import { platform, type DialogPickedFile } from '@/lib/platform'
import { checkIsTauri } from '@/lib/check'
import { useTranslations } from 'next-intl'
import { useUserErrorMessage } from "@/lib/use-user-error-message";
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

// DA-12-11: folder import must not overwrite an existing workspace
// file through copyFile without a dialog. The document import above
// already avoids overwrites with getAvailableMarkdownPath; folder
// import gets the same treatment, preserving the exact file name
// and extension. A colliding name lands on a suffixed copy, so an
// import can never blank an existing file.
async function getAvailableCopyPath(targetDir: string, fileName: string) {
  let candidate = await platform.path.join(targetDir, fileName)
  let suffix = 1
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''

  while (await platform.fs.exists(candidate)) {
    candidate = await platform.path.join(targetDir, `${stem} (${suffix})${ext}`)
    suffix += 1
  }

  return candidate
}

export interface MarkdownCopyResult {
  copied: number
  failures: string[]
  // DA-6 IMP-05: files skipped by policy (hidden, unsupported
  // type) are counted instead of vanishing silently.
  skipped: number
}

// EXP4-13 (AD-1050): import caps. The web picked-files path used
// to load every file fully into tab memory with no per-file,
// count, or total limit. Caps are enforced from the
// browser-reported size before any bytes are read; the desktop
// recursive copy applies the same caps with stat sizes when
// available. Values: 10 MiB per file (a markdown note or image
// beyond that is not a note import), 500 files per import, and
// 100 MiB total per import.
export const MARKDOWN_IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024
export const MARKDOWN_IMPORT_MAX_FILES = 500
export const MARKDOWN_IMPORT_MAX_TOTAL_BYTES = 100 * 1024 * 1024

// DA-6 IMP-04: extension checks are case-insensitive; a .MD or
// .Md file imports as markdown instead of being skipped.
export function isMarkdownFileName(fileName: string) {
  return fileName.toLowerCase().endsWith('.md')
}

// DA-2 (IMP-02): per-file failures are collected and reported
// instead of aborting the whole folder import at the first bad
// file (mirrors convertDocumentsToMarkdown in this file).
export async function copyMarkdownFilesRecursively(
  sourceDir: string,
  targetDir: string,
  relativePath = '',
  budget: { files: number; bytes: number } = { files: 0, bytes: 0 }
): Promise<MarkdownCopyResult> {
  const result: MarkdownCopyResult = { copied: 0, failures: [], skipped: 0 }
  const entries = await platform.fs.readDir(sourceDir)

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      result.skipped += 1
      continue
    }

    const sourcePath = await platform.path.join(sourceDir, entry.name)
    const nextRelativePath = relativePath ? await platform.path.join(relativePath, entry.name) : entry.name

    try {
      if (entry.isDirectory) {
        const nested = await copyMarkdownFilesRecursively(sourcePath, targetDir, nextRelativePath, budget)
        result.copied += nested.copied
        result.failures.push(...nested.failures)
        result.skipped += nested.skipped
        continue
      }

      if (!entry.isFile) {
        result.skipped += 1
        continue
      }

      const isMarkdown = isMarkdownFileName(entry.name)
      const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(entry.name)
      if (!isMarkdown && !isImage) {
        result.skipped += 1
        continue
      }

      const targetDirectory = relativePath ? await platform.path.join(targetDir, relativePath) : targetDir
      if (!await platform.fs.exists(targetDirectory)) {
        await platform.fs.mkdir(targetDirectory, { recursive: true })
      }

      // EXP4-13 (AD-1050): caps for the desktop recursive copy.
      // Size comes from stat when the platform answers; a
      // missing stat keeps the count cap only.
      let fileSize: number | undefined
      try {
        fileSize = (await platform.fs.stat(sourcePath)).size
      } catch {
        fileSize = undefined
      }
      if (fileSize !== undefined && fileSize > MARKDOWN_IMPORT_MAX_FILE_BYTES) {
        result.failures.push(entry.name)
        continue
      }
      if (budget.files >= MARKDOWN_IMPORT_MAX_FILES) {
        result.skipped += 1
        continue
      }
      if (fileSize !== undefined && budget.bytes + fileSize > MARKDOWN_IMPORT_MAX_TOTAL_BYTES) {
        result.failures.push(entry.name)
        continue
      }

      const availableTarget = await getAvailableCopyPath(targetDirectory, entry.name)
      await platform.fs.copyFile(sourcePath, availableTarget)
      result.copied++
      budget.files += 1
      budget.bytes += fileSize ?? 0
    } catch (error) {
      console.error(`Import copy failed: ${entry.name}`, error)
      result.failures.push(entry.name)
    }
  }

  return result
}

export async function copyPickedMarkdownFiles(
  picked: DialogPickedFile[],
  targetDir: string,
): Promise<MarkdownCopyResult> {
  const result: MarkdownCopyResult = { copied: 0, failures: [], skipped: 0 }
  let totalBytes = 0

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
      result.skipped += 1
      continue
    }

    // Hidden files and hidden directories are skipped, matching the
    // desktop recursive copy.
    if (parts.some(part => part.startsWith('.'))) {
      result.skipped += 1
      continue
    }
    const fileName = parts[parts.length - 1]
    const isMarkdown = isMarkdownFileName(fileName)
    const isImage = /\.(jpg|jpeg|png|gif|bmp|webp|svg)$/i.test(fileName)
    if (!isMarkdown && !isImage) {
      result.skipped += 1
      continue
    }

    // EXP4-13 (AD-1050): web import caps, checked from the
    // browser-reported size before any bytes are read into the
    // tab. Oversized files land in failures so the import toast
    // names them; files past the count cap count as skipped.
    if (entry.size > MARKDOWN_IMPORT_MAX_FILE_BYTES) {
      result.failures.push(fileName)
      continue
    }
    if (result.copied >= MARKDOWN_IMPORT_MAX_FILES) {
      result.skipped += 1
      continue
    }
    if (totalBytes + entry.size > MARKDOWN_IMPORT_MAX_TOTAL_BYTES) {
      result.failures.push(fileName)
      continue
    }

    try {
      const targetDirectory = parts.length > 1
        ? await platform.path.join(targetDir, ...parts.slice(0, -1))
        : targetDir
      if (!await platform.fs.exists(targetDirectory)) {
        await platform.fs.mkdir(targetDirectory, { recursive: true })
      }

      // DA-12-11 reconciliation (R24-OVLP3): the web picked-files
      // path gets the same no-overwrite treatment as the desktop
      // recursive copy; a colliding name lands on a suffixed copy.
      const targetPath = await getAvailableCopyPath(targetDirectory, fileName)
      await platform.fs.writeFile(targetPath, new Uint8Array(await entry.file.arrayBuffer()))
      result.copied++
      totalBytes += entry.size
    } catch (error) {
      console.error(`Import copy failed: ${fileName}`, error)
      result.failures.push(fileName)
    }
  }

  return result
}

export function useMarkdownImport() {
  const [isImporting, setIsImporting] = useState(false)
  const loadFileTree = useArticleStore(state => state.loadFileTree)
  const t = useTranslations('article.file.toolbar')
  const userErrorMessage = useUserErrorMessage()

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
      let copyResult: MarkdownCopyResult
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
        copyResult = await copyPickedMarkdownFiles(pickedFiles, targetDir)
      } else {
        const selectedPath = await platform.dialog.open({
          directory: true,
          multiple: false,
          title: t('importMarkdown'),
        })

        if (!selectedPath || Array.isArray(selectedPath)) {
          return
        }

        copyResult = await copyMarkdownFilesRecursively(selectedPath, targetDir)
      }

      if (copyResult.copied > 0) {
        await loadFileTree()
        toast({
          title: t('importSuccess'),
          description: copyResult.failures.length > 0
            ? t('importPartialDesc', { success: copyResult.copied, failed: copyResult.failures.length })
            : copyResult.skipped > 0
              ? t('importSkippedDesc', { count: copyResult.copied, skipped: copyResult.skipped })
              : t('importSuccessDesc', { count: copyResult.copied }),
        })
      } else if (copyResult.failures.length > 0) {
        toast({
          title: t('importError'),
          description: copyResult.failures.join(', '),
          variant: 'destructive',
        })
      } else if (copyResult.skipped > 0) {
        // DA-6 IMP-05: everything was skipped by policy; say so
        // instead of staying silent. (An empty folder and a
        // cancelled pick still look alike here - recorded bound.)
        toast({
          title: t('importError'),
          description: t('importNoneDesc'),
          variant: 'destructive',
        })
      }
    } catch (error) {
      console.error('Import markdown error:', error)
      toast({
        title: t('importError'),
        description: userErrorMessage(error) ?? undefined,
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t, userErrorMessage])

  const importNotionZip = useCallback(async () => {
    // Web fork (Fase 1, IMP-03): the path-shaped dialog rejects in
    // web mode and the Notion import endpoint does not exist yet,
    // so this can never succeed there. The file-actions handler
    // shows the explicit marker; this guard keeps any other caller
    // from reaching the dialog. Desktop behavior is unchanged.
    if (!checkIsTauri()) {
      return
    }
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
        description: userErrorMessage(error) ?? undefined,
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t, userErrorMessage])

  const convertDocumentsToMarkdown = useCallback(async () => {
    // Web fork (Fase 1, IMP-03): same web guard as importNotionZip
    // above (path-shaped dialog rejects; parse_document is a
    // Phase 2 stub). The file-actions handler owns the marker.
    if (!checkIsTauri()) {
      return
    }
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
        description: userErrorMessage(error) ?? undefined,
        variant: 'destructive',
      })
    } finally {
      setIsImporting(false)
    }
  }, [isImporting, loadFileTree, t, userErrorMessage])

  return { isImporting, importMarkdown, importNotionZip, convertDocumentsToMarkdown }
}
