// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Per-test backend harness for E2E flows (desain-pengujian 4.1,
// rencana-v41 sections 4 and 7). One test gets one backend process,
// one scratch database, and one workspace directory, and nothing is
// shared between tests: no shared state, no shared port, no shared
// credentials.
//
// How a test backend boots (production code, unchanged):
//   node server/dist/server.js
// with DATABASE_URL pointing at a scratch database created for this
// test, WORKSPACE_ROOT pointing at the seed workspace directory, and
// PUBLIC_BASE_URL set to the gateway origin the browser uses, so the
// server Origin checks accept browser traffic through the gateway.
// Startup migrations run by default (MIGRATE_ON_START unset means
// enabled, server/src/server.ts), so a fresh scratch database gets
// the current schema before the server accepts traffic. The harness
// waits for GET /api/health/ready to answer ok before returning.
//
// Cloudflare Access bypass, test-only: the test backend runs with
// CF_ACCESS_ENABLED=false, NODE_ENV=development, COOKIE_SECURE=false,
// and a loopback PUBLIC_BASE_URL. That combination is exactly the
// local-development shape the server config itself allows
// (server/src/config/env.ts): Access disabled is refused in
// production and refused with a non-localhost canonical origin, and
// this harness never changes those rules. There is no bypass code,
// no forged Access header, and no production file touched. The
// gateway (harness/static-server.mjs proxy mode) only forwards to a
// loopback backend. Do not reuse this configuration outside a test
// run on loopback: it is a test path, not a deployment shape.
//
// Secrets: AUTH_SECRET, ENCRYPTION_KEY, SETUP_TOKEN, and the test
// account password are generated per backend instance with
// node:crypto and live only in the child process environment and in
// memory. They are never logged, never written to disk, and never
// appear in an error message. AUTH_SECRET and ENCRYPTION_KEY are
// generated independently because the deployment contract requires
// them to differ (server/.env.example). The setup token and the
// credentials are returned to the caller for setupFirstAccount and
// loginViaApi (harness/auth.ts); keep them in memory only.
//
// Scratch databases: the harness needs E2E_PG_ADMIN_URL, a
// connection URL for the scratch Postgres cluster pointing at a
// maintenance database (for example the `postgres` database). The
// per-test URL is derived from it by replacing only the database
// name; the host, port, user, and credentials are never printed and
// never appear in an error message. Database creation and removal
// use the `pg` driver from the server package (server/node_modules,
// installed by the server install step that the build prerequisite
// already requires). If the driver cannot be loaded, boot fails
// with a named error instead of guessing. Database names are
// allowlisted ([a-z][a-z0-9_], at most 63 characters) before they
// are ever interpolated into CREATE/DROP statements; nothing else
// is interpolated. Teardown drops the scratch database with FORCE
// so a lingering pool connection cannot leave a database behind.
//
// Prerequisites, all failed fast with named errors: the built
// server (server/dist/server.js), the server dependencies, the
// E2E_PG_ADMIN_URL variable, and a reachable scratch cluster. This
// module has no silent defaults for any of them.
//
// Anti-flaky rules (desain-pengujian 4.3): no fixed sleeps and no
// fixed-duration waits. Readiness is polled by observation (the ready
// endpoint answering ok) with a deadline; the poll interval is not
// a timing assertion. A backend that exits early fails the wait
// immediately with its stderr tail instead of burning the deadline.
// A port collision (EADDRINUSE in the child stderr) retries boot
// with a fresh port, at most 3 attempts, because the collision is
// environment noise, not an application failure; any other early
// exit fails at once.
//
// LIVE STATUS: UNPROVEN. No live run has exercised this module yet:
// the Postgres cluster on the authoring VM is down, and the first
// live run is the merge gate on muse-2. Do not claim a green browser
// run until that gate reports one.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { createRequire } from 'node:module'

export const E2E_PG_ADMIN_URL_VAR = 'E2E_PG_ADMIN_URL'
export const SCRATCH_DB_NAME_PREFIX = 'notegen_e2e_'
export const MAX_SCRATCH_DB_NAME_LENGTH = 63
export const BACKEND_READY_TIMEOUT_MS = 30_000
export const BACKEND_STOP_TIMEOUT_MS = 10_000
export const BACKEND_KILL_TIMEOUT_MS = 5_000
export const READY_POLL_INTERVAL_MS = 250
export const MAX_BACKEND_BOOT_ATTEMPTS = 3

