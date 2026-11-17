import { platform } from '@/lib/platform'
import type { Proxy } from '@/lib/platform'
import { remoteRecord } from './directory-listing'
import { readSyncResponseJson } from './remote-file'
import { getSyncRepoName } from './repo-utils'
import { withGithubRepoWriteLock } from './github-repo-write-lock'
import { fetchRemoteRead, isRemoteConnectionError, recoverRemoteMutation, RemoteMutationTransportError } from './remote-mutation-recovery'

export interface GitPathEntry {
  sha: string
  type: 'blob' | 'tree'
  mode: '100644' | '100755' | '040000'
}

interface MoveGithubPathResult {
  status: 'moved' | 'missing'
  entry?: GitPathEntry
}

interface MoveGithubPathOptions {
  source: string
  target: string
  expected?: GitPathEntry
  /** Persist the immutable source identity before any remote mutation. */
  rememberSource: (entry: GitPathEntry) => Promise<void>
  /** Check the captured workspace/repository and the pending local move. */
  assertCurrent: () => Promise<boolean>
}

interface GitTreeEntry {
  path: string
  mode: string
  type: string
  sha: string
}

const SHA_PATTERN = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i

class GithubRefUpdateError extends Error {
  constructor(message: string, readonly canCheckConcurrentUpdate: boolean) {
    super(message)
    this.name = 'GithubRefUpdateError'
  }
}

function validPath(path: string): boolean {
  return Boolean(path) && !path.includes('\\') && !/^[a-z]:/i.test(path)
    && path.split('/').every(part => part && !part.startsWith('.'))
}

/** Move immutable remote bytes. Serialize local repository writers and retry a
 * competing external commit only while the original source identity is intact. */
