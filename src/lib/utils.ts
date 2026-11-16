import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"
import { isTauri, platform } from "@/lib/platform";
import { getWorkspacePath } from "./workspace";
import { toWorkspaceMediaRelativePath } from "./markdown-image-path";

const RESOLVED_IMAGE_SRC_RE = /^(?:https?:|data:|blob:|asset:|tauri:|file:)/i
const WORKSPACE_MEDIA_URL_RE = /^\/api\/workspace\/media(?:\/|$)/
const HTTP_URL_RE = /^https?:\/\//i
let appDataDirPromise: Promise<string> | null = null
const convertedImageSrcCache = new Map<string, string>()
const convertedWorkspaceImageSrcCache = new Map<string, string>()

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function isHttpUrl(url?: string | null) {
  return HTTP_URL_RE.test(url ?? '')
}

function normalizeAppDataAssetPath(path: string) {
  return path.startsWith('/') ? path : `/${path}`
}

function getCachedAppDataDir() {
  appDataDirPromise ||= platform.path.appDataDir()
  return appDataDirPromise
}

function isAlreadyResolvedImageSrc(path: string) {
  return RESOLVED_IMAGE_SRC_RE.test(path) || WORKSPACE_MEDIA_URL_RE.test(path)
}

export async function convertImage(path: string) {
  if (isAlreadyResolvedImageSrc(path)) {
    return path
  }

  const normalizedPath = normalizeAppDataAssetPath(path)
  const cachedSrc = convertedImageSrcCache.get(normalizedPath)
  if (cachedSrc) {
    return cachedSrc
  }

  let src: string
  if (!isTauri()) {
    // Web mode has no app-data directory. Treat the app-data-relative
    // path as a workspace-relative media path so editor images that
    // live in the workspace resolve through the authenticated media
    // endpoint. Record assets served by the record-asset endpoint
    // (V3-31/V3-32) are not rerouted here; they keep their own
    // resolver and a media 404 stays visible instead of throwing.
    src = platform.assetUrl.convertFileSrc(
      toWorkspaceMediaRelativePath(normalizedPath, false),
    )
  } else {
    const appDataDirPath = await getCachedAppDataDir()
    const imagePath = appDataDirPath + normalizedPath
    src = platform.assetUrl.convertFileSrc(imagePath)
  }
  convertedImageSrcCache.set(normalizedPath, src)
  return src
}

export async function convertImageByWorkspace(path: string) {
  if (isAlreadyResolvedImageSrc(path)) {
    return path
  }

  const workspace = await getWorkspacePath()
  const cacheKey = `${workspace.isCustom ? workspace.path : 'app-data'}:${path}`
  const cachedSrc = convertedWorkspaceImageSrcCache.get(cacheKey)
  if (cachedSrc) {
    return cachedSrc
  }

  let src: string
  if (!isTauri()) {
    // Web mode: the asset adapter only accepts workspace-relative
    // paths and builds an authenticated `/api/workspace/media/...`
    // URL from them. Joining the workspace root or the virtual
    // app-data prefix here made the adapter reject every workspace
    // image, so the relative path is passed through unchanged apart
    // from the lexical cleanup in toWorkspaceMediaRelativePath.
    src = platform.assetUrl.convertFileSrc(
      toWorkspaceMediaRelativePath(path, workspace.isCustom),
    )
  } else {
    let fullPath: string
    if (workspace.isCustom) {
      fullPath = `${workspace.path}/${path}`
    } else {
      fullPath = `${await getCachedAppDataDir()}/article/${path}`
    }
    src = platform.assetUrl.convertFileSrc(fullPath)
  }
  convertedWorkspaceImageSrcCache.set(cacheKey, src)
  return src
}

export function convertBytesToSize(bytes: number) {
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  if (bytes === 0) {
    return '0 Bytes';
  }
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return Math.round(bytes / Math.pow(1024, i)) + ' ' + sizes[i];
}

export function arrayBuffer2String(buffer: ArrayBuffer) {
  const decoder = new TextDecoder('iso-8859-1');
  return decoder.decode(buffer);
}

export function scrollToBottom() {
  const md = document.querySelector('#chats-wrapper')
  if (md) {
    // 使用 requestAnimationFrame 确保在下一帧渲染后滚动
    requestAnimationFrame(() => {
      // 再使用 setTimeout 确保复杂内容（如代码块）已完全渲染
      setTimeout(() => {
        md.scroll(0, md.scrollHeight)
      }, 0)
    })
  }
}
