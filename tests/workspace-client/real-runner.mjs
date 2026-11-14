// SPDX-License-Identifier: GPL-3.0-only
// Real-backend conformance runner for the workspace-client suite
// (V3-04c, wave 3A, Fase 1). This file only orchestrates: it boots a
// real Fastify server over a scratch Postgres database and a scratch
// workspace directory, bootstraps one test account through the
// public setup/login endpoints, runs the untouched V2-25 suite
// (tests/workspace-client/*.test.mjs) against it, and writes an
// honest per-group result file. It writes no server code and edits
// no suite file. Failures caused by a feature that has not landed
// are classified as not-landed, never as behavior bugs; behavior
// failures carry the failing case names as reproduction.
//
// No secret values are logged or written: setup tokens, passwords,
// session cookies, and CSRF tokens exist only in memory. Result
// files and console output carry statuses and error codes only.

import { randomBytes } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile, chown } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  AUTH_ROUTES,
  EXPECTED_REAL_MODE_SKIPS,
  MOCK_TOTAL,
  ROUTES,
  TEST_FILES,
  USAGE,
  parseArgs,
  resolveConfig,
} from "./real-runner.config.mjs";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SUITE_DIR = join(REPO_ROOT, "tests", "workspace-client");

function log(message) {
  console.log(`[real-runner] ${message}`);
}

