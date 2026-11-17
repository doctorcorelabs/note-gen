import type { Proxy } from '@/lib/platform'
import { platform } from '@/lib/platform'
import { remoteRecord } from './directory-listing'
import { readSyncResponseJson } from './remote-file'
import { withGitRepoWriteLock } from './git-repo-write-lock'
import { isSyncStaleError } from './sync-stale-error'
import { fetchRemoteRead, isRemoteConnectionError, RemoteMutationTransportError } from './remote-mutation-recovery'
import {
  assertReceivePackStatus, createGitObject, encodeGitPack, encodeGitTree,
  encodeReceivePackRequest, parseReceivePackAdvertisement, type GitObject, type GitTreeEntry,
} from './git-http'
import type { GitPlatformPathSnapshot } from './git-platform-path-move'

interface Options {
  source: string
  target: string
  username: string
  repo: string
  token: string
  configuredBranch: string
  proxy?: Proxy
  expected?: GitPlatformPathSnapshot
  rememberSource: (snapshot: GitPlatformPathSnapshot) => Promise<void>
  assertCurrent: () => Promise<boolean>
}
const oidPattern = /^[a-f0-9]{40}$/

/** Reuse the smart HTTP transport already used for Gitee's empty-file uploads.
 * Moving an existing blob/tree only creates ancestor trees and one commit; the
 * receive-pack old ref is a compare-and-swap over the entire remote operation. */
export async function moveGiteePath(options: Options): Promise<{
  status: 'moved' | 'missing'; files?: Array<{ path: string; version: string }>
}> {
  return withGitRepoWriteLock('https://gitee.com/api/v5', `${options.username}/${options.repo}`,
    () => performGiteePathMove(options))
}

