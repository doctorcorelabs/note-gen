// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork. See LICENSE and FORK.md.

// Dependency-free static file server for the E2E suite.
//
// Serves the production static export in <repo>/out over HTTP on
// 127.0.0.1. Playwright starts this script through the `webServer`
// entry in playwright.config.ts. It deliberately has no dependency
// (no `serve`, no framework) so the E2E harness adds nothing to the
// runtime dependency tree.
//
// Behavior:
// - Directory requests resolve to index.html inside the directory.
// - Extensionless paths fall back to "<path>/index.html", then
//   "<path>.html", matching the Next.js static export layout
//   (for example /core/main -> out/core/main/index.html).
// - Path traversal outside out/ is rejected with 400.
// - Responses carry Cache-Control: no-store so a stale bundle can
//   never make a test pass against yesterday's build.
// - If out/ does not exist, the server exits immediately with a
//   message naming `pnpm build` instead of failing vaguely later.
//
// Environment:
// - E2E_PORT: port to listen on (default 4173, same default as
//   playwright.config.ts). A non-numeric or out-of-range value
//   exits immediately with a named error; there is no silent
//   fallback to another port.
// - E2E_STATIC_DIR: directory to serve (default: <repo>/out, resolved
//   from this script's location).
// - E2E_API_BASE_URL: when set, proxy mode. Requests whose path is
//   /api or under /api/ are forwarded to this backend origin, and
//   everything else is served statically, so browser pages and API
//   calls share one origin (session cookies and Origin checks see
//   the same origin). The backend harness (harness/backend-fixture.ts)
//   starts one gateway per test with this variable pointing at that
//   test's backend. TEST-ONLY: the target must be a plain-http
//   loopback origin; any other target exits immediately. When the
//   variable is unset, /api/* paths answer 404 from the static
//   server exactly as before, which is the condition E2E-01 pins.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, request as proxyRequest } from 'node:http'
import { connect as netConnect } from 'node:net'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const scriptDir = fileURLToPath(new URL('.', import.meta.url))
const rootDir = resolve(scriptDir, '..', '..', '..')
const serveDir = process.env.E2E_STATIC_DIR
  ? resolve(process.env.E2E_STATIC_DIR)
  : join(rootDir, 'out')

function resolvePort() {
  const raw = process.env.E2E_PORT
  if (raw === undefined || raw.trim() === '') {
    return 4173
  }
  const trimmed = raw.trim()
  const port = Number(trimmed)
  if (!/^\d+$/.test(trimmed) || !Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('E2E static server: E2E_PORT is not valid: it must be a decimal integer from 1 to 65535.')
    process.exit(1)
  }
  return port
}

const port = resolvePort()

// Proxy target for /api/*, test-only and loopback-only. Exits
// immediately on any target that is not plain http on loopback.
function resolveApiTarget() {
  const raw = process.env.E2E_API_BASE_URL
  if (raw === undefined || raw.trim() === '') {
    return null
  }
  let target
  try {
    target = new URL(raw.trim())
  } catch {
    console.error('E2E static server: E2E_API_BASE_URL does not parse as a URL.')
    process.exit(1)
  }
  const loopback = new Set(['127.0.0.1', 'localhost', '::1'])
  if (target.protocol !== 'http:' || !loopback.has(target.hostname.toLowerCase())) {
    console.error('E2E static server: E2E_API_BASE_URL must be a plain-http loopback origin (test-only proxy).')
    process.exit(1)
  }
  return target
}

const apiTarget = resolveApiTarget()

if (!existsSync(serveDir) || !statSync(serveDir).isDirectory()) {
  console.error(
    `E2E static server: directory "${serveDir}" not found. ` +
      'Run "pnpm build" first so the production static export exists, ' +
      'then run the E2E suite again.',
  )
  process.exit(1)
}