function redact(text) {
  return String(text)
    .replace(/((?:^|[\r\n])\s*(?:set-)?cookie\s*:[^\r\n]*)/gi, "$1 [redacted]")
    .replace(/((?:^|[\r\n])\s*authorization\s*:[^\r\n]*)/gi, "$1 [redacted]")
    .replace(/("csrfToken"\s*:\s*")[^"]*(")/g, "$1[redacted]$2")
    .replace(/("setupToken"\s*:\s*")[^"]*(")/g, "$1[redacted]$2")
    .replace(/("password"\s*:\s*")[^"]*(")/g, "$1[redacted]$2");
}

function tailLines(text, count) {
  const lines = String(text).split(/\r?\n/).filter((line) => line.trim() !== "");
  return lines.slice(-count).join("\n");
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    if (options.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref?.();
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut, spawnError: error.message });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

function parseTapOutput(output) {
  const passMatch = output.match(/^# pass (\d+)$/m);
  const failMatch = output.match(/^# fail (\d+)$/m);
  const skipMatch = output.match(/^# skipped (\d+)$/m);
  const testsMatch = output.match(/^# tests (\d+)$/m);
  const failures = [];
  const skipped = [];
  for (const line of output.split(/\r?\n/)) {
    const notOk = line.match(/^not ok \d+ - (.+)$/);
    if (notOk) {
      failures.push(notOk[1].trim());
      continue;
    }
    const skipLine = line.match(/^ok \d+ - (.+) # SKIP\b(.*)$/);
    if (skipLine) {
      skipped.push(skipLine[1].trim());
    }
  }
  if (!passMatch || !failMatch) {
    return { pass: null, fail: null, skip: null, total: null, failures, skipped, parsed: false };
  }
  const pass = Number(passMatch[1]);
  const fail = Number(failMatch[1]);
  const skip = skipMatch ? Number(skipMatch[1]) : 0;
  return {
    pass,
    fail,
    skip,
    total: testsMatch ? Number(testsMatch[1]) : pass + fail + skip,
    failures,
    skipped,
    parsed: true,
  };
}

async function runSuiteFile(fileName, env, resultsDir) {
  const filePath = join(SUITE_DIR, fileName);
  const startedAt = new Date().toISOString();
  const result = await runCommand(
    process.execPath,
    ["--test", "--test-reporter=tap", filePath],
    { cwd: REPO_ROOT, env: { ...process.env, ...env }, timeoutMs: 300000 },
  );
  const parsed = parseTapOutput(result.stdout);
  const rawPath = join(resultsDir, `${fileName}.tap.log`);
  await writeFile(rawPath, `command: node --test --test-reporter=tap ${filePath}\nexit: ${result.code}\ntimedOut: ${result.timedOut}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${redact(result.stderr)}\n`, "utf8");
  return {
    file: fileName,
    startedAt,
    exitCode: result.code,
    timedOut: result.timedOut,
    ...parsed,
    rawLog: rawPath,
  };
}

async function collectSourceFiles(root) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

async function probeSourceRoutes(backendDir) {
  const serverSrc = join(backendDir, "server", "src");
  const files = await collectSourceFiles(serverSrc);
  const contents = [];
  for (const file of files) {
    try {
      contents.push({ file: file.slice(backendDir.length + 1), text: await readFile(file, "utf8") });
    } catch {
      // Unreadable source file: skip it; absence is reported, not assumed.
    }
  }
  const check = (needle) => {
    const matched = contents.filter((entry) => entry.text.includes(needle)).map((entry) => entry.file);
    return { present: matched.length > 0, files: matched };
  };
  const routes = ROUTES.map((route) => ({ ...route, ...check(route.sourceNeedle) }));
  const auth = AUTH_ROUTES.map((route) => ({ ...route, ...check(route.sourceNeedle) }));
  return { serverSrc, filesScanned: contents.length, routes, auth };
}

function classifyFile(fileResult, sourceProbe) {
  if (!fileResult.parsed) return "unparsed";
  if (fileResult.fail === 0) return "pass";
  const routes = sourceProbe.routes.filter((route) => route.file === fileResult.file);
  if (routes.length > 0 && routes.every((route) => !route.present)) return "not-landed";
  if (routes.some((route) => !route.present)) return "partially-landed";
  return "behavior";
}

async function gitHead(dir) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "HEAD"], { timeout: 10000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function psql(config, database, sql) {
  const args = ["-h", config.pgHost, "-p", String(config.pgPort), "-U", config.pgUser, "-d", database, "-v", "ON_ERROR_STOP=1", "-t", "-A", "-c", sql];
  const result = await runCommand("psql", args, { timeoutMs: 30000 });
  return result;
}

async function setupDatabase(config) {
  const version = await psql(config, "postgres", "SELECT version();");
  if (version.code !== 0) {
    throw new Error(`Postgres is not reachable at ${config.pgHost}:${config.pgPort} as ${config.pgUser}. psql output: ${tailLines(version.stderr || version.stdout, 5)}`);
  }
  const pgVersion = version.stdout.trim().split("\n")[0] || "";
  const db = config.pgDatabase;
  const terminate = await psql(config, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
  if (terminate.code !== 0) {
    throw new Error(`Could not terminate sessions on scratch database ${db}: ${tailLines(terminate.stderr, 5)}`);
  }
  const drop = await psql(config, "postgres", `DROP DATABASE IF EXISTS "${db}";`);
  if (drop.code !== 0) {
    throw new Error(`Could not drop scratch database ${db}: ${tailLines(drop.stderr, 5)}`);
  }
  const create = await psql(config, "postgres", `CREATE DATABASE "${db}";`);
  if (create.code !== 0) {
    throw new Error(`Could not create scratch database ${db}: ${tailLines(create.stderr, 5)}`);
  }
  return { pgVersion, database: db };
}

async function dropDatabase(config) {
  await psql(config, "postgres", `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${config.pgDatabase}' AND pid <> pg_backend_pid();`);
  await psql(config, "postgres", `DROP DATABASE IF EXISTS "${config.pgDatabase}";`);
}

function pnpmBinary() {
  if (process.env.WS_REAL_PNPM) return process.env.WS_REAL_PNPM;
  const homeBin = join(process.env.HOME || "", ".local", "bin", "pnpm");
  if (homeBin && existsSync(homeBin)) return homeBin;
  return "pnpm";
}

async function installBackend(config) {
  const serverDir = join(config.backendDir, "server");
  const pnpm = pnpmBinary();
  const attempt = () => runCommand(pnpm, ["install", "--frozen-lockfile"], { cwd: serverDir, timeoutMs: 600000 });
  let result = await attempt();
  if (result.code === 0) return { status: "ok", attempts: 1 };
  const combined = `${result.stdout}\n${result.stderr}`;
  if (combined.includes("EPERM") && combined.includes(".modules.yaml")) {
    // Known root-install EPERM: write-file-atomic chowns its temp file
    // to the previous .modules.yaml owner; chowning the existing file
    // to 0:0 first makes the retry chown succeed. See
    // fase1/investigasi-hang-eperm.md section 2.
    const target = join(serverDir, "node_modules", ".modules.yaml");
    try {
      await chown(target, 0, 0);
    } catch {
      // Best effort; the retry result below is the verdict.
    }
    result = await attempt();
    if (result.code === 0) return { status: "ok-after-eperm-retry", attempts: 2 };
  }
  return { status: "failed", attempts: result.code === 0 ? 1 : 2, tail: redact(tailLines(`${result.stdout}\n${result.stderr}`, 20)) };
}

async function buildBackend(config) {
  const serverDir = join(config.backendDir, "server");
  const result = await runCommand(pnpmBinary(), ["run", "build"], { cwd: serverDir, timeoutMs: 300000 });
  if (result.code === 0) return { status: "ok" };
  return { status: "failed", tail: redact(tailLines(`${result.stdout}\n${result.stderr}`, 20)) };
}

async function runMigrations(config, databaseUrl) {
  const migrateJs = join(config.backendDir, "server", "dist", "db", "migrate.js");
  if (!existsSync(migrateJs)) {
    return { status: "unavailable", reason: "built migrator not found at server/dist/db/migrate.js" };
  }
  const script = [
    "import { pathToFileURL } from 'node:url';",
    "const { runMigrations } = await import(pathToFileURL(process.env.WS_REAL_MIGRATE_JS).href);",
    "const out = await runMigrations({ databaseUrl: process.env.WS_REAL_DATABASE_URL });",
    "console.log(JSON.stringify({ appliedTags: out.appliedTags, driftCurrent: out.drift.current }));",
  ].join("\n");
  const result = await runCommand(
    process.execPath,
    ["--input-type=module", "-e", script],
    { cwd: config.backendDir, env: { ...process.env, WS_REAL_DATABASE_URL: databaseUrl, WS_REAL_MIGRATE_JS: migrateJs }, timeoutMs: 120000 },
  );
  if (result.code !== 0) {
    return { status: "failed", tail: redact(tailLines(`${result.stdout}\n${result.stderr}`, 15)) };
  }
  try {
    const parsed = JSON.parse(result.stdout.trim().split("\n").pop());
    return { status: "ok", appliedTags: parsed.appliedTags, driftCurrent: parsed.driftCurrent };
  } catch {
    return { status: "unknown", tail: redact(tailLines(result.stdout, 5)) };
  }
}

async function waitForLive(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health/live`, { signal: AbortSignal.timeout(2000) });
      if (response.status === 200) return { ok: true, status: 200 };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
    await sleep(500);
  }
  return { ok: false, lastError };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { redirect: "manual", ...options });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json };
}

function errorCodeOf(payload) {
  if (payload?.json?.error?.code) return payload.json.error.code;
  return null;
}

async function bootstrapAuth(baseUrl, credentials) {
  const origin = new URL(baseUrl).origin;
  const jsonHeaders = { "Content-Type": "application/json", Origin: origin };
  const setup = await fetchJson(`${baseUrl}/api/auth/setup`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ setupToken: credentials.setupToken, email: credentials.email, password: credentials.password }),
  });
  const setupCode = errorCodeOf(setup);
  let setupNote = null;
  if (setup.status !== 201) {
    if (setup.status === 404) {
      // Ambiguous: installation already closed, or the route has not
      // landed. Disambiguate with a login attempt: a 401 proves the
      // auth routes exist; a 404 proves they do not.
      const probe = await fetchJson(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify({ email: credentials.email, password: credentials.password }),
      });
      if (probe.status === 404) {
        return {
          status: "not-landed",
          detail: "setup and login both answer 404: auth routes have not landed",
          setupStatus: setup.status,
          setupCode,
          loginProbeStatus: probe.status,
          loginProbeCode: errorCodeOf(probe),
        };
      }
      setupNote = `setup answered 404 on a fresh database; login probe answered ${probe.status}, so setup is closed unexpectedly rather than missing`;
    } else {
      return {
        status: "failed",
        detail: `setup answered HTTP ${setup.status} with code ${setupCode || "none"}`,
        setupStatus: setup.status,
        setupCode,
      };
    }
  }
  const login = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email: credentials.email, password: credentials.password }),
  });
  if (login.status === 202) {
    return { status: "failed", detail: "login answered 202 (TOTP challenge) for a fresh account; TOTP must be off for the bootstrap account", loginStatus: 202 };
  }
  if (login.status !== 200) {
    return { status: "failed", detail: `login answered HTTP ${login.status} with code ${errorCodeOf(login) || "none"}`, loginStatus: login.status, loginCode: errorCodeOf(login) };
  }
  const setCookie = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
  const cookieParts = [];
  for (const header of setCookie) {
    const first = header.split(";")[0].trim();
    if (first) cookieParts.push(first);
  }
  if (cookieParts.length === 0) {
    return { status: "failed", detail: "login answered 200 but set no session cookie", loginStatus: 200 };
  }
  const cookie = cookieParts.join("; ");
  let csrfToken = login.json?.data?.csrfToken || null;
  if (typeof csrfToken !== "string" || csrfToken === "") {
    const csrf = await fetchJson(`${baseUrl}/api/auth/csrf`, { headers: { Cookie: cookie } });
    csrfToken = csrf.json?.data?.csrfToken || null;
    if (typeof csrfToken !== "string" || csrfToken === "") {
      return { status: "failed", detail: "no CSRF token from login or GET /api/auth/csrf", loginStatus: 200, csrfStatus: csrf.status };
    }
  }
  return { status: "ok", cookie, csrfToken, setupNote, loginStatus: 200 };
}

async function probeRuntime(baseUrl, auth) {
  const probes = [
    { name: "GET list", method: "GET", path: "/api/workspace/list?path=ws-probe" },
    { name: "GET stat missing", method: "GET", path: "/api/workspace/stat?path=ws-probe%2Fmissing.md" },
    { name: "GET scan", method: "GET", path: "/api/workspace/scan?path=ws-probe" },
    { name: "GET trash", method: "GET", path: "/api/workspace/trash" },
    { name: "GET reconcile", method: "GET", path: "/api/workspace/reconcile" },
    { name: "HEAD file missing", method: "HEAD", path: "/api/workspace/file?path=ws-probe%2Fmissing.md" },
  ];
  const results = [];
  for (const probe of probes) {
    try {
      const response = await fetchJson(`${baseUrl}${probe.path}`, { method: probe.method, headers: { Cookie: auth.cookie } });
      results.push({ ...probe, status: response.status, code: errorCodeOf(response) });
    } catch (error) {
      results.push({ ...probe, status: null, code: null, error: error.message });
    }
  }
  return results;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 3;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  let config;
  try {
    config = resolveConfig(args, REPO_ROOT);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 3;
    return;
  }

  const startedAt = new Date().toISOString();
  const stamp = startedAt.replace(/[:.]/g, "-");
  const resultsDir = config.out ? dirname(resolve(config.out)) : join(config.scratchRoot, "results", `${config.mode}-${stamp}`);
  await mkdir(resultsDir, { recursive: true });
  const outPath = config.out ? resolve(config.out) : join(resultsDir, "results.json");

  const results = {
    runner: "tests/workspace-client/real-runner.mjs",
    worker: "V3-04c",
    mode: config.mode,
    startedAt,
    repoRoot: REPO_ROOT,
    backendDir: resolve(config.backendDir),
    backendHead: await gitHead(resolve(config.backendDir)),
    suiteDir: SUITE_DIR,
    config: {
      port: config.port,
      pgHost: config.pgHost,
      pgPort: config.pgPort,
      pgUser: config.pgUser,
      pgDatabase: config.pgDatabase,
      bodyLimitBytes: config.bodyLimitBytes,
      workspaceDir: config.workspaceDir,
      scratchRoot: config.scratchRoot,
    },
    steps: {},
    sourceProbe: null,
    runtimeProbe: null,
    authBootstrap: null,
    files: [],
    totals: null,
    verdict: null,
    finishedAt: null,
  };

  const writeResults = async () => {
    results.finishedAt = new Date().toISOString();
    await writeFile(outPath, `${JSON.stringify(results, null, 2)}\n`, "utf8");
    log(`results written to ${outPath}`);
  };

  let serverChild = null;
  const stopServer = async () => {
    if (!serverChild) return;
    const child = serverChild;
    serverChild = null;
    if (child.exitCode !== null) return;
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
      sleep(5000).then(() => false),
    ]);
    if (!exited) child.kill("SIGKILL");
  };

  try {
    if (config.mode === "mock") {
      log("mode=mock: running the suite against its in-memory mock");
      for (const entry of TEST_FILES) {
        const fileResult = await runSuiteFile(entry.file, {}, resultsDir);
        results.files.push({ ...entry, ...fileResult, classification: fileResult.fail === 0 ? "pass" : "behavior" });
        log(`${entry.file}: pass=${fileResult.pass} fail=${fileResult.fail} skip=${fileResult.skip}`);
      }
    } else if (config.mode === "external") {
      const baseUrl = (process.env.WORKSPACE_BASE_URL || "").replace(/\/+$/, "");
      const cookie = process.env.WORKSPACE_COOKIE || "";
      const csrfToken = process.env.WORKSPACE_CSRF_TOKEN || "";
      const origin = process.env.WORKSPACE_ORIGIN || "";
      if (!baseUrl || !cookie || !csrfToken || !origin) {
        console.error("external mode requires WORKSPACE_BASE_URL, WORKSPACE_COOKIE, WORKSPACE_CSRF_TOKEN, and WORKSPACE_ORIGIN.");
        process.exitCode = 3;
        results.verdict = "config-error";
        await writeResults();
        return;
      }
      log(`mode=external: baseUrl=${baseUrl}`);
      results.sourceProbe = await probeSourceRoutes(resolve(config.backendDir));
      const env = { WORKSPACE_BASE_URL: baseUrl, WORKSPACE_COOKIE: cookie, WORKSPACE_CSRF_TOKEN: csrfToken, WORKSPACE_ORIGIN: origin };
      for (const entry of TEST_FILES) {
        const fileResult = await runSuiteFile(entry.file, env, resultsDir);
        results.files.push({ ...entry, ...fileResult, classification: classifyFile(fileResult, results.sourceProbe) });
        log(`${entry.file}: pass=${fileResult.pass} fail=${fileResult.fail} skip=${fileResult.skip}`);
      }
    } else {
      // Real mode: build, migrate, boot, bootstrap, run.
      const backendDir = resolve(config.backendDir);
      const serverDir = join(backendDir, "server");
      if (!existsSync(join(serverDir, "package.json"))) {
        console.error(`No server package at ${serverDir}. Point --backend-dir at a checkout containing server/.`);
        process.exitCode = 2;
        results.verdict = "not-landed";
        results.steps.backendCheck = { status: "failed", reason: "server/package.json missing" };
        await writeResults();
        return;
      }
      results.sourceProbe = await probeSourceRoutes(backendDir);
      const landedRoutes = results.sourceProbe.routes.filter((route) => route.present).length;
      log(`source probe: ${landedRoutes}/${ROUTES.length} workspace routes present in server source; auth present: ${results.sourceProbe.auth.map((route) => `${route.path}=${route.present}`).join(", ")}`);

      // Scratch workspace: fresh directory under the scratch root.
      await rm(config.workspaceDir, { recursive: true, force: true });
      await mkdir(config.workspaceDir, { recursive: true });
      results.steps.workspace = { status: "ok", path: config.workspaceDir };

      // Scratch database: drop and recreate.
      const dbInfo = await setupDatabase(config);
      results.steps.database = { status: "ok", pgVersion: dbInfo.pgVersion, database: dbInfo.database };
      log(`scratch database ${dbInfo.database} ready (${dbInfo.pgVersion})`);

      // Install and build the backend checkout.
      if (!config.skipInstall) {
        log("installing backend dependencies with pnpm");
        const installed = await installBackend(config);
        results.steps.install = installed;
        if (installed.status === "failed") {
          console.error(`pnpm install failed. Tail:\n${installed.tail || ""}`);
          process.exitCode = 2;
          results.verdict = "cannot-boot";
          await writeResults();
          return;
        }
      } else {
        results.steps.install = { status: "skipped" };
      }
      if (!config.noBuild) {
        log("building the backend (tsc)");
        const built = await buildBackend(config);
        results.steps.build = built;
        if (built.status === "failed") {
          console.error(`server build failed. Tail:\n${built.tail || ""}`);
          process.exitCode = 2;
          results.verdict = "cannot-boot";
          await writeResults();
          return;
        }
      } else {
        results.steps.build = { status: "skipped" };
      }

      const databaseUrl = `postgres://${config.pgUser}@${config.pgHost}:${config.pgPort}/${config.pgDatabase}`;
      if (!config.noMigrate) {
        log("running migrations through the server migrator");
        results.steps.migrate = await runMigrations(config, databaseUrl);
        log(`migrate: ${results.steps.migrate.status}`);
      } else {
        results.steps.migrate = { status: "skipped" };
      }

      // Ephemeral test credentials, memory only. The setup token and
      // secrets are random per run; the password meets the 12-128
      // character rule and mixes character classes.
      const credentials = {
        setupToken: randomBytes(36).toString("hex"),
        authSecret: randomBytes(36).toString("hex"),
        encryptionKey: randomBytes(32).toString("base64"),
        email: "ws-conformance@example.invalid",
        password: `Aa1!${randomBytes(18).toString("base64url")}`,
      };
      const baseUrl = `http://127.0.0.1:${config.port}`;
      const serverEnv = {
        ...process.env,
        NODE_ENV: "development",
        HOST: "127.0.0.1",
        PORT: String(config.port),
        DATABASE_URL: databaseUrl,
        WORKSPACE_ROOT: config.workspaceDir,
        BODY_LIMIT_BYTES: String(config.bodyLimitBytes),
        AUTH_SECRET: credentials.authSecret,
        ENCRYPTION_KEY: credentials.encryptionKey,
        SETUP_TOKEN: credentials.setupToken,
        REGISTRATION_MODE: "closed",
        PUBLIC_BASE_URL: baseUrl,
        TRUST_PROXY: "false",
        COOKIE_SECURE: "false",
        CF_ACCESS_ENABLED: "false",
        LOG_LEVEL: "warn",
        MIGRATE_ON_START: "true",
      };
      const serverEntry = join(serverDir, "dist", "server.js");
      if (!existsSync(serverEntry)) {
        console.error(`Server entry not found at ${serverEntry}. Build first or drop --no-build.`);
        process.exitCode = 2;
        results.verdict = "cannot-boot";
        results.steps.boot = { status: "failed", reason: "dist/server.js missing" };
        await writeResults();
        return;
      }
      const serverLogPath = join(resultsDir, "server.log");
      const { createWriteStream } = await import("node:fs");
      const serverLog = createWriteStream(serverLogPath, { flags: "w" });
      serverChild = spawn(process.execPath, [serverEntry], { cwd: serverDir, env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
      serverChild.stdout.pipe(serverLog);
      serverChild.stderr.pipe(serverLog);
      results.steps.boot = { status: "started", baseUrl, log: serverLogPath };
      const live = await waitForLive(baseUrl, config.serverStartTimeoutMs);
      if (!live.ok) {
        console.error(`Server did not answer liveness within ${config.serverStartTimeoutMs} ms (${live.lastError}). See ${serverLogPath}.`);
        process.exitCode = 2;
        results.verdict = "cannot-boot";
        results.steps.boot.status = "no-liveness";
        results.steps.boot.lastError = live.lastError;
        await stopServer();
        serverLog.end();
        await writeResults();
        return;
      }
      log(`server live at ${baseUrl}`);
      const ready = await fetchJson(`${baseUrl}/api/health/ready`);
      results.steps.ready = { status: ready.status, checks: ready.json?.checks ?? null, ok: ready.json?.ok ?? null };
      log(`ready: HTTP ${ready.status} ok=${ready.json?.ok ?? "unknown"}`);

      const auth = await bootstrapAuth(baseUrl, credentials);
      results.authBootstrap = {
        status: auth.status,
        detail: auth.detail || null,
        setupStatus: auth.setupStatus ?? null,
        setupCode: auth.setupCode ?? null,
        loginStatus: auth.loginStatus ?? null,
        loginCode: auth.loginCode ?? null,
        loginProbeStatus: auth.loginProbeStatus ?? null,
        loginProbeCode: auth.loginProbeCode ?? null,
        setupNote: auth.setupNote ?? null,
      };
      if (auth.status !== "ok") {
        console.error(`Auth bootstrap: ${auth.status}: ${auth.detail || ""}`);
        process.exitCode = 2;
        results.verdict = auth.status === "not-landed" ? "not-landed" : "cannot-boot";
        await stopServer();
        serverLog.end();
        await writeResults();
        return;
      }
      log("auth bootstrap ok (setup + login; cookie and CSRF token held in memory only)");

      results.runtimeProbe = await probeRuntime(baseUrl, auth);
      for (const probe of results.runtimeProbe) {
        log(`probe ${probe.name}: HTTP ${probe.status} code=${probe.code || "-"}`);
      }

      const env = {
        WORKSPACE_BASE_URL: baseUrl,
        WORKSPACE_COOKIE: auth.cookie,
        WORKSPACE_CSRF_TOKEN: auth.csrfToken,
        WORKSPACE_ORIGIN: baseUrl,
      };
      for (const entry of TEST_FILES) {
        const fileResult = await runSuiteFile(entry.file, env, resultsDir);
        const classification = classifyFile(fileResult, results.sourceProbe);
        results.files.push({ ...entry, ...fileResult, classification });
        log(`${entry.file}: pass=${fileResult.pass} fail=${fileResult.fail} skip=${fileResult.skip} classification=${classification}`);
      }
      await stopServer();
      serverLog.end();
    }

    // Totals and verdict.
    const parsed = results.files.filter((entry) => entry.parsed);
    const totals = {
      files: results.files.length,
      pass: parsed.reduce((sum, entry) => sum + (entry.pass || 0), 0),
      fail: parsed.reduce((sum, entry) => sum + (entry.fail || 0), 0),
      skip: parsed.reduce((sum, entry) => sum + (entry.skip || 0), 0),
      total: parsed.reduce((sum, entry) => sum + (entry.total || 0), 0),
      unparsedFiles: results.files.length - parsed.length,
    };
    results.totals = totals;
    if (results.files.length === 0) {
      results.verdict = results.verdict || "no-runs";
    } else if (totals.fail === 0 && totals.unparsedFiles === 0) {
      results.verdict = "pass";
    } else if (results.files.every((entry) => entry.classification === "not-landed" || entry.classification === "pass")) {
      results.verdict = "not-landed";
    } else if (results.files.some((entry) => entry.classification === "behavior" || entry.classification === "unparsed")) {
      results.verdict = "behavior-failures";
    } else {
      results.verdict = "partially-landed";
    }
    if (config.mode === "mock" && totals.total !== MOCK_TOTAL) {
      log(`warning: mock total ${totals.total} differs from the expected ${MOCK_TOTAL}; the suite may have changed`);
    }
    if ((config.mode === "real" || config.mode === "external") && totals.skip !== EXPECTED_REAL_MODE_SKIPS) {
      log(`note: real-mode skips=${totals.skip}, expected ${EXPECTED_REAL_MODE_SKIPS} fixture cases; see per-file skipped lists`);
    }
    console.log("");
    console.log("Group results:");
    for (const entry of results.files) {
      console.log(`  ${entry.group.padEnd(16)} ${entry.file.padEnd(24)} pass=${entry.pass} fail=${entry.fail} skip=${entry.skip} ${entry.classification}`);
    }
    console.log(`Totals: pass=${totals.pass} fail=${totals.fail} skip=${totals.skip} total=${totals.total} verdict=${results.verdict}`);
    await writeResults();

    if (config.mode === "real" && config.clean) {
      await rm(config.workspaceDir, { recursive: true, force: true });
      await dropDatabase(config);
      log("scratch workspace removed and scratch database dropped (--clean)");
    }
    process.exitCode = results.verdict === "pass" ? 0 : results.verdict === "not-landed" || results.verdict === "partially-landed" ? 2 : 1;
  } catch (error) {
    console.error(`real-runner failed: ${redact(error.message)}`);
    results.verdict = "runner-error";
    results.steps.runnerError = { message: redact(error.message) };
    await stopServer();
    await writeResults();
    process.exitCode = 2;
  }
}

main();
