// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Fastify application factory. buildApp creates the instance and
// registers routes, but never listens: only server.ts calls listen(),
// so tests can exercise the app with inject() without opening a port.
//
// Foundation wiring (Fase 1, V2-02), in registration order:
// 1. Request ids: genReqId honors a well-formed client X-Request-Id
//    and otherwise generates a UUID; every reply echoes the id in the
//    X-Request-Id header, and error envelopes carry the same id.
// 2. Error handling: unknown paths answer 404 with the generic error
//    envelope; health paths keep the Fase 0 emergency envelope safety
//    net; all other errors become the generic envelope without leaking
//    messages, stack traces, or config values.
// 3. Auth hooks: routes under /api/ are protected by default (see
//    middleware/auth-hook.ts). Health routes are explicitly public.
//    Without an injected verifySession, protected routes answer 401:
//    the foundation is deny-by-default until the auth worker lands.
// 4. Health routes, unchanged in behavior from Fase 0.
// 5. Auth core routes (V3-01, AD-40): registered only when an auth
//    context is injected through AppDeps, as the first commented
//    route block after health. Without the injection, no auth route
//    exists and the deny-by-default behavior of point 3 is
//    unchanged.
//
// Request logging is disabled: health probes arrive every few seconds
// from watchdogs and container healthchecks, and successful probes must
// not flood the log. Failed checks are logged by the ready handler
// itself, with error codes only. Credential-carrying headers are
// redacted at the logger level (see plugins/logging.ts).

import Fastify, { LogController, type FastifyInstance } from 'fastify';
import type { AuthContext } from './auth/context.js';
import type { ServerConfig } from './config.js';
import type { HealthDbPool } from './db/pool.js';
import {
  registerAuthHooks,
  type VerifyCsrfTokenFn,
  type VerifyOriginFn,
  type VerifySessionFn,
} from './middleware/auth-hook.js';
import { createCsrfVerifier } from './middleware/csrf.js';
import { createSessionVerifier } from './middleware/session.js';
import { registerErrorHandling } from './plugins/error-handler.js';
import { buildLoggerOptions } from './plugins/logging.js';
import { registerRequestId, requestIdFromHeaders } from './plugins/request-id.js';
import { registerAuthCoreRoutes } from './routes/auth-core.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerWorkspaceReadRoutes } from './routes/workspace-read.js';
import { registerWorkspaceWriteRoutes } from './routes/workspace-write.js';
import { registerSecretsRoutes } from './routes/secrets.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerDbRoutes } from './routes/db.js';
import { createV304aWritePorts } from './services/workspace/write-adapter.js';
import { createProductionSettingsDeps } from './services/settings/index.js';
import { createDefaultDbRouteDeps } from './services/db/deps.js';