export async function moveGithubPath({
  source, target, expected, rememberSource, assertCurrent,
}: MoveGithubPathOptions): Promise<MoveGithubPathResult> {
  const failure = (stage: string, detail: string) => new Error(
    `GitHub path migration failed (${source} -> ${target}, ${stage}): ${detail}`,
  )
  if (!validPath(source) || !validPath(target) || source === target
    || source.startsWith(`${target}/`) || target.startsWith(`${source}/`)) {
    throw failure('Validate migration record', 'Paths are invalid or nested; remote files were not migrated')
  }
  const current = async (): Promise<void> => {
    if (!await assertCurrent()) throw failure('Validate migration context', 'Workspace or migration state changed; the migration record was kept')
  }
  const pathEntry = (entry: GitTreeEntry | GitPathEntry): GitPathEntry => {
    if (SHA_PATTERN.test(entry.sha)) {
      if (entry.type === 'tree' && entry.mode === '040000') {
        return { sha: entry.sha.toLowerCase(), type: 'tree', mode: '040000' }
      }
      if (entry.type === 'blob' && (entry.mode === '100644' || entry.mode === '100755')) {
        return { sha: entry.sha.toLowerCase(), type: 'blob', mode: entry.mode }
      }
    }
    throw failure('Validate file type', 'Source path is not a regular file or directory; remote files were not migrated')
  }
  let captured = expected === undefined ? undefined : pathEntry(expected)
  const matches = (entry: GitTreeEntry, identity: GitPathEntry): boolean => entry.sha === identity.sha
    && entry.type === identity.type && entry.mode === identity.mode
  const store = await platform.store.load('store.json')
  // All requests in this operation use the same credentials and destination.
  const [token, owner, repo, proxyUrl] = await Promise.all([
    store.get<string>('accessToken'),
    store.get<string>('githubUsername'),
    getSyncRepoName('github'),
    store.get<string>('proxy'),
  ])
  await current()
  if (!token || !owner || !repo) throw failure('Read configuration', 'GitHub sync is not configured')
  const proxy: Proxy | undefined = proxyUrl ? { all: proxyUrl } : undefined
  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  }
  const repositoryIsEmpty = async (): Promise<boolean> => {
    const controller = new AbortController()
    const requestTimeout = setTimeout(() => controller.abort(), 15_000)
    try {
      let response: Response
      try {
        response = await fetchRemoteRead(`${baseUrl}/branches?per_page=1`, {
          method: 'GET', headers, proxy, signal: controller.signal,
        })
      } catch {
        throw failure('Confirm empty repository', 'Network request failed or timed out; the migration record was kept')
      }
      if (!response.ok) throw failure('Confirm empty repository', `Request rejected (HTTP ${response.status})`)
      let branches: unknown
      try { branches = await readSyncResponseJson(response, `github / ${source} / branches`) }
      catch { throw failure('Confirm empty repository', 'Invalid response format or read timeout; the migration record was kept') }
      if (!Array.isArray(branches)) throw failure('Confirm empty repository', 'Invalid branch list format; the migration record was kept')
      return branches.length === 0
    } finally {
      clearTimeout(requestTimeout)
    }
  }

  const request = async (
    resource: string,
    stage: string,
    method: 'GET' | 'POST' | 'PATCH' = 'GET',
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const controller = new AbortController()
    const requestTimeout = setTimeout(() => controller.abort(), 15_000)
    try {
      let response: Response
      try {
        const send = () => platform.http.fetch(`${baseUrl}${resource}`, {
          method, headers: new Headers(headers), proxy, signal: controller.signal,
          maxRedirections: 0, body: body === undefined ? undefined : JSON.stringify(body),
        })
        response = method === 'GET'
          ? await fetchRemoteRead(`${baseUrl}${resource}`, {
            headers: { ...headers, 'Cache-Control': 'no-cache' }, proxy, signal: controller.signal,
          })
          : method === 'POST'
            // Creating unreachable immutable objects cannot advance a branch.
            ? await recoverRemoteMutation({ send, reconcile: async () => ({ state: 'unchanged' }), beforeWrite: current })
            : await send()
      } catch (error) {
        // Native transport errors may include proxy credentials. Keep only our
        // own source/stage context; neither tokens nor raw response bodies escape.
        const message = failure(stage, 'Network request failed or timed out; the migration record was kept').message
        if (method === 'PATCH' && (controller.signal.aborted || isRemoteConnectionError(error))) {
          throw new RemoteMutationTransportError(message)
        }
        throw new Error(message)
      }
      if (!response.ok) {
        if (method === 'GET' && resource.startsWith('/git/ref/')
          && [404, 409].includes(response.status) && await repositoryIsEmpty()) return { empty: true }
        if (method === 'PATCH' && [401, 403, 409, 412, 422, 429].includes(response.status)) {
          let reason = ''
          try {
            const rejection = remoteRecord(await readSyncResponseJson(response, `github / ${source} / ${stage}`))
            const messages: string[] = typeof rejection.message === 'string' ? [rejection.message] : []
            if (Array.isArray(rejection.errors)) {
              for (const item of rejection.errors as unknown[]) {
                if (typeof item === 'string') messages.push(item)
                else if (item && typeof item === 'object' && 'message' in item && typeof item.message === 'string') {
                  messages.push(item.message)
                }
              }
            }
            reason = messages.join(' ').toLowerCase()
          } catch { /* Preserve the HTTP error even if its body is unreadable. */ }
          const protectedBranch = /protected branch|branch protection|repository rule|rule violation|signed commit|required status check|pull request|gh006|gh013/.test(reason)
          const limited = /rate limit|abuse|spam/.test(reason) || response.status === 429
          const permission = /permission|not permitted|not allowed|resource not accessible|workflow scope|refusing to allow|bad credentials/.test(reason)
            || response.status === 401 || (response.status === 403 && !limited && !protectedBranch)
          const concurrent = /not a fast.?forward|reference update failed|reference has changed/.test(reason)
          const detail = protectedBranch ? 'Remote branch protection or repository rules rejected the update'
            : limited ? 'GitHub requests are rate-limited; please try again later'
              : permission ? 'GitHub token permissions are insufficient; cannot update the remote branch'
                : concurrent ? 'Remote branch was updated by another sync; the migration task was kept'
                  : 'GitHub refused to update the branch reference; the migration task was kept'
          throw new GithubRefUpdateError(failure(stage, `${detail}（HTTP ${response.status}）`).message,
            [409, 412, 422].includes(response.status) && !protectedBranch && !permission && !limited)
        }
        throw failure(stage, `Request rejected (HTTP ${response.status}); the migration record was kept`)
      }
      try {
        return remoteRecord(await readSyncResponseJson(response, `github / ${source} / ${stage}`))
      } catch {
        throw failure(stage, 'Invalid response format or read timeout; the migration record was kept')
      }
    } finally {
      clearTimeout(requestTimeout)
    }
  }
  const readSha = (value: unknown, stage: string): string => {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
      throw failure(stage, 'Invalid Git object version; old files were kept')
    }
    return value.toLowerCase()
  }
  const readObject = (value: unknown, stage: string): Record<string, unknown> => {
    try { return remoteRecord(value) }
    catch { throw failure(stage, 'Invalid Git object format; old files were kept') }
  }

  return withGithubRepoWriteLock(owner, repo, async (): Promise<MoveGithubPathResult> => {
    await current()
    const repository = await request('', 'Read default branch')
    if (typeof repository.default_branch !== 'string' || !repository.default_branch) {
      if (await repositoryIsEmpty()) {
        await current()
        if (captured) throw failure('Verify migration result', 'Remote branch from the recorded migration snapshot does not exist; the migration record was kept')
        return { status: 'missing' }
      }
      throw failure('Read default branch', 'Repository has no valid default branch; old files were kept')
    }
    const branch = repository.default_branch
    const reference = `refs/heads/${branch}`
    const refResource = `/git/refs/heads/${encodeURIComponent(branch)}`
    const attemptMove = async (attempt: number, verifyOnly = false): Promise<MoveGithubPathResult> => {
      const head = await request(`/git/ref/heads/${encodeURIComponent(branch)}`, 'Read branch version')
      if (head.empty === true) {
        await current()
        if (captured) throw failure('Verify migration result', 'Remote branch from the recorded migration snapshot does not exist; the migration record was kept')
        return { status: 'missing' }
      }
      const headObject = readObject(head.object, 'Read branch version')
      if (head.ref !== reference || headObject.type !== 'commit') {
        throw failure('Read branch version', 'Default branch does not point to a commit; old files were kept')
      }
      const parent = readSha(headObject.sha, 'Read branch version')
      const commit = await request(`/git/commits/${parent}`, 'Read commit snapshot')
      if (readSha(commit.sha, 'Read commit snapshot') !== parent) {
        throw failure('Read commit snapshot', 'Commit version mismatch; old files were kept')
      }
      const baseTree = readSha(readObject(commit.tree, 'Read commit snapshot').sha, 'Read commit snapshot')
      const trees = new Map<string, Promise<GitTreeEntry[]>>()
      const readTree = (treeSha: string): Promise<GitTreeEntry[]> => {
        const cached = trees.get(treeSha)
        if (cached) return cached
        const pending = (async () => {
          // Read each immutable directory separately: never accept a truncated
          // recursive tree as evidence that a file is missing.
          const data = await request(`/git/trees/${treeSha}`, 'Read directory snapshot')
          if (readSha(data.sha, 'Read directory snapshot') !== treeSha
            || data.truncated !== false || !Array.isArray(data.tree)) {
            throw failure('Read directory snapshot', 'Incomplete directory snapshot; old files were kept')
          }
          const seen = new Set<string>()
          return data.tree.map((value: unknown) => {
            const entry = readObject(value, 'Read directory snapshot')
            if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('/')
              || entry.path === '.' || entry.path === '..' || seen.has(entry.path)
              || typeof entry.mode !== 'string' || typeof entry.type !== 'string') {
              throw failure('Read directory snapshot', 'Invalid directory entry; old files were kept')
            }
            seen.add(entry.path)
            return {
              path: entry.path, mode: entry.mode, type: entry.type,
              sha: readSha(entry.sha, 'Read directory snapshot'),
            }
          })
        })()
        trees.set(treeSha, pending)
        return pending
      }
      const findEntry = async (path: string): Promise<GitTreeEntry | null> => {
        let treeSha = baseTree
        const segments = path.split('/')
        for (let depth = 0; depth < segments.length; depth += 1) {
          const entries = await readTree(treeSha)
          const entry = entries.find(candidate => candidate.path === segments[depth])
          if (!entry) return null
          if (depth === segments.length - 1) return entry
          if (entry.type !== 'tree' || entry.mode !== '040000') {
            throw failure('Validate parent directory', `Path passes through a non-directory object; old files were kept: ${path}`)
          }
          treeSha = entry.sha
        }
        return null
      }

      const sourceEntry = await findEntry(source)
      const targetEntry = await findEntry(target)
      await current()
      if (!sourceEntry) {
        // A lost ref-update response is recoverable only from the identity saved
        // before that write. An arbitrary existing target never proves completion.
        if (targetEntry && captured && matches(targetEntry, captured)) {
          return { status: 'moved', entry: captured }
        }
        if (targetEntry) throw failure('Validate target path', 'Source path does not exist but the target already exists; cannot confirm the previous migration result')
        if (captured) throw failure('Verify migration result', 'Both recorded remote source and target are missing; cannot confirm the migration result')
        return { status: 'missing' }
      }
      const entry = pathEntry(sourceEntry)
      if (captured && !matches(sourceEntry, captured)) {
        throw failure('Validate source path', 'Remote source file or directory changed since the last attempt; the migration record was kept')
      }
      if (targetEntry) throw failure('Validate target path', 'Remote target path already exists; existing content was kept')
      if (verifyOnly) throw failure('Confirm migration result', 'Safe retry limit reached; the migration record was kept')
      await rememberSource(entry)
      // Keep the first identity across retries, including a first attempt without
      // a pre-existing journal snapshot. Unrelated commits may change; these bytes may not.
      captured = entry
      await current()
      const newTree = await request('/git/trees', 'Create migration tree', 'POST', {
        base_tree: baseTree,
        tree: [
          { path: target, mode: entry.mode, type: entry.type, sha: entry.sha },
          { path: source, mode: entry.mode, type: entry.type, sha: null },
        ],
      })
      const newTreeSha = readSha(newTree.sha, 'Create migration tree')
      await current()
      const newCommit = await request('/git/commits', 'Create migration commit', 'POST', {
        message: `Move ${source} to ${target}`,
        tree: newTreeSha,
        parents: [parent],
      })
      const newCommitSha = readSha(newCommit.sha, 'Create migration commit')
      // If a competing writer advanced the branch, this commit is not a descendant
      // of its new head. GitHub rejects the non-fast-forward update atomically.
      await current()
      const latestRepository = await request('', 'Validate default branch')
      if (latestRepository.default_branch !== branch) throw failure('Validate default branch', 'Default branch changed; the migration record was kept')
      let updated: Record<string, unknown>
      try {
        updated = await request(refResource, 'Apply migration commit', 'PATCH', {
          sha: newCommitSha, force: false,
        })
      } catch (error) {
        if (error instanceof RemoteMutationTransportError) {
          await current()
          const repository = await request('', 'Confirm default branch after disconnect')
          if (repository.default_branch !== branch) throw failure('Validate default branch', 'Default branch changed; the migration record was kept')
          // Re-read the immutable tree even after the final failed PATCH.
          // Source absence plus the saved target identity confirms completion.
          return attemptMove(attempt + 1, attempt >= 2)
        }
        if (error instanceof GithubRefUpdateError && error.canCheckConcurrentUpdate && attempt < 2) {
          await current()
          const latestHead = await request(`/git/ref/heads/${encodeURIComponent(branch)}`, 'Confirm concurrent branch update')
          if (latestHead.ref === reference) {
            const latestObject = readObject(latestHead.object, 'Confirm concurrent branch update')
            if (latestObject.type === 'commit' && readSha(latestObject.sha, 'Confirm concurrent branch update') !== parent) {
              // Re-read the new immutable tree and verify source/target again.
              // An unchanged head means rejection, not a reason to retry blindly.
              return attemptMove(attempt + 1)
            }
          }
        }
        throw error
      }
      const updatedObject = readObject(updated.object, 'Apply migration commit')
      if (updated.ref !== reference || updatedObject.type !== 'commit'
        || readSha(updatedObject.sha, 'Apply migration commit') !== newCommitSha) {
        throw failure('Apply migration commit', 'Cannot confirm the branch update result; the migration record was kept')
      }
      return { status: 'moved', entry }
    }
    return attemptMove(0)
  })
}
