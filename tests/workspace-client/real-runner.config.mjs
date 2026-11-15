// SPDX-License-Identifier: GPL-3.0-only
// Configuration for the workspace-client real-backend runner (V3-04c).
// No secret values live here: credentials for a real-backend run are
// generated in memory by real-runner.mjs and never written to disk,
// never logged, and never included in result files.

import { homedir } from "node:os";
import { join } from "node:path";

// One entry per suite file. The group label is the reporting group
// used by the runner summary. files-crud mixes reads with basic
// writes; per-case names in the result file allow finer grouping.
export const TEST_FILES = [
  { file: "files-crud.test.mjs", group: "read-stat-scan", area: "list, file, stat, scan, mkdir, path validation" },
  { file: "guards.test.mjs", group: "write-guard", area: "revision guards, append, patch, idempotency" },
  { file: "move.test.mjs", group: "move", area: "move, rewrite links, repair-links" },
  { file: "trash.test.mjs", group: "trash", area: "delete to trash, batch trash, restore, purge, empty" },
  { file: "reconcile.test.mjs", group: "reconcile", area: "reconcile status and trigger" },
  { file: "media.test.mjs", group: "media", area: "media upload, download, Range, disposition" },
  { file: "auth.test.mjs", group: "auth", area: "session, CSRF, Origin, Bearer, envelope, 405" },
];

