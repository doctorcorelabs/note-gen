import { platform } from '@/lib/platform'

import { getDefaultArticleAbsolutePath, getFilePathOptions } from '@/lib/workspace'
import { deleteSelfHostedWorkspacePath } from '@/lib/self-hosted-sync/files'
import { checkIsTauri, isMobileDevice } from '@/lib/check'
import type { MovePathsToTrashResult } from '@/lib/platform/invoke/workspace-trash-handler'

async function resolveExistingAbsolutePath(relativePath: string, workspaceRoot?: string) {
  if (workspaceRoot) {
    const absolutePath = await platform.path.join(workspaceRoot, relativePath)
    return await platform.fs.exists(absolutePath) ? absolutePath : null
  }
  const options = await getFilePathOptions(relativePath)
  const pathExists = options.baseDir
    ? await platform.fs.exists(options.path, { baseDir: options.baseDir })
    : await platform.fs.exists(options.path)

  if (!pathExists) return null
  return options.baseDir
    ? getDefaultArticleAbsolutePath(relativePath)
    : options.path
}

export async function moveEntriesToSystemTrash(relativePaths: string[], workspaceRoot?: string) {
  let journaled = 0
  const remaining: string[] = []
  for (const relativePath of relativePaths) {
    if (!workspaceRoot && await deleteSelfHostedWorkspacePath(relativePath)) journaled++
    else remaining.push(relativePath)
  }
  const resolvedPaths = await Promise.all(remaining.map(path => resolveExistingAbsolutePath(path, workspaceRoot)))
  const paths = resolvedPaths.filter((path): path is string => Boolean(path))

  if (paths.length > 0) {
    if (isMobileDevice()) {
      for (const path of paths) await platform.fs.remove(path, { recursive: true })
    } else if (!checkIsTauri()) {
      // Web mode (UTANG-UJI-10): POST /api/workspace/trash only
      // accepts workspace-relative paths; the virtual absolute
      // paths (/appdata/article/...) are rejected per item as
      // path_escapes_workspace. Send the relative paths of the
      // entries that exist, and treat any rejected item as a
      // failure instead of reporting a silent success.
      const existingRelativePaths = remaining.filter((_, index) => Boolean(resolvedPaths[index]))
      const result = await platform.invoke.invoke<MovePathsToTrashResult>('move_paths_to_trash', { paths: existingRelativePaths })
      if (result.rejected.length > 0) {
        throw new Error(`Failed to move ${result.rejected.length} item(s) to trash.`)
      }
      return journaled + result.moved.length + result.notFound.length
    } else {
      await platform.invoke.invoke('move_paths_to_trash', { paths })
    }
  }
  return journaled + paths.length
}

export async function moveEntryToSystemTrash(relativePath: string, workspaceRoot?: string) {
  return (await moveEntriesToSystemTrash([relativePath], workspaceRoot)) > 0
}