const SCRATCH_DB_NAME_PATTERN = /^[a-z][a-z0-9_]{0,62}$/
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

/** True when the name is safe to interpolate, quoted, into CREATE/DROP. */
export function isValidScratchDatabaseName(name: string): boolean {
  return SCRATCH_DB_NAME_PATTERN.test(name) && name.length <= MAX_SCRATCH_DB_NAME_LENGTH
}

function assertScratchDatabaseName(name: string): void {
  if (!isValidScratchDatabaseName(name)) {
    throw new Error(
      'e2e backend database name is not valid: it must start with a lowercase ' +
        'letter and contain only lowercase letters, digits, and underscores.',
    )
  }
}

/**
 * Build a scratch database name for one test. The worker index keeps
 * parallel workers apart; the random suffix keeps reruns apart. The
 * suffix is the only randomness, and no assertion depends on the
 * name, following the temporary-directory rule in desain-pengujian
 * 4.1. Pure: no I/O, no environment reads.
 */
export function buildScratchDatabaseName(workerIndex: number, randomSuffix: string): string {
  const name = `${SCRATCH_DB_NAME_PREFIX}w${workerIndex}_${randomSuffix}`
  assertScratchDatabaseName(name)
  return name
}

/**
 * Derive a per-test database URL from the admin URL by replacing
 * only the database name (the URL path). The admin URL must parse
 * and must use a Postgres scheme. Errors name the variable only;
 * the URL value, including any credential it carries, is never
 * included. Pure: no I/O.
 */
export function buildScratchDatabaseUrl(adminUrl: string, databaseName: string): string {
  assertScratchDatabaseName(databaseName)
  let parsed: URL
  try {
    parsed = new URL(adminUrl)
  } catch {
    throw new Error(
      `e2e backend database URL is not valid: ${E2E_PG_ADMIN_URL_VAR} does not parse as a URL.`,
    )
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `e2e backend database URL is not valid: ${E2E_PG_ADMIN_URL_VAR} must use a postgres URL scheme.`,
    )
  }
  parsed.pathname = `/${databaseName}`
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString()
}

/** Read the admin URL from the environment, failing honestly when absent. */
export function readPgAdminUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env[E2E_PG_ADMIN_URL_VAR]
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `e2e backend setup missing: ${E2E_PG_ADMIN_URL_VAR} not set. ` +
        'Supply a connection URL for the scratch Postgres cluster pointing at a ' +
        'maintenance database; the harness derives one scratch database per test from it.',
    )
  }
  return value
}

/** Generate one test-only secret. Length is in bytes before hex encoding. */
export function generateTestSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export interface BackendCredentials {
  email: string
  password: string
}

export interface BackendEnvOptions {
  backendPort: number
  gatewayOrigin: string
  databaseUrl: string
  workspaceRoot: string
  authSecret: string
  encryptionKey: string
  setupToken: string
}

/**
 * Build the child-process environment for one test backend. Pure:
 * the caller supplies every value, so the shape is checkable without
 * booting anything. The base is the parent environment minus the
 * server variables this harness owns, so a stray DATABASE_URL or
 * PORT from the operator shell can never leak into a test backend.
 * CF_ACCESS_ENABLED=false is the documented test-only bypass (see
 * the header): loopback + development only, enforced by the server
 * config itself.
 */