// The 24 canonical workspace/files routes (kontrak-api-kanonis.md 3.1).
// `sourceNeedle` is the literal the source-presence probe looks for
// under server/src. A route is reported as source-present when any
// server source file contains the needle; this is evidence for the
// "feature not landed" classification, never runtime proof.
export const ROUTES = [
  { method: "GET", path: "/api/workspace/list", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/list" },
  { method: "GET", path: "/api/workspace/file", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/file" },
  { method: "HEAD", path: "/api/workspace/file", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/file" },
  { method: "PUT", path: "/api/workspace/file", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/file" },
  { method: "POST", path: "/api/workspace/file/append", file: "guards.test.mjs", sourceNeedle: "/api/workspace/file/append" },
  { method: "POST", path: "/api/workspace/file/patch", file: "guards.test.mjs", sourceNeedle: "/api/workspace/file/patch" },
  { method: "POST", path: "/api/workspace/mkdir", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/mkdir" },
  { method: "POST", path: "/api/workspace/move", file: "move.test.mjs", sourceNeedle: "/api/workspace/move" },
  { method: "POST", path: "/api/workspace/move/repair-links", file: "move.test.mjs", sourceNeedle: "/api/workspace/move/repair-links" },
  { method: "DELETE", path: "/api/workspace/file", file: "trash.test.mjs", sourceNeedle: "/api/workspace/file" },
  { method: "DELETE", path: "/api/workspace/folder", file: "trash.test.mjs", sourceNeedle: "/api/workspace/folder" },
  { method: "POST", path: "/api/workspace/trash", file: "trash.test.mjs", sourceNeedle: "/api/workspace/trash" },
  { method: "GET", path: "/api/workspace/scan", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/scan" },
  { method: "GET", path: "/api/workspace/stat", file: "files-crud.test.mjs", sourceNeedle: "/api/workspace/stat" },
  { method: "GET", path: "/api/workspace/media", file: "media.test.mjs", sourceNeedle: "/api/workspace/media" },
  { method: "HEAD", path: "/api/workspace/media", file: "media.test.mjs", sourceNeedle: "/api/workspace/media" },
  { method: "POST", path: "/api/workspace/media", file: "media.test.mjs", sourceNeedle: "/api/workspace/media" },
  { method: "PUT", path: "/api/workspace/media", file: "media.test.mjs", sourceNeedle: "/api/workspace/media" },
  { method: "GET", path: "/api/workspace/trash", file: "trash.test.mjs", sourceNeedle: "/api/workspace/trash" },
  { method: "POST", path: "/api/workspace/trash/{id}/restore", file: "trash.test.mjs", sourceNeedle: "/api/workspace/trash/" },
  { method: "DELETE", path: "/api/workspace/trash/{id}", file: "trash.test.mjs", sourceNeedle: "/api/workspace/trash/" },
  { method: "DELETE", path: "/api/workspace/trash", file: "trash.test.mjs", sourceNeedle: "/api/workspace/trash" },
  { method: "POST", path: "/api/workspace/reconcile", file: "reconcile.test.mjs", sourceNeedle: "/api/workspace/reconcile" },
  { method: "GET", path: "/api/workspace/reconcile", file: "reconcile.test.mjs", sourceNeedle: "/api/workspace/reconcile" },
];

export const AUTH_ROUTES = [
  { method: "POST", path: "/api/auth/setup", sourceNeedle: "/api/auth/setup" },
  { method: "POST", path: "/api/auth/login", sourceNeedle: "/api/auth/login" },
  { method: "GET", path: "/api/auth/csrf", sourceNeedle: "/api/auth/csrf" },
];

// Cases that skip themselves in real-backend mode by design
// (skipUnlessMock in the V2-25 suite): fixtures that cannot be
// planted through the API. Expected real-backend skip count is 10,
// so the runnable total is 154 of 164.
export const EXPECTED_REAL_MODE_SKIPS = 10;
export const MOCK_TOTAL = 164;

export const DEFAULTS = {
  pgHost: "127.0.0.1",
  pgPort: 55433,
  pgUser: "postgres",
  pgDatabase: "v3_04c_ws",
  port: 35531,
  // Server default body limit is 1 MiB, which would mask the suite
  // 2 MiB text and 20 MiB media boundaries as payload errors. The
  // runner raises only the harness limit so per-endpoint limits
  // (text_too_large, media_too_large) are what the suite exercises.
  // This is a test-harness choice, not a product default claim.
  bodyLimitBytes: 22020096,
  serverStartTimeoutMs: 30000,
  suiteFileTimeoutMs: 300000,
  healthTimeoutMs: 5000,
};

export function defaultScratchRoot() {
  if (process.env.WS_REAL_SCRATCH_ROOT) {
    return process.env.WS_REAL_SCRATCH_ROOT;
  }
  return join(homedir(), "workspace", "note-gen-fork", "scratch", "v3-04c");
}

const DB_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseArgs(argv) {
  const args = {
    mode: process.env.WS_REAL_MODE || "mock",
    backendDir: process.env.WS_REAL_BACKEND_DIR || null,
    out: process.env.WS_REAL_OUT || null,
    port: null,
    db: null,
    workspaceDir: process.env.WS_REAL_WORKSPACE_DIR || null,
    scratchRoot: null,
    skipInstall: false,
    noBuild: false,
    noMigrate: false,
    clean: false,
    help: false,
  };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else if (arg === "--mode") {
      args.mode = rest.shift();
    } else if (arg.startsWith("--mode=")) {
      args.mode = arg.slice("--mode=".length);
    } else if (arg === "--backend-dir") {
      args.backendDir = rest.shift();
    } else if (arg.startsWith("--backend-dir=")) {
      args.backendDir = arg.slice("--backend-dir=".length);
    } else if (arg === "--out") {
      args.out = rest.shift();
    } else if (arg.startsWith("--out=")) {
      args.out = arg.slice("--out=".length);
    } else if (arg === "--port") {
      args.port = Number(rest.shift());
    } else if (arg.startsWith("--port=")) {
      args.port = Number(arg.slice("--port=".length));
    } else if (arg === "--db") {
      args.db = rest.shift();
    } else if (arg.startsWith("--db=")) {
      args.db = arg.slice("--db=".length);
    } else if (arg === "--workspace-dir") {
      args.workspaceDir = rest.shift();
    } else if (arg.startsWith("--workspace-dir=")) {
      args.workspaceDir = arg.slice("--workspace-dir=".length);
    } else if (arg === "--scratch-root") {
      args.scratchRoot = rest.shift();
    } else if (arg.startsWith("--scratch-root=")) {
      args.scratchRoot = arg.slice("--scratch-root=".length);
    } else if (arg === "--skip-install") {
      args.skipInstall = true;
    } else if (arg === "--no-build") {
      args.noBuild = true;
    } else if (arg === "--no-migrate") {
      args.noMigrate = true;
    } else if (arg === "--clean") {
      args.clean = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export function resolveConfig(args, repoRoot) {
  if (!["mock", "real", "external"].includes(args.mode)) {
    throw new Error(`Unknown mode: ${args.mode}. Expected mock, real, or external.`);
  }
  const port = args.port ?? Number(process.env.WS_REAL_PORT || DEFAULTS.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${port}`);
  }
  const pgDatabase = args.db || process.env.WS_REAL_DB || DEFAULTS.pgDatabase;
  if (!DB_NAME_RE.test(pgDatabase)) {
    throw new Error(`Invalid database name: ${pgDatabase}`);
  }
  const pgPort = Number(process.env.WS_REAL_PGPORT || process.env.PGPORT || DEFAULTS.pgPort);
  if (!Number.isInteger(pgPort) || pgPort < 1 || pgPort > 65535) {
    throw new Error(`Invalid Postgres port: ${pgPort}`);
  }
  const scratchRoot = args.scratchRoot || defaultScratchRoot();
  const backendDir = args.backendDir || repoRoot;
  return {
    mode: args.mode,
    repoRoot,
    backendDir,
    out: args.out,
    port,
    pgHost: process.env.WS_REAL_PGHOST || process.env.PGHOST || DEFAULTS.pgHost,
    pgPort,
    pgUser: process.env.WS_REAL_PGUSER || process.env.PGUSER || DEFAULTS.pgUser,
    pgDatabase,
    bodyLimitBytes: Number(process.env.WS_REAL_BODY_LIMIT_BYTES || DEFAULTS.bodyLimitBytes),
    workspaceDir: args.workspaceDir || join(scratchRoot, "ws"),
    scratchRoot,
    skipInstall: args.skipInstall,
    noBuild: args.noBuild,
    noMigrate: args.noMigrate,
    clean: args.clean,
    serverStartTimeoutMs: DEFAULTS.serverStartTimeoutMs,
    suiteFileTimeoutMs: DEFAULTS.suiteFileTimeoutMs,
  };
}

export const USAGE = `Workspace-client real-backend runner (V3-04c).

Usage:
  node tests/workspace-client/real-runner.mjs --mode mock
  node tests/workspace-client/real-runner.mjs --mode real [--backend-dir PATH] [--port N] [--db NAME]
  node tests/workspace-client/real-runner.mjs --mode external

Modes:
  mock      Run the V2-25 suite against its in-memory mock (default).
            No Postgres, no server build. Expected: 164/164.
  real      Boot the real Fastify server from --backend-dir (default:
            this checkout) over a scratch Postgres database and a
            scratch workspace directory, bootstrap one test account
            via setup/login, then run the suite against it.
  external  Run the suite against an already running backend.
            Requires WORKSPACE_BASE_URL, WORKSPACE_COOKIE,
            WORKSPACE_CSRF_TOKEN, WORKSPACE_ORIGIN in the environment.

Options:
  --backend-dir PATH   Checkout containing the server code (real mode).
  --out PATH           Result JSON path (default: scratch results dir).
  --port N             Server port for real mode (default 35531).
  --db NAME            Scratch database name (default v3_04c_ws).
  --workspace-dir PATH Scratch workspace root (default under scratch root).
  --scratch-root PATH  Scratch root (default ~/workspace/note-gen-fork/scratch/v3-04c).
  --skip-install       Skip pnpm install in the backend checkout.
  --no-build           Skip the server build (reuse server/dist).
  --no-migrate         Skip the explicit migration step.
  --clean              Remove the scratch workspace and drop the scratch
                       database when the run finishes.
  --help               Show this text.

Exit codes: 0 all runnable cases pass; 1 behavior failures;
2 feature not landed or backend cannot boot; 3 usage/config error.
See REAL-RUNNER-README.md for prerequisites and the full procedure.
`;
