import { platform } from '@/lib/platform'
import type { CloudFolderConfig, S3Config, SyncPlatform, WebDAVConfig } from '@/types/sync'
import { getWorkspacePath } from '@/lib/workspace'
import { supportsCloudFolderWorkspace } from './cloud-folder'
import { getOptionalSyncRepoName } from './repo-utils'

export type PathMoveProvider = Exclude<SyncPlatform, 'local'>
export interface PathMoveConfiguration {
  provider: PathMoveProvider
  identity: string
  repo: string
  owner?: string
}

function endpointIdentity(raw: string): string {
  const url = new URL(raw.trim().replace(/\/+$/, ''))
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('The sync server address must not contain credentials or query parameters.')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

/** Passwords, access tokens and signed URLs must never enter a move journal. */
export function getWebDAVPathMoveIdentity(config: WebDAVConfig): string {
  const url = new URL(config.url.trim().replace(/\/+$/, ''))
  if (url.hostname === 'dav.jianguoyun.com' && (!url.pathname || url.pathname === '/')) url.pathname = '/dav'
  return JSON.stringify([
    endpointIdentity(url.toString()), config.username,
    config.pathPrefix ? config.pathPrefix.trim().replace(/^\/+|\/+$/g, '') : '',
  ])
}

export function getS3PathMoveIdentity(config: S3Config): string {
  return JSON.stringify([
    endpointIdentity(config.endpoint || `https://s3.${config.region}.amazonaws.com`),
    config.region, config.bucket, config.pathPrefix.trim().replace(/^\/+|\/+$/g, ''), config.accessKeyId,
  ])
}

export function getCloudFolderPathMoveIdentity(config: CloudFolderConfig): string {
  return JSON.stringify([
    config.provider || 'folder', config.path, config.oneDriveClientId || '', config.oneDriveRootId || '',
    config.oneDriveWorkspacePath || '',
  ])
}

/** Folder/iCloud workspaces already use the actual OS-managed sync directory.
 * All remote/cache-backed providers use the same durable rename queue. */
export async function getPathMoveConfiguration(): Promise<PathMoveConfiguration | null> {
  const store = await platform.store.load('store.json')
  const provider = await store.get<SyncPlatform>('primaryBackupMethod') || 'github'
  if (provider === 'local') return null
  if (provider === 'github') {
    const owner = await store.get<string>('githubUsername')
    const repo = await getOptionalSyncRepoName(provider)
    return owner && repo ? { provider, owner, repo, identity: JSON.stringify([owner, repo]) } : null
  }
  if (provider === 'gitee' || provider === 'gitlab' || provider === 'gitea') {
    const { getGitPlatformMoveIdentity } = await import('./git-platform-path-move')
    const identity = await getGitPlatformMoveIdentity(provider)
    const repo = await getOptionalSyncRepoName(provider)
    return identity && repo ? { provider, identity, repo } : null
  }
  if (provider === 'webdav') {
    const config = await store.get<WebDAVConfig>('webdavSyncConfig')
    return config?.url && config.username && config.password
      ? { provider, identity: getWebDAVPathMoveIdentity(config), repo: '' } : null
  }
  if (provider === 's3') {
    const config = await store.get<S3Config>('s3SyncConfig')
    return config?.bucket && config.region && config.accessKeyId && config.secretAccessKey
      ? { provider, identity: getS3PathMoveIdentity(config), repo: '' } : null
  }
  if (provider === 'cloudFolder') {
    const config = await store.get<CloudFolderConfig>('cloudFolderSyncConfig')
    if (!config?.path) return null
    if (!supportsCloudFolderWorkspace(config)) {
      const workspace = await getWorkspacePath()
      const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '')
      if (!workspace.isCustom || normalize(workspace.path) !== normalize(config.path)) {
        throw new Error('The cloud sync folder does not match the current workspace. Please finish switching workspaces first.')
      }
      return null // The local rename itself is propagated by iCloud/the OS.
    }
    return { provider, identity: getCloudFolderPathMoveIdentity(config), repo: config.path }
  }
  if (provider === 'selfHosted') {
    const { getSelfHostedPathMoveIdentity } = await import('@/lib/self-hosted-sync/path-move')
    const identity = await getSelfHostedPathMoveIdentity()
    return identity ? { provider, identity, repo: '' } : null
  }
  return null
}