export function buildBackendEnv(
  options: BackendEnvOptions,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  let gateway: URL
  try {
    gateway = new URL(options.gatewayOrigin)
  } catch {
    throw new Error('e2e backend origin is not valid: the gateway origin does not parse as a URL.')
  }
  if (gateway.protocol !== 'http:') {
    throw new Error('e2e backend origin is not valid: the gateway origin must use plain http on loopback.')
  }
  if (!LOOPBACK_HOSTS.has(gateway.hostname.toLowerCase())) {
    throw new Error('e2e backend origin is not valid: the gateway origin must be a loopback host.')
  }
  if (!Number.isInteger(options.backendPort) || options.backendPort < 1 || options.backendPort > 65535) {
    throw new Error('e2e backend port is not valid: it must be an integer from 1 to 65535.')
  }
  if (options.authSecret === options.encryptionKey) {
    throw new Error('e2e backend secrets are not valid: AUTH_SECRET and ENCRYPTION_KEY must differ.')
  }
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  env.NODE_ENV = 'development'
  env.HOST = '127.0.0.1'
  env.PORT = String(options.backendPort)
  env.DATABASE_URL = options.databaseUrl
  env.WORKSPACE_ROOT = options.workspaceRoot
  env.PUBLIC_BASE_URL = gateway.origin
  env.COOKIE_SECURE = 'false'
  env.CF_ACCESS_ENABLED = 'false'
  env.REGISTRATION_MODE = 'closed'
  env.AUTH_SECRET = options.authSecret
  env.ENCRYPTION_KEY = options.encryptionKey
  env.SETUP_TOKEN = options.setupToken
  delete env.CF_ACCESS_AUD
  delete env.CF_ACCESS_TEAM_DOMAIN
  delete env.CF_ACCESS_SERVICE_AUD
  delete env.MIGRATE_ON_START
  return env
}

/**
 * Resolve the repo root for harness paths. Defaults to the process
 * working directory (Playwright runs from the repo root, as in
 * tests/e2e/README.md). The built server entry must exist there;
 * otherwise boot fails naming the server build step.
 */
export function resolveBackendEntry(repoRoot: string): string {
  const entry = join(repoRoot, 'server', 'dist', 'server.js')
  if (!existsSync(entry)) {
    throw new Error(
      'e2e backend build missing: server/dist/server.js does not exist. ' +
        'Build the server first (the build script in server/package.json), then run the E2E suite again.',
    )
  }
  return entry
}

/** Allocate an ephemeral loopback port by binding port 0, then releasing it. */
export function allocateFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer()
    server.once('error', rejectPromise)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      server.close(() => resolvePromise(port))
    })
  })
}

interface PgClientLike {
  connect(): Promise<void>
  query(text: string): Promise<unknown>
  end(): Promise<void>
}

type PgClientConstructor = new (config: { connectionString: string }) => PgClientLike

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code?: unknown }).code
    if (typeof code === 'string' && code !== '') {
      return code
    }
  }
  return undefined
}

/**
 * Load the `pg` Client constructor from the server package. The
 * server install step already provides it; the root package has no
 * Postgres driver on purpose. Fails with a named error when the
 * driver is missing instead of guessing another transport.
 */
export function loadPgClientConstructor(repoRoot: string): PgClientConstructor {
  let clientCtor: unknown
  try {
    const requireFromServer = createRequire(join(repoRoot, 'server', 'package.json'))
    const pgModule = requireFromServer('pg') as { Client?: unknown }
    clientCtor = pgModule.Client
  } catch {
    throw new Error(
      'e2e backend driver missing: the pg driver could not be loaded from the server package. ' +
        'Install the server dependencies first (the install step for server/package.json), then run again.',
    )
  }
  if (typeof clientCtor !== 'function') {
    throw new Error(
      'e2e backend driver missing: the pg driver in the server package has no Client constructor.',
    )
  }
  return clientCtor as PgClientConstructor
}

async function runAdminStatement(
  clientCtor: PgClientConstructor,
  adminUrl: string,
  statement: string,
  action: 'create' | 'drop',
): Promise<void> {
  const client = new clientCtor({ connectionString: adminUrl })
  try {
    await client.connect()
    await client.query(statement)
  } catch (error) {
    const code = pgErrorCode(error)
    throw new Error(
      `e2e backend database ${action} failed: the scratch database could not be ` +
        `${action === 'create' ? 'created' : 'dropped'} on the scratch cluster` +
        `${code === undefined ? '' : ` (database error ${code})`}. ` +
        `Check that the cluster named by ${E2E_PG_ADMIN_URL_VAR} is reachable; the URL value is never shown.`,
    )
  } finally {
    await client.end().catch(() => undefined)
  }
}

export async function createScratchDatabase(
  clientCtor: PgClientConstructor,
  adminUrl: string,
  databaseName: string,
): Promise<void> {
  assertScratchDatabaseName(databaseName)
  await runAdminStatement(clientCtor, adminUrl, `CREATE DATABASE "${databaseName}"`, 'create')
}