async function performGiteePathMove(options: Options, attempt = 0, verifyOnly = false): Promise<{
  status: 'moved' | 'missing'; files?: Array<{ path: string; version: string }>
}> {
  const { source, target, username, repo, token, configuredBranch, proxy, expected, rememberSource, assertCurrent } = options
  const failure = (stage: string, detail: string) => new Error(`Gitee path migration failed (${source} -> ${target}, ${stage}): ${detail}`)
  const current = async () => {
    if (!await assertCurrent()) throw failure('Validate context', 'Workspace, platform, or migration state changed; the record was kept')
  }
  const repositoryPath = `${encodeURIComponent(username)}/${encodeURIComponent(repo)}`
  const apiBase = 'https://gitee.com/api/v5'
  const resourceBase = `/repos/${repositoryPath}`
  const gitBase = `https://gitee.com/${repositoryPath}.git`
  const authorization = `Basic ${Buffer.from(`${username}:${token}`, 'utf-8').toString('base64')}`
  const readApiValue = async (resource: string): Promise<unknown> => {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      let response: Response
      try {
        response = await fetchRemoteRead(`${apiBase}${resource}`, {
          headers: { Authorization: `Bearer ${token}` }, proxy, signal: controller.signal, maxRedirections: 0,
        })
      } catch { throw failure('Read remote snapshot', 'Network request failed or timed out; the migration record was kept') }
      if (!response.ok) throw failure('Read remote snapshot', `Request rejected (HTTP ${response.status}); the record was kept`)
      try { return await readSyncResponseJson(response, `gitee / ${source} / path move`) }
      catch { throw failure('Read remote snapshot', 'Invalid response format; the record was kept') }
    } finally { clearTimeout(timeout) }
  }
  const readApi = async (resource: string) => remoteRecord(await readApiValue(resource))
  const bytes = async (response: Response): Promise<Uint8Array> => {
    const limit = 32 * 1024 * 1024
    if (Number(response.headers.get('content-length')) > limit) throw failure('Read Git response', 'Response body too large')
    const reader = response.body?.getReader()
    if (!reader) throw failure('Read Git response', 'Response has no body')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        length += chunk.value.length
        if (length > limit) {
          await reader.cancel()
          throw failure('Read Git response', 'Response body too large')
        }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result
  }
  const gitRequest = async (resource: string, body?: Uint8Array): Promise<Uint8Array> => {
    const type = body ? 'application/x-git-receive-pack-result' : 'application/x-git-receive-pack-advertisement'
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)
    try {
      let response: Response
      try {
        const requestHeaders: Record<string, string> = { Authorization: authorization, Accept: type }
        if (body) requestHeaders['Content-Type'] = 'application/x-git-receive-pack-request'
        const requestOptions = {
          proxy, maxRedirections: 0, signal: controller.signal,
          headers: requestHeaders,
        }
        response = body
          ? await platform.http.fetch(`${gitBase}${resource}`, { ...requestOptions, method: 'POST', body: Uint8Array.from(body).buffer })
          : await fetchRemoteRead(`${gitBase}${resource}`, requestOptions)
      } catch (error) {
        const message = failure('Submit Git rename', 'Network request failed or timed out; result pending confirmation, migration record kept').message
        if (body && (controller.signal.aborted || isRemoteConnectionError(error))) throw new RemoteMutationTransportError(message)
        throw new Error(message)
      }
      if (!response.ok || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== type) {
        throw failure('Read Git response', `Server rejected the Git protocol request (HTTP ${response.status}); the record was kept`)
      }
      try { return await bytes(response) }
      catch (error) {
        if (body && (controller.signal.aborted || isRemoteConnectionError(error))) {
          throw new RemoteMutationTransportError(failure('Read Git response', 'Response interrupted; result pending confirmation, migration record kept').message)
        }
        throw error
      }
    } finally { clearTimeout(timeout) }
  }
  const oid = (value: unknown): string => {
    if (typeof value !== 'string' || !oidPattern.test(value)) throw failure('Validate Git object', 'Invalid object version')
    return value
  }
  const repository = await readApi(resourceBase)
  let advertisement
  try { advertisement = parseReceivePackAdvertisement(await gitRequest('/info/refs?service=git-receive-pack')) }
  catch { throw failure('Read Git branch', 'Invalid Git branch response or read failure; the record was kept') }
  if (typeof repository.default_branch !== 'string' || !repository.default_branch) {
    if (!expected && advertisement.refs.size === 0) {
      const branches = await readApiValue(`${resourceBase}/branches`)
      if (Array.isArray(branches) && branches.length === 0) {
        await current()
        return { status: 'missing' }
      }
    }
    throw failure('Read default branch', 'Repository has no valid default branch; the record was kept')
  }
  const defaultBranch = repository.default_branch
  const branch = configuredBranch || defaultBranch
  if (expected && expected.branch !== branch) throw failure('Validate default branch', 'Default branch changed, record kept')
  const ref = `refs/heads/${branch}`
  if (!advertisement.capabilities.has('report-status')) throw failure('Read Git branch', 'Server does not support confirming the commit result')
  const head = advertisement.refs.get(ref)
  if (!head) {
    if (advertisement.refs.size === 0 && !expected) return { status: 'missing' }
    throw failure('Read Git branch', 'Remote branch does not exist; the record was kept')
  }
  const commit = await readApi(`${resourceBase}/commits/${oid(head)}`)
  if (commit.sha !== head) throw failure('Read commit snapshot', 'Commit version mismatch')
  let root = oid(remoteRecord(remoteRecord(commit.commit).tree).sha)
  const trees = new Map<string, GitTreeEntry[]>()
  const readTree = async (sha: string): Promise<GitTreeEntry[]> => {
    const cached = trees.get(sha)
    if (cached) return cached
    const data = await readApi(`${resourceBase}/git/trees/${sha}`)
    if (data.truncated !== false || !Array.isArray(data.tree)) throw failure('Read directory snapshot', 'Incomplete directory snapshot')
    const entries = data.tree.map(value => {
      const entry = remoteRecord(value)
      if (typeof entry.path !== 'string' || typeof entry.mode !== 'string') throw failure('Read directory snapshot', 'Invalid directory entry')
      const mode = entry.mode.replace(/^0+/, '')
      const type = mode === '40000' ? 'tree' : mode === '160000' ? 'commit' : 'blob'
      if (entry.type !== type) throw failure('Read directory snapshot', 'File mode does not match its type')
      return { name: entry.path, oid: oid(entry.sha), mode }
    })
    // Gitee sometimes echoes the requested commit in tree.sha. Reconstruct the
    // actual immutable Git tree instead of trusting that response field.
    let actual: string
    try { actual = (await createGitObject('tree', encodeGitTree(entries))).oid }
    catch { throw failure('Validate directory snapshot', 'Invalid directory entries or modes') }
    if (actual !== sha) throw failure('Validate directory snapshot', 'Directory contents do not match the Git version')
    trees.set(sha, entries)
    return entries
  }
  const find = async (path: string): Promise<GitTreeEntry | null> => {
    let tree = root
    const segments = path.split('/')
    for (let depth = 0; depth < segments.length; depth += 1) {
      const entry = (await readTree(tree)).find(candidate => candidate.name === segments[depth])
      if (!entry) return null
      if (depth === segments.length - 1) return entry
      if (entry.mode !== '40000') throw failure('Validate parent directory', 'Parent path is not a directory')
      tree = entry.oid
    }
    return null
  }
  const sourceEntry = await find(source)
  const targetEntry = await find(target)
  const matches = (entry: GitTreeEntry, identity: GitPlatformPathSnapshot['root']) => entry.oid === identity.sha
    && (entry.mode === '40000' ? '040000' : entry.mode) === identity.mode
  const fileList = async (entry: GitTreeEntry): Promise<GitPlatformPathSnapshot['files']> => {
    const files: GitPlatformPathSnapshot['files'] = []
    const collect = async (child: GitTreeEntry, path: string): Promise<void> => {
      if (child.mode === '40000') {
        for (const nested of await readTree(child.oid)) await collect(nested, path ? `${path}/${nested.name}` : nested.name)
      } else if (child.mode === '100644' || child.mode === '100755') files.push({ path, sha: child.oid, mode: child.mode })
      // Linked entries and submodules remain untouched inside the moved tree.
    }
    await collect(entry, '')
    return files
  }
  const verifyFiles = async (entry: GitTreeEntry, identity: GitPlatformPathSnapshot): Promise<void> => {
    const files = await fileList(entry)
    if (files.length !== identity.files.length || files.some(file => !identity.files.some(saved =>
      saved.path === file.path && saved.sha === file.sha && saved.mode === file.mode))) {
      throw failure('Validate migration manifest', 'Persisted file manifest does not match the immutable directory snapshot; the record was kept')
    }
  }
  await current()
  if (!sourceEntry) {
    if (targetEntry && expected && matches(targetEntry, expected.root)) {
      await verifyFiles(targetEntry, expected)
      await current()
      return { status: 'moved', files: expected.files.map(file => ({ path: file.path ? `${target}/${file.path}` : target, version: file.sha })) }
    }
    if (!targetEntry && !expected) return { status: 'missing' }
    throw failure('Verify migration result', 'Source path missing and target cannot be confirmed as part of the previous migration; the record was kept')
  }
  if (!['40000', '100644', '100755'].includes(sourceEntry.mode)) throw failure('Validate source path', 'Source path is not a regular file or directory')
  if (targetEntry) throw failure('Validate target path', 'Remote target already exists; original content was kept')
  if (expected && !matches(sourceEntry, expected.root)) throw failure('Validate source version', 'Remote source content changed; the record was kept')
  if (expected) await verifyFiles(sourceEntry, expected)
  if (verifyOnly) throw failure('Confirm migration result', 'Safe retry limit reached; the migration record was kept')
  let snapshot = expected
  if (!snapshot) {
    const files = await fileList(sourceEntry)
    if (files.length === 0) throw failure('Read source directory', 'Source directory has no migratable regular files')
    snapshot = { provider: 'gitee', branch, root: {
      sha: sourceEntry.oid, type: sourceEntry.mode === '40000' ? 'tree' : 'blob',
      mode: sourceEntry.mode === '40000' ? '040000' : sourceEntry.mode as '100644' | '100755',
    }, files }
    await rememberSource(snapshot)
  }
  const objects = new Map<string, GitObject>()
  const patchTree = async (tree: string | undefined, parts: string[], replacement: GitTreeEntry | null, top = true): Promise<string | undefined> => {
    const entries = tree ? [...await readTree(tree)] : []
    const name = parts[0]
    const index = entries.findIndex(entry => entry.name === name)
    if (parts.length === 1) {
      if (index >= 0) entries.splice(index, 1)
      if (replacement) entries.push({ ...replacement, name })
    } else {
      const existing = index >= 0 ? entries[index] : undefined
      if (existing && existing.mode !== '40000') throw failure('Generate directory', 'Parent path is not a directory')
      const child = await patchTree(existing?.oid, parts.slice(1), replacement, false)
      if (index >= 0) entries.splice(index, 1)
      if (child) entries.push({ name, mode: '40000', oid: child })
    }
    if (!entries.length && !top) return undefined
    const object = await createGitObject('tree', encodeGitTree(entries))
    objects.set(object.oid, object)
    trees.set(object.oid, entries)
    return object.oid
  }
  root = (await patchTree(root, source.split('/'), null))!
  root = (await patchTree(root, target.split('/'), sourceEntry))!
  const user = await readApi('/user')
  if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id <= 0
    || typeof user.login !== 'string' || !user.login || /[\s<>@\0]/.test(user.login)) throw failure('Read commit identity', 'Invalid user identity')
  const name = (typeof user.name === 'string' ? user.name : user.login).replace(/[<>\r\n\0]/g, '').trim() || user.login
  const author = `${name} <${user.id}+${user.login}@user.noreply.gitee.com>`
  const timestamp = Math.floor(Date.now() / 1000)
  const newCommit = await createGitObject('commit', new TextEncoder().encode([
    `tree ${root}`, `parent ${head}`, `author ${author} ${timestamp} +0000`, `committer ${author} ${timestamp} +0000`,
    '', `Move ${source} to ${target}`, '',
  ].join('\n')))
  objects.set(newCommit.oid, newCommit)
  const pack = await encodeGitPack([...objects.values()])
  const request = encodeReceivePackRequest(head, newCommit.oid, ref, pack, advertisement.capabilities)
  if ((await readApi(resourceBase)).default_branch !== defaultBranch) throw failure('Validate default branch', 'Default branch changed, record kept')
  await current()
  let report: Uint8Array
  try { report = await gitRequest('/git-receive-pack', request) }
  catch (error) {
    if (!(error instanceof RemoteMutationTransportError)) throw error
    await current()
    return performGiteePathMove({ ...options, expected: snapshot }, attempt + 1, attempt >= 2)
  }
  try { assertReceivePackStatus(report, ref, head, `${source} → ${target}`) }
  catch (error) {
    const reason = error instanceof Error ? error.message : ''
    const canCheckHead = isSyncStaleError(error) || ['failed to update ref', 'failed to update refs', 'failed to update ref(s)']
      .some(message => reason === `Git rejected ${ref}: ${message}`)
    let headChanged = false
    if (canCheckHead && attempt < 2) {
      try {
        const latest = parseReceivePackAdvertisement(await gitRequest('/info/refs?service=git-receive-pack'))
        headChanged = latest.refs.has(ref) && latest.refs.get(ref) !== head
      } catch { /* Preserve the original rejection if discovery fails. */ }
    }
    if (headChanged) {
      await current()
      // Stay inside the already-held repository lock. Freeze the first source
      // snapshot across retries; never adopt a new blob/tree or overwrite a target.
      return performGiteePathMove({ ...options, expected: snapshot }, attempt + 1)
    }
    throw failure('Submit remote rename', 'Git branch changed or the server rejected the commit; remote original files and the record were kept')
  }
  await current()
  return { status: 'moved', files: snapshot.files.map(file => ({ path: file.path ? `${target}/${file.path}` : target, version: file.sha })) }
}