function resolveFilePath(urlPath) {
  const decoded = decodeURIComponent(urlPath)
  const cleaned = decoded.replace(/^\/+/, '')
  const candidates = [join(serveDir, cleaned)]
  if (!extname(cleaned)) {
    candidates.push(join(serveDir, cleaned, 'index.html'))
    candidates.push(`${join(serveDir, cleaned)}.html`)
  } else if (decoded.endsWith('/')) {
    candidates.push(join(serveDir, cleaned, 'index.html'))
  }
  for (const candidate of candidates) {
    const resolved = resolve(candidate)
    if (resolved !== serveDir && !resolved.startsWith(serveDir + sep)) {
      return { status: 400 }
    }
    if (existsSync(resolved) && statSync(resolved).isFile()) {
      return { status: 200, file: resolved }
    }
  }
  return { status: 404 }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function isApiPath(pathname) {
  return pathname === '/api' || pathname.startsWith('/api/')
}

function forwardHeaders(headers, host) {
  const forwarded = {}
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue
    }
    forwarded[name] = value
  }
  forwarded.host = host
  return forwarded
}

function proxyApiRequest(request, response, url) {
  const targetPath = url.pathname + url.search
  const upstream = proxyRequest(
    {
      hostname: apiTarget.hostname,
      port: Number(apiTarget.port || 80),
      path: targetPath,
      method: request.method,
      headers: forwardHeaders(request.headers, apiTarget.host),
    },
    (upstreamResponse) => {
      const headers = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
          continue
        }
        headers[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, headers)
      upstreamResponse.pipe(response)
    },
  )
  upstream.once('error', (error) => {
    console.error('E2E static server: proxy to the test backend failed:', error.code ?? 'unknown')
    if (!response.headersSent) {
      response.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end('Bad gateway: the test backend is unreachable.')
    } else {
      response.destroy()
    }
  })
  request.pipe(upstream)
}

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (apiTarget !== null && isApiPath(url.pathname)) {
      proxyApiRequest(request, response, url)
      return
    }
    const result = resolveFilePath(url.pathname)
    if (result.status !== 200 || !result.file) {
      response.writeHead(result.status, { 'Content-Type': 'text/plain; charset=utf-8' })
      response.end(result.status === 400 ? 'Bad request' : 'Not found')
      return
    }
    const mime = MIME_TYPES[extname(result.file).toLowerCase()] ?? 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    createReadStream(result.file).pipe(response)
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
    response.end('Internal server error')
    console.error('E2E static server error:', error)
  }
})

server.on('upgrade', (request, socket, head) => {
  // WebSocket upgrade passthrough for the workspace events channel
  // (/api/workspace/events). The server route itself has not landed
  // yet, so no upgrade succeeds today; forwarding keeps the gateway
  // correct when it does, and the client polling fallback covers
  // the meantime. Non-API upgrades are refused.
  let pathname = ''
  try {
    pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
  } catch {
    socket.destroy()
    return
  }
  if (apiTarget === null || !isApiPath(pathname)) {
    socket.destroy()
    return
  }
  const upstream = netConnect(Number(apiTarget.port || 80), apiTarget.hostname, () => {
    const headers = []
    for (const [name, value] of Object.entries(request.headers)) {
      const lower = name.toLowerCase()
      if (lower === 'host') {
        continue
      }
      if (HOP_BY_HOP_HEADERS.has(lower) && lower !== 'upgrade' && lower !== 'connection') {
        continue
      }
      headers.push(`${name}: ${value}`)
    }
    upstream.write(
      `${request.method} ${request.url} HTTP/1.1\r\nHost: ${apiTarget.host}\r\n${headers.join('\r\n')}\r\n\r\n`,
    )
    if (head.length > 0) {
      upstream.write(head)
    }
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.once('error', () => {
    socket.destroy()
    upstream.destroy()
  })
  socket.once('error', () => {
    upstream.destroy()
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`E2E static server: serving ${serveDir} at http://127.0.0.1:${port}`)
  if (apiTarget !== null) {
    console.log('E2E static server: proxying /api/* to the test backend (test-only, loopback).')
  }
})
