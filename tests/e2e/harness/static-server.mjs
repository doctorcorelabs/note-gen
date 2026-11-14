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
//   playwright.config.ts).
// - E2E_STATIC_DIR: directory to serve (default: <repo>/out, resolved
//   from this script's location).

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
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
const port = Number(process.env.E2E_PORT ?? 4173)

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

const server = createServer((request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
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

server.listen(port, '127.0.0.1', () => {
  console.log(`E2E static server: serving ${serveDir} at http://127.0.0.1:${port}`)
})
