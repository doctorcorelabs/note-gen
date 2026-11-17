import { executeRecordTransaction, getDb, type RecordStatement } from './index'
import { platform } from '@/lib/platform'
import { ensureWorkspaceDirectory, managedWorkspaceLocation, normalizeManagedWorkspacePath, resolveManagedWorkspacePath } from '@/lib/managed-workspace'

async function preservePendingWorkspaceFiles(workspaceId: string, sourceRoot: string, targetRoot: string) {
  const pending = await (await getDb()).select<Array<{ path: string; domain: string }>>(
    `select local_key as path, domain from self_hosted_local_changes
     where id in (
       select max(id) from self_hosted_local_changes
       where workspace_id = $1 and state = 'pending' and domain in ('file', 'asset', 'folder')
       group by domain, local_key
     ) and operation = 'upsert'`, [workspaceId],
  )
  if (!pending.length) return
  await ensureWorkspaceDirectory(sourceRoot)
  await ensureWorkspaceDirectory(targetRoot)
  for (const change of pending) {
    const portable = await platform.invoke.invoke<{ normalized: string }>('self_hosted_portable_path', { relativePath: change.path })
    let source = sourceRoot
    let missing = false
    for (const segment of portable.normalized.split('/')) {
      source = await platform.path.join(source, segment)
      if (!await platform.fs.exists(source)) { missing = true; break }
      if ((await platform.fs.lstat(source)).isSymlink) throw new Error('Symbolic-link workspace files are not synchronized')
    }
    if (missing) continue
    const segments = portable.normalized.split('/')
    const target = await platform.path.join(targetRoot, ...segments)
    if (change.domain === 'folder') await platform.fs.mkdir(target, { recursive: true })
    else {
      await platform.fs.mkdir(await platform.path.join(targetRoot, ...segments.slice(0, -1)), { recursive: true })
      await platform.fs.copyFile(source, target)
    }
  }
}

/** Rebase device-local paths together, including collisions left by older iOS containers. */
export async function restoreSelfHostedWorkspaceRoots() {
  const database = await getDb()
  const rows = await database.select<Array<{
    workspaceId: string; localRoot: string; bindingState: string; profileState: string
  }>>(
    `select b.workspace_id as workspaceId, b.local_root as localRoot,
       b.binding_state as bindingState, p.state as profileState
     from self_hosted_workspace_bindings b
     join self_hosted_sync_profiles p on p.id = b.profile_id
     where b.workspace_type = 'library' and b.local_root is not null
     order by b.created_at`,
  )
  const plans = await Promise.all(rows.map(async row => {
    const location = await managedWorkspaceLocation(row.localRoot)
    const root = await resolveManagedWorkspacePath(row.localRoot)
    const active = row.profileState === 'connected'
      && ['bound', 'bootstrapping', 'epoch-changed'].includes(row.bindingState)
    const leaf = location?.split('/').at(-1) ?? ''
    const suffix = leaf.match(/--([a-f0-9]{8}(?:[a-f0-9]{4}){0,6})$/i)?.[1]
    const ownsDirectory = leaf.toLowerCase() === row.workspaceId.toLowerCase()
      || Boolean(suffix && row.workspaceId.replace(/-/g, '').toLowerCase().startsWith(suffix.toLowerCase()))
    return { ...row, root: root as string | null, location, active,
      priority: (active ? 100 : 0) + (ownsDirectory ? 10 : 0) }
  }))
  const groups = new Map<string, typeof plans>()
  for (const plan of plans) {
    const key = normalizeManagedWorkspacePath(plan.root!)
    const group = groups.get(key) ?? []
    group.push(plan)
    groups.set(key, group)
  }
  const reserved = new Set(groups.keys())
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some(plan => plan.location !== null)) continue
    group.sort((a, b) => b.priority - a.priority)
    for (const plan of group.slice(1)) {
      if (!plan.active) {
        // Old revoked/disconnected bindings must not reserve the live container.
        plan.root = null
        continue
      }
      // Keep the original directory with its owner. An accidentally aliased
      // workspace receives a separate replica and an authoritative bootstrap.
      let root = await platform.path.join(await platform.path.appDataDir(), 'workspaces', 'self-hosted', plan.workspaceId)
      if (reserved.has(normalizeManagedWorkspacePath(root)) || await platform.fs.exists(root)) {
        root = await platform.path.join(await platform.path.appDataDir(), 'restored-workspaces', `self-hosted-${Date.now()}-${crypto.randomUUID()}`)
      }
      reserved.add(normalizeManagedWorkspacePath(root))
      await preservePendingWorkspaceFiles(plan.workspaceId, group[0].root!, root)
      plan.root = root
      plan.bindingState = 'epoch-changed'
    }
  }
  const changed = plans.filter(plan => plan.root !== plan.localRoot
    || plan.bindingState !== rows.find(row => row.workspaceId === plan.workspaceId)?.bindingState)
  if (!changed.length) return
  const now = Date.now()
  const statements: RecordStatement[] = []
  // Release every affected unique key before claiming canonical paths. This
  // also handles swaps; either the complete repair commits or none of it does.
  for (const plan of changed) statements.push({
    sql: 'update self_hosted_workspace_bindings set local_root = null where workspace_id = $1 and local_root = $2',
    values: [plan.workspaceId, plan.localRoot], expectedRows: 1,
  })
  for (const plan of changed) statements.push({
    sql: 'update self_hosted_workspace_bindings set local_root = $1, binding_state = $2, updated_at = $3 where workspace_id = $4 and local_root is null',
    values: [plan.root, plan.bindingState, now, plan.workspaceId], expectedRows: 1,
  })
  await executeRecordTransaction(statements)
}

export async function enqueueSelfHostedSettingChange(settingKey: string) {
  const database = await getDb()
  const now = Date.now()
  await database.execute(
    `insert into self_hosted_local_changes(domain, local_key, operation, reason, created_at, updated_at)
     values ('setting', 'all', 'upsert', $1, $2, $2)`,
    [`setting:${settingKey}`, now]
  )
}
