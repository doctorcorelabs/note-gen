import type { BaseDirectory, WriteFileOptions } from '@/lib/platform'
import { debugSyncPath } from '@/lib/sync/remote-file'
import { isAlreadyExistsLike } from '../editor/markdown/revision-conflict'

type FilePathOptions = {
  path: string
  baseDir?: BaseDirectory
}

type RootDropDeps = {
  fileName: string
  getFilePathOptions: (relativePath: string) => Promise<FilePathOptions>
  exists?: (path: string, options?: { baseDir?: BaseDirectory }) => Promise<boolean>
  writeTextFile?: (path: string, content: string, options?: WriteFileOptions) => Promise<void>
  writeFile?: (path: string, content: Uint8Array, options?: WriteFileOptions) => Promise<void>
}

type RootDropPayload =
  | {
      kind: 'text'
      content: string
    }
  | {
      kind: 'binary'
      content: Uint8Array
    }

export function sanitizeDroppedFileName(fileName: string) {
  return fileName
}

export async function writeDroppedFileToRoot(deps: RootDropDeps, payload: RootDropPayload) {
  const sanitizedFileName = sanitizeDroppedFileName(deps.fileName)

  // IMP-01: a drop must never overwrite an existing root file. Pick
  // the first free name with the DA-12-11 " (n)" suffix (same shape
  // as getAvailableCopyPath in use-markdown-import), then write with
  // createNew so a file appearing between the check and the write
  // collides instead of being overwritten; on collision, advance to
  // the next suffix.
  const dot = sanitizedFileName.lastIndexOf('.')
  const stem = dot > 0 ? sanitizedFileName.slice(0, dot) : sanitizedFileName
  const ext = dot > 0 ? sanitizedFileName.slice(dot) : ''
  let candidate = sanitizedFileName
  let suffix = 0

  for (;;) {
    const pathOptions = await deps.getFilePathOptions(candidate)
    const options = pathOptions.baseDir ? { baseDir: pathOptions.baseDir } : undefined
    if (deps.exists && await deps.exists(pathOptions.path, options)) {
      suffix += 1
      candidate = `${stem} (${suffix})${ext}`
      continue
    }
    try {
      const writeOptions: WriteFileOptions = { ...(options ?? {}), createNew: true }
      if (payload.kind === 'text') {
        await deps.writeTextFile?.(pathOptions.path, payload.content, writeOptions)
      } else {
        await deps.writeFile?.(pathOptions.path, payload.content, writeOptions)
      }
      debugSyncPath('rootDrop.writeFile', {
        originalFileName: deps.fileName,
        writtenFileName: candidate,
      })
      return candidate
    } catch (error) {
      if (isAlreadyExistsLike(error)) {
        suffix += 1
        candidate = `${stem} (${suffix})${ext}`
        continue
      }
      throw error
    }
  }
}