export async function dropScratchDatabase(
  clientCtor: PgClientConstructor,
  adminUrl: string,
  databaseName: string,
): Promise<void> {
  assertScratchDatabaseName(databaseName)
  await runAdminStatement(
    clientCtor,
    adminUrl,
    `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    'drop',
  )
}

export interface WaitForConditionOptions {
  timeoutMs: number
  intervalMs?: number
  onExhausted: () => string
}

/**
 * Poll a condition by observation until it holds or the deadline
 * passes. The interval spaces probes; it is not a timing assertion
 * and never stands in for the condition. On expiry the error names
 * the condition through onExhausted.
 */
export async function waitForCondition(
  predicate: () => Promise<boolean>,
  options: WaitForConditionOptions,
): Promise<void> {
  const intervalMs = options.intervalMs ?? READY_POLL_INTERVAL_MS
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    if (await predicate()) {
      return
    }
    if (Date.now() >= deadline) {
      throw new Error(options.onExhausted())
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
  }
}

function boundedTail(maxChars: number): { push(chunk: string): void; text(): string } {
  let buffer = ''
  return {
    push(chunk: string): void {
      buffer += chunk
      if (buffer.length > maxChars) {
        buffer = buffer.slice(buffer.length - maxChars)
      }
    },
    text(): string {
      return buffer
    },
  }
}

interface SpawnedBackend {
  child: ChildProcess
  stderrTail: () => string
  exited: () => boolean
}

function spawnBackend(entry: string, serverDir: string, env: Record<string, string>): SpawnedBackend {
  const child = spawn('node', [entry], { cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stderr = boundedTail(8192)
  let exited = false
  child.once('exit', () => {
    exited = true
  })
  child.stdout?.on('data', () => undefined)
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString('utf8')))
  child.once('error', () => {
    exited = true
  })
  return {
    child,
    stderrTail: () => stderr.text(),
    exited: () => exited,
  }
}

async function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return true
  }
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => resolvePromise(false), timeoutMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}

async function probeReady(apiBaseUrl: string): Promise<{ ready: boolean; failingChecks: string[] }> {
  try {
    const response = await fetch(`${apiBaseUrl}/api/health/ready`, {
      signal: AbortSignal.timeout(2000),
    })
    const body: unknown = await response.json().catch(() => undefined)
    if (response.status === 200 && typeof body === 'object' && body !== null && (body as { ok?: unknown }).ok === true) {
      return { ready: true, failingChecks: [] }
    }
    const failing: string[] = []
    if (typeof body === 'object' && body !== null) {
      const checks = (body as { checks?: unknown }).checks
      if (typeof checks === 'object' && checks !== null) {
        for (const [name, check] of Object.entries(checks as Record<string, unknown>)) {
          if (
            typeof check === 'object' &&
            check !== null &&
            (check as { status?: unknown }).status !== 'ok'
          ) {
            failing.push(name)
          }
        }
      }
    }
    if (failing.length === 0) {
      failing.push(`http_${response.status}`)
    }
    return { ready: false, failingChecks: failing }
  } catch {
    return { ready: false, failingChecks: ['unreachable'] }
  }
}

export interface StartBackendOptions {
  repoRoot: string
  workerIndex: number
  workspaceDir: string
  gatewayOrigin: string
  adminUrl: string
  readyTimeoutMs?: number
}

export interface StartedBackend {
  backendPort: number
  /** Direct backend origin (diagnostics only; the browser uses the gateway). */
  apiBaseUrl: string
  databaseName: string
  workspaceDir: string
  setupToken: string
  credentials: BackendCredentials
  stop(): Promise<void>
}

/**
 * Boot one backend for one test: create the scratch database, spawn
 * the server, wait for readiness, and return the stop handle plus
 * the in-memory setup token and credentials. The workspace
 * directory is owned by the caller (the fixture prepares and
 * removes it); this module owns the process and the database.
 * A boot that fails after creating the database drops it again, so
 * a failed boot never leaks a database silently: a drop failure
 * there is appended to the boot error.
 */
export async function startBackend(options: StartBackendOptions): Promise<StartedBackend> {
  const repoRoot = options.repoRoot
  const entry = resolveBackendEntry(repoRoot)
  const serverDir = join(repoRoot, 'server')
  const clientCtor = loadPgClientConstructor(repoRoot)
  const databaseName = buildScratchDatabaseName(
    options.workerIndex,
    randomBytes(6).toString('hex'),
  )
  const databaseUrl = buildScratchDatabaseUrl(options.adminUrl, databaseName)
  await createScratchDatabase(clientCtor, options.adminUrl, databaseName)

  const authSecret = generateTestSecret(32)
  const encryptionKey = generateTestSecret(32)
  const setupToken = generateTestSecret(32)
  const credentials: BackendCredentials = {
    email: `e2e-${databaseName}@example.invalid`,
    password: generateTestSecret(24),
  }
  const readyTimeoutMs = options.readyTimeoutMs ?? BACKEND_READY_TIMEOUT_MS

  let lastFailure: Error | undefined
  for (let attempt = 1; attempt <= MAX_BACKEND_BOOT_ATTEMPTS; attempt += 1) {
    const backendPort = await allocateFreePort()
    const env = buildBackendEnv({
      backendPort,
      gatewayOrigin: options.gatewayOrigin,
      databaseUrl,
      workspaceRoot: options.workspaceDir,
      authSecret,
      encryptionKey,
      setupToken,
    })
    const spawned = spawnBackend(entry, serverDir, env)
    const apiBaseUrl = `http://127.0.0.1:${backendPort}`
    let failingChecks: string[] = ['unreachable']
    let bootError: Error | undefined
    try {
      await waitForCondition(
        async () => {
          if (spawned.exited()) {
            throw new Error(
              'e2e backend exited during startup. ' +
                `Backend stderr tail: ${spawned.stderrTail().trim().slice(-2000) || '(empty)'}`,
            )
          }
          const probe = await probeReady(apiBaseUrl)
          failingChecks = probe.failingChecks
          return probe.ready
        },
        {
          timeoutMs: readyTimeoutMs,
          onExhausted: () =>
            `e2e backend did not become ready: GET /api/health/ready at the test backend ` +
            `never answered ok within ${readyTimeoutMs} ms (last probe: ${failingChecks.join(', ')}). ` +
            `Backend stderr tail: ${spawned.stderrTail().trim().slice(-2000) || '(empty)'}`,
        },
      )
      if (spawned.exited()) {
        throw new Error('e2e backend exited during startup.')
      }
    } catch (error) {
      bootError = error as Error
    }
    if (bootError === undefined && !spawned.exited()) {
      let stopped = false
      return {
        backendPort,
        apiBaseUrl,
        databaseName,
        workspaceDir: options.workspaceDir,
        setupToken,
        credentials,
        stop: async (): Promise<void> => {
          if (stopped) {
            return
          }
          stopped = true
          const problems: string[] = []
          spawned.child.kill('SIGTERM')
          const exitedCleanly = await waitForExit(spawned.child, BACKEND_STOP_TIMEOUT_MS)
          if (!exitedCleanly) {
            spawned.child.kill('SIGKILL')
            const exitedAfterKill = await waitForExit(spawned.child, BACKEND_KILL_TIMEOUT_MS)
            if (!exitedAfterKill) {
              problems.push('the backend process did not exit after SIGKILL')
            }
          }
          try {
            await dropScratchDatabase(clientCtor, options.adminUrl, databaseName)
          } catch (error) {
            problems.push((error as Error).message)
          }
          if (problems.length > 0) {
            throw new Error(`e2e backend stop failed: ${problems.join('; ')}`)
          }
        },
      }
    }
    const stderrText = spawned.stderrTail()
    if (!spawned.exited()) {
      spawned.child.kill('SIGKILL')
      await waitForExit(spawned.child, BACKEND_KILL_TIMEOUT_MS)
    }
    lastFailure = bootError ?? new Error('e2e backend exited during startup.')
    const collision = stderrText.includes('EADDRINUSE')
    if (!collision || attempt === MAX_BACKEND_BOOT_ATTEMPTS) {
      break
    }
  }
  try {
    await dropScratchDatabase(clientCtor, options.adminUrl, databaseName)
  } catch (error) {
    lastFailure = new Error(
      `${(lastFailure as Error).message} Cleanup also failed: ${(error as Error).message}`,
    )
  }
  throw lastFailure as Error
}
