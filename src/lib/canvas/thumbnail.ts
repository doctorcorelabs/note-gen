import { platform } from '@/lib/platform'
import type { CanvasDocument } from '@/types/canvas'
import { canvasDocumentToPngFile } from './static-export'

export const CANVAS_THUMBNAIL_VERSION = 4

export async function generateCanvasThumbnail(canvasId: string, document: CanvasDocument) {
  const directory = await platform.path.join(await platform.path.appDataDir(), 'canvas-thumbnails')
  await platform.fs.mkdir(directory, { recursive: true })
  const fileName = `${canvasId}-v${CANVAS_THUMBNAIL_VERSION}.png`
  const path = await platform.path.join(directory, fileName)
  const file = await canvasDocumentToPngFile(document, fileName, {
    maxDimension: 480,
    scale: 1,
  })
  await platform.fs.writeFile(path, new Uint8Array(await file.arrayBuffer()))
  return path
}

export async function removeCanvasThumbnail(path?: string | null) {
  if (!path || !await platform.fs.exists(path)) return
  await platform.fs.remove(path)
}