// Db kind handlers (V3-13b): one direct import per handler file,
// no barrel (see services/db/deps.ts wiring pattern).
import { HANDLER_KIND as canvasesCreateKind, handle as canvasesCreate, validate as validateCanvasesCreate } from './services/db/canvases-create.js';
import { HANDLER_KIND as canvasesGetKind, handle as canvasesGet, validate as validateCanvasesGet } from './services/db/canvases-get.js';
import { HANDLER_KIND as canvasesListKind, handle as canvasesList, validate as validateCanvasesList } from './services/db/canvases-list.js';
import { HANDLER_KIND as canvasesRestoreKind, handle as canvasesRestore, validate as validateCanvasesRestore } from './services/db/canvases-restore.js';
import { HANDLER_KIND as canvasesSaveKind, handle as canvasesSave, validate as validateCanvasesSave } from './services/db/canvases-save.js';
import { HANDLER_KIND as canvasesSoftDeleteKind, handle as canvasesSoftDelete, validate as validateCanvasesSoftDelete } from './services/db/canvases-soft-delete.js';
import { HANDLER_KIND as compactionsInsertKind, handle as compactionsInsert, validate as validateCompactionsInsert } from './services/db/compactions-insert.js';
import { HANDLER_KIND as compactionsListByConversationKind, handle as compactionsListByConversation, validate as validateCompactionsListByConversation } from './services/db/compactions-list-by-conversation.js';
import { HANDLER_KIND as conversationsCreateKind, handle as conversationsCreate, validate as validateConversationsCreate } from './services/db/conversations-create.js';
import { HANDLER_KIND as conversationsDeleteKind, handle as conversationsDelete, validate as validateConversationsDelete } from './services/db/conversations-delete.js';
import { HANDLER_KIND as conversationsGetKind, handle as conversationsGet, validate as validateConversationsGet } from './services/db/conversations-get.js';
import { HANDLER_KIND as conversationsListKind, handle as conversationsList, validate as validateConversationsList } from './services/db/conversations-list.js';
import { HANDLER_KIND as conversationsUpdateKind, handle as conversationsUpdate, validate as validateConversationsUpdate } from './services/db/conversations-update.js';
import { HANDLER_KIND as imageCacheGetKind, handle as imageCacheGet, validate as validateImageCacheGet } from './services/db/image-cache-get.js';
import { HANDLER_KIND as imageCachePutKind, handle as imageCachePut, validate as validateImageCachePut } from './services/db/image-cache-put.js';
import { HANDLER_KIND as memoriesCreateKind, handle as memoriesCreate, validate as validateMemoriesCreate } from './services/db/memories-create.js';
import { HANDLER_KIND as memoriesDeleteKind, handle as memoriesDelete, validate as validateMemoriesDelete } from './services/db/memories-delete.js';
import { HANDLER_KIND as memoriesGetKind, handle as memoriesGet, validate as validateMemoriesGet } from './services/db/memories-get.js';
import { HANDLER_KIND as memoriesListKind, handle as memoriesList, validate as validateMemoriesList } from './services/db/memories-list.js';
import { HANDLER_KIND as memoriesStatsKind, handle as memoriesStats, validate as validateMemoriesStats } from './services/db/memories-stats.js';
import { HANDLER_KIND as memoriesUpdateKind, handle as memoriesUpdate, validate as validateMemoriesUpdate } from './services/db/memories-update.js';
import { HANDLER_KIND as messagesAppendKind, handle as messagesAppend, validate as validateMessagesAppend } from './services/db/messages-append.js';
import { HANDLER_KIND as messagesDeleteKind, handle as messagesDelete, validate as validateMessagesDelete } from './services/db/messages-delete.js';
import { HANDLER_KIND as messagesGetKind, handle as messagesGet, validate as validateMessagesGet } from './services/db/messages-get.js';
import { HANDLER_KIND as messagesListByConversationKind, handle as messagesListByConversation, validate as validateMessagesListByConversation } from './services/db/messages-list-by-conversation.js';
import { HANDLER_KIND as messagesListByTagKind, handle as messagesListByTag, validate as validateMessagesListByTag } from './services/db/messages-list-by-tag.js';
import { HANDLER_KIND as messagesUpdateKind, handle as messagesUpdate, validate as validateMessagesUpdate } from './services/db/messages-update.js';
import { HANDLER_KIND as policyGetKind, handle as policyGet, validate as validatePolicyGet } from './services/db/policy-get.js';
import { HANDLER_KIND as policyPutKind, handle as policyPut, validate as validatePolicyPut } from './services/db/policy-put.js';

export interface AppDeps {
  config: ServerConfig;
  pool: HealthDbPool | null;
  version: string;
  // Injected by the auth worker. When absent, the deny-by-default
  // stubs in middleware/auth-hook.ts apply (401 for protected routes,
  // 403 for authenticated mutations). Never allow-by-default.
  verifySession?: VerifySessionFn;
  verifyCsrf?: VerifyCsrfTokenFn;
  verifyOrigin?: VerifyOriginFn;
  // Auth context injected by the auth worker (V3-01, AD-40). When
  // present, the auth route block below is registered and the
  // session/CSRF verifiers are derived from it, unless explicit
  // verifiers above are also given (explicit wins, so foundation
  // tests keep injecting stubs). When absent, no auth route exists
  // and the foundation deny-by-default behavior is unchanged.
  // server.ts injects the production context; tests inject a context
  // built with a fake store. One context feeds one app: buildApp
  // closes it on app.close().
  auth?: AuthContext;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: buildLoggerOptions(deps.config.logLevel),
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: deps.config.maxBodyBytes,
    genReqId: (request) => requestIdFromHeaders(request.headers),
  });

  registerRequestId(app);
  registerErrorHandling(app, { version: deps.version });
  // Resolve the verifiers before the hooks: explicit injections win,
  // then verifiers derived from the injected auth context, then the
  // deny-by-default stubs inside registerAuthHooks (undefined here).
  // verifyOrigin is never derived: the hook's default Origin matcher
  // applies when no explicit verifier is given.
  const verifySession = deps.verifySession ?? (deps.auth === undefined ? undefined : createSessionVerifier(deps.auth));
  const verifyCsrf = deps.verifyCsrf ?? (deps.auth === undefined ? undefined : createCsrfVerifier(deps.auth));
  registerAuthHooks(app, {
    verifySession,
    verifyCsrf,
    verifyOrigin: deps.verifyOrigin,
    canonicalOrigin: deps.config.publicBaseUrl,
  });

  // Route blocks, in contract order (AD-40): one commented block per
  // group. Later route workers add only their own block, in contract
  // order, and never reorder the middleware above (pattern N-2).
  // --- Health (kontrak 3.14) ---
  await registerHealthRoutes(app, {
    pool: deps.pool,
    workspaceRoot: deps.config.workspaceRoot,
    version: deps.version,
    checkTimeoutMs: deps.config.checkTimeoutMs,
    overallTimeoutMs: deps.config.overallTimeoutMs,
  });

  // --- Auth core (kontrak 3.12; V3-01) ---
  if (deps.auth !== undefined) {
    const auth = deps.auth;
    await registerAuthCoreRoutes(app, { auth });
    app.addHook('onClose', async () => {
      await auth.close();
    });
  }

  // Workspace files, read side (V3-04a, kontrak 3.1): GET list, GET
  // and HEAD file, GET scan, GET stat. Write, move, trash, media,
  // and reconcile routes are registered by their own groups in
  // their own commented blocks. No AppDeps field is added here: the
  // read routes take the workspace root from config, and the
  // revision workspace key defaults to the resolved root until the
  // index worker injects the workspace UUID (desain assumption A1).
  await registerWorkspaceReadRoutes(app, {
    workspaceRoot: deps.config.workspaceRoot,
  });

  // Workspace files, write side (V3-04b, kontrak 3.1): PUT file,
  // append, patch, media. The V3-04a path/revision modules are
  // wired through the write-adapter ports (same workspace key
  // default as the read side); the index, event, and idempotency
  // ports stay unwired until their workers land, so writes succeed
  // with null versions and no key replay, exactly as the port
  // contract documents. No resolveIdentity yet: the
  // session-to-workspace mapping is future work.
  await registerWorkspaceWriteRoutes(app, {
    ports: createV304aWritePorts(deps.config.workspaceRoot),
  });

  // Settings and secrets routes (V3-10a; kontrak-api-kanonis.md 3.2-3.3).
  // One commented block per group (AD-40 pattern), in merge order.
  // The secret cipher is wired by V3-10b: with ENCRYPTION_KEY set
  // the real adapter seals secrets; without it, secret writes fail
  // closed with 503 (see services/settings/crypto-seam.ts). This
  // block only adds routes; it does not change the frozen
  // middleware shape (AD-40) or AppDeps.
  const settingsDeps = createProductionSettingsDeps();
  await registerSettingsRoutes(app, settingsDeps);
  await registerSecretsRoutes(app, settingsDeps);

  // Db/transactions routes (V3-13a; kontrak-api-kanonis.md section
  // 3.4): POST /api/transactions and POST /api/db/batch. One
  // commented block per group (AD-40 pattern), in merge order.
  // Kind handlers are registered into dbDeps.registry by the
  // handler workers (see services/db/registry.ts); until they land,
  // unregistered W1 kinds answer 500 and W2 kinds answer 410,
  // never fake success.
  const dbDeps = createDefaultDbRouteDeps(deps.config);
  // Register V3-13b handlers (kinds owned by V3-13b per
  // fase1/pembagian-handler-kind.md). Unregistered kinds keep
  // answering 500 (W1) / 410 (W2) until their merge lands.
  dbDeps.registry.registerWrite(canvasesCreateKind, { validate: validateCanvasesCreate, handle: canvasesCreate });
  dbDeps.registry.registerRead(canvasesGetKind, { validate: validateCanvasesGet, handle: canvasesGet });
  dbDeps.registry.registerRead(canvasesListKind, { validate: validateCanvasesList, handle: canvasesList });
  dbDeps.registry.registerWrite(canvasesRestoreKind, { validate: validateCanvasesRestore, handle: canvasesRestore });
  dbDeps.registry.registerWrite(canvasesSaveKind, { validate: validateCanvasesSave, handle: canvasesSave });
  dbDeps.registry.registerWrite(canvasesSoftDeleteKind, { validate: validateCanvasesSoftDelete, handle: canvasesSoftDelete });
  dbDeps.registry.registerWrite(compactionsInsertKind, { validate: validateCompactionsInsert, handle: compactionsInsert });
  dbDeps.registry.registerRead(compactionsListByConversationKind, { validate: validateCompactionsListByConversation, handle: compactionsListByConversation });
  dbDeps.registry.registerWrite(conversationsCreateKind, { validate: validateConversationsCreate, handle: conversationsCreate });
  dbDeps.registry.registerWrite(conversationsDeleteKind, { validate: validateConversationsDelete, handle: conversationsDelete });
  dbDeps.registry.registerRead(conversationsGetKind, { validate: validateConversationsGet, handle: conversationsGet });
  dbDeps.registry.registerRead(conversationsListKind, { validate: validateConversationsList, handle: conversationsList });
  dbDeps.registry.registerWrite(conversationsUpdateKind, { validate: validateConversationsUpdate, handle: conversationsUpdate });
  dbDeps.registry.registerRead(imageCacheGetKind, { validate: validateImageCacheGet, handle: imageCacheGet });
  dbDeps.registry.registerWrite(imageCachePutKind, { validate: validateImageCachePut, handle: imageCachePut });
  dbDeps.registry.registerWrite(memoriesCreateKind, { validate: validateMemoriesCreate, handle: memoriesCreate });
  dbDeps.registry.registerWrite(memoriesDeleteKind, { validate: validateMemoriesDelete, handle: memoriesDelete });
  dbDeps.registry.registerRead(memoriesGetKind, { validate: validateMemoriesGet, handle: memoriesGet });
  dbDeps.registry.registerRead(memoriesListKind, { validate: validateMemoriesList, handle: memoriesList });
  dbDeps.registry.registerRead(memoriesStatsKind, { validate: validateMemoriesStats, handle: memoriesStats });
  dbDeps.registry.registerWrite(memoriesUpdateKind, { validate: validateMemoriesUpdate, handle: memoriesUpdate });
  dbDeps.registry.registerWrite(messagesAppendKind, { validate: validateMessagesAppend, handle: messagesAppend });
  dbDeps.registry.registerWrite(messagesDeleteKind, { validate: validateMessagesDelete, handle: messagesDelete });
  dbDeps.registry.registerRead(messagesGetKind, { validate: validateMessagesGet, handle: messagesGet });
  dbDeps.registry.registerRead(messagesListByConversationKind, { validate: validateMessagesListByConversation, handle: messagesListByConversation });
  dbDeps.registry.registerRead(messagesListByTagKind, { validate: validateMessagesListByTag, handle: messagesListByTag });
  dbDeps.registry.registerWrite(messagesUpdateKind, { validate: validateMessagesUpdate, handle: messagesUpdate });
  dbDeps.registry.registerRead(policyGetKind, { validate: validatePolicyGet, handle: policyGet });
  dbDeps.registry.registerWrite(policyPutKind, { validate: validatePolicyPut, handle: policyPut });
  await registerDbRoutes(app, dbDeps);

  return app;
}
