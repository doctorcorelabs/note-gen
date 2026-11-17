// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace events WebSocket route (W4-WIRE, V3-08 part 2,
// desain sections 9.2-9.4): GET /api/workspace/events,
// upgraded to a WebSocket. The only contract route that is
// not HTTP (86 = 85 HTTP + 1 WS, AD-114).
//
// Handshake (desain 9.2), all checks BEFORE the upgrade:
// 1. The path must match exactly; anything else on the upgrade
//    listener answers 404 (this is the only upgrade consumer
//    in the app, so an unmatched upgrade is a client error,
//    not a handoff to another handler).
// 2. RFC 6455 headers: Upgrade/Connection tokens,
//    Sec-WebSocket-Key present, version 13. Missing or wrong
//    answers 400.
// 3. Origin must equal the canonical origin exactly (403 when
//    mismatched or absent; browser-only rule, enforced for
//    every handshake because the session cookie is ambient).
// 4. The session cookie is verified with the same verifier
//    the HTTP auth hook uses. No session, unknown session,
//    expired, or revoked answers 401 with the same generic
//    response; a verifier that throws 503 (cannot verify)
//    answers 503. Query-string tokens are never read: cookie
//    only, and the query string is ignored entirely.
//
// After the 101 response the server speaks first with `hello`
// (buildHello), then serves the watcher protocol over the
// frame codec in ws-codec.ts: app-level ping/pong, resync
// replay from the hub ring buffer, the malformed-message
// policy (error + close 1008 at 5 in 60 seconds), unknown
// types answered with `error` and ignored, RFC-level ping
// every 30 seconds with a 60-second idle close (1001).
//
// Shutdown: upgraded sockets are invisible to Fastify's
// connection tracking, and server.close() waits for open
// connections while the onClose hooks (including the shared
// close registry) run only after it. Destroying the sockets
// from an onClose hook therefore deadlocks app.close(). The
// cleanup MUST run from a preClose hook, which Fastify runs
// before server.close(). The returned handle's close() runs
// the same idempotent shutdown for standalone/test use and
// for the close-registry step the adapter appends.
//
// No producer is wired in this slot: the hub buffer stays
// empty and every resync answers resync-ok with no events
// until the watcher/write-path work publishes. Connections
// are scoped by userId in the hub, never broadcast across
// accounts.
//
// Transport note: the frame codec is hand-rolled RFC 6455
// (ws-codec.ts) instead of a new `ws` dependency. The
// protocol surface is small and fully spec-covered, and the
// handshake/auth/hub logic is identical either way; a new
// dependency would only buy the codec while adding lockfile
// churn and install risk to every gate. If the protocol grows
// (extensions, backpressure), revisit with a dependency.

import { createHash, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  matchCanonicalOrigin,
  parseSessionCookieId,
  type VerifySessionFn,
} from '../middleware/auth-hook.js';
import { ApiError } from '../plugins/envelope.js';
import { WorkspaceEventsHub, type HubConnection } from '../services/workspace/events-hub.js';
import {
  buildError,
  buildHello,
  buildPong,
  buildResyncOk,
  buildResyncRequired,
  chunkEvents,
  ERROR_CODE_MALFORMED_MESSAGE,
  ERROR_CODE_UNKNOWN_MESSAGE_TYPE,
  HEARTBEAT_INTERVAL_MS,
  CLIENT_IDLE_TIMEOUT_MS,
  MalformedTracker,
  parseClientMessage,
  WATCHER_CLOSE_CODES,
  WATCHER_WORKSPACE_ROOT_DEFAULT,
  type ServerMessage,
} from '../services/workspace/watcher-protocol.js';
import {
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  WebSocketFrameParser,
  WS_CLOSE_GOING_AWAY,
  WS_OP_PING,
  WS_OP_PONG,
  WsProtocolError,
} from '../services/workspace/ws-codec.js';

export const WORKSPACE_EVENTS_PATH = '/api/workspace/events';

const WS_ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CLOSE_FLUSH_TIMEOUT_MS = 5000;

export interface WorkspaceEventsRouteDeps {
  verifySession: VerifySessionFn;
  canonicalOrigin: string | undefined;
  hub?: WorkspaceEventsHub;
  clock?: () => number;
}

export interface WorkspaceEventsHandle {
  hub: WorkspaceEventsHub;
  close(): Promise<void>;
}

const REGISTERED_APPS = new WeakSet<FastifyInstance>();

function computeAcceptKey(key: string): string {
  return createHash('sha1').update(key + WS_ACCEPT_GUID, 'utf8').digest('base64');
}

function hasToken(header: string | string[] | undefined, token: string): boolean {
  if (header === undefined) {
    return false;
  }
  const values = Array.isArray(header) ? header : [header];
  return values.some((value) =>
    value
      .split(',')
      .map((part) => part.trim().toLowerCase())
      .includes(token),
  );
}

function rejectUpgrade(socket: Socket, status: number, reason: string): void {
  try {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {
    // The socket is already gone; destroying is still safe.
  }
  socket.destroy();
}

class WsConnection implements HubConnection {
  readonly connectionId: string;
  readonly userId: string;
  readonly #socket: Socket;
  readonly #hub: WorkspaceEventsHub;
  readonly #parser = new WebSocketFrameParser();
  readonly #malformed = new MalformedTracker();
  readonly #clock: () => number;
  readonly #onDone: () => void;
  #heartbeat: NodeJS.Timeout | undefined;
  #lastActivityMs: number;
  #closed = false;
  #closeTimer: NodeJS.Timeout | undefined;

  constructor(input: {
    socket: Socket;
    hub: WorkspaceEventsHub;
    userId: string;
    connectionId: string;
    clock: () => number;
    head: Buffer;
    onDone: () => void;
  }) {
    this.#socket = input.socket;
    this.#hub = input.hub;
    this.userId = input.userId;
    this.connectionId = input.connectionId;
    this.#clock = input.clock;
    this.#onDone = input.onDone;
    this.#lastActivityMs = input.clock();
    this.#socket.on('data', (chunk: Buffer) => this.#onData(chunk));
    this.#socket.on('close', () => this.#cleanup());
    this.#socket.on('error', () => this.#cleanup());
    this.#heartbeat = setInterval(() => this.#beat(), HEARTBEAT_INTERVAL_MS);
    this.#heartbeat.unref();
    this.send(
      buildHello({
        workspaceRoot: WATCHER_WORKSPACE_ROOT_DEFAULT,
        serverTime: new Date(input.clock()).toISOString(),
        lastSeq: this.#hub.lastSeq,
        connectionId: this.connectionId,
      }),
    );
    if (input.head.length > 0) {
      this.#onData(input.head);
    }
  }

  send(message: ServerMessage): void {
    if (this.#closed || this.#socket.destroyed) {
      return;
    }
    try {
      this.#socket.write(encodeTextFrame(JSON.stringify(message)));
    } catch {
      this.#cleanup();
    }
  }

  close(code: number, reason = ''): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    try {
      this.#socket.write(encodeCloseFrame(code, reason));
    } catch {
      // Fall through to destroy below.
    }
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), CLOSE_FLUSH_TIMEOUT_MS);
    this.#closeTimer.unref();
    this.#socket.end();
  }

  destroy(): void {
    this.#closed = true;
    this.#socket.destroy();
  }

  #beat(): void {
    if (this.#closed || this.#socket.destroyed) {
      return;
    }
    if (this.#clock() - this.#lastActivityMs > CLIENT_IDLE_TIMEOUT_MS) {
      this.close(WS_CLOSE_GOING_AWAY, 'idle timeout');
      return;
    }
    try {
      this.#socket.write(encodeFrame(WS_OP_PING, Buffer.alloc(0)));
    } catch {
      this.#cleanup();
    }
  }

  #onData(chunk: Buffer): void {
    if (this.#closed) {
      return;
    }
    this.#lastActivityMs = this.#clock();
    let frames;
    try {
      frames = this.#parser.push(chunk);
    } catch (error) {
      if (error instanceof WsProtocolError) {
        this.close(error.closeCode, error.message);
        return;
      }
      this.close(WATCHER_CLOSE_CODES.INTERNAL_ERROR, 'internal error');
      return;
    }
    for (const frame of frames) {
      if (this.#closed) {
        return;
      }
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: ReturnType<WebSocketFrameParser['push']>[number]): void {
    switch (frame.kind) {
      case 'ping': {
        try {
          this.#socket.write(encodeFrame(WS_OP_PONG, frame.payload));
        } catch {
          this.#cleanup();
        }
        return;
      }
      case 'pong':
        return;
      case 'close': {
        this.close(frame.code ?? WS_CLOSE_GOING_AWAY, frame.reason);
        return;
      }
      case 'binary': {
        this.#countMalformed('binary frames are not part of the watcher protocol');
        return;
      }
      case 'text': {
        const parsed = parseClientMessage(frame.payload.toString('utf8'));
        if (parsed.outcome === 'malformed') {
          this.#countMalformed(parsed.errors.join('; '));
          return;
        }
        if (parsed.outcome === 'unknown-type') {
          this.send(buildError(ERROR_CODE_UNKNOWN_MESSAGE_TYPE, parsed.errors.join('; ')));
          return;
        }
        if (parsed.message.type === 'ping') {
          this.send(buildPong(new Date(this.#clock()).toISOString()));
          return;
        }
        const replay = this.#hub.buffer.replay(parsed.message.sinceSeq);
        if (replay.outcome === 'resync-required') {
          this.send(buildResyncRequired(replay.lastSeq));
          return;
        }
        for (const batch of chunkEvents(replay.events)) {
          this.send(batch);
        }
        this.send(buildResyncOk(this.#hub.lastSeq));
        return;
      }
    }
  }

  #countMalformed(detail: string): void {
    this.send(buildError(ERROR_CODE_MALFORMED_MESSAGE, detail));
    if (this.#malformed.record(this.#clock())) {
      this.close(WATCHER_CLOSE_CODES.POLICY_VIOLATION, 'too many malformed messages');
    }
  }

  #cleanup(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    if (this.#closeTimer !== undefined) {
      clearTimeout(this.#closeTimer);
      this.#closeTimer = undefined;
    }
    this.#hub.detach(this);
    this.#onDone();
  }
}

export async function registerWorkspaceEventsRoutes(
  app: FastifyInstance,
  deps: WorkspaceEventsRouteDeps,
): Promise<WorkspaceEventsHandle> {
  if (REGISTERED_APPS.has(app)) {
    throw new Error('Workspace events routes are already registered on this app instance.');
  }
  REGISTERED_APPS.add(app);
  const hub = deps.hub ?? new WorkspaceEventsHub();
  const clock = deps.clock ?? Date.now;
  const connections = new Set<WsConnection>();

  async function onUpgrade(request: IncomingMessage, socket: Socket, head: Buffer): Promise<void> {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '', 'http://localhost').pathname;
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (pathname !== WORKSPACE_EVENTS_PATH) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    const headers = request.headers;
    const key = headers['sec-websocket-key'];
    if (
      !hasToken(headers['upgrade'], 'websocket') ||
      !hasToken(headers['connection'], 'upgrade') ||
      typeof key !== 'string' ||
      key === '' ||
      headers['sec-websocket-version'] !== '13'
    ) {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (!matchCanonicalOrigin(headers['origin'], headers['referer'], deps.canonicalOrigin)) {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const stub = { headers, ip: socket.remoteAddress ?? '' } as unknown as FastifyRequest;
    const sessionId = parseSessionCookieId(stub);
    let principal;
    try {
      principal = await deps.verifySession({ request: stub, sessionId });
    } catch (error) {
      if (error instanceof ApiError && error.statusCode === 503) {
        rejectUpgrade(socket, 503, 'Service Unavailable');
        return;
      }
      rejectUpgrade(socket, 500, 'Internal Server Error');
      return;
    }
    if (principal === null) {
      rejectUpgrade(socket, 401, 'Unauthorized');
      return;
    }
    try {
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${computeAcceptKey(key)}\r\n\r\n`,
      );
    } catch {
      socket.destroy();
      return;
    }
    const connection = new WsConnection({
      socket,
      hub,
      userId: principal.userId,
      connectionId: randomUUID(),
      clock,
      head,
      onDone: () => {
        connections.delete(connection);
      },
    });
    connections.add(connection);
    hub.attach(connection);
  }

  const listener = (request: IncomingMessage, socket: Socket, head: Buffer): void => {
    void onUpgrade(request, socket, head);
  };
  app.server.on('upgrade', listener);

  let shutDown = false;
  function shutdown(): void {
    if (shutDown) {
      return;
    }
    shutDown = true;
    app.server.removeListener('upgrade', listener);
    for (const connection of [...connections]) {
      connection.destroy();
    }
    connections.clear();
  }

  // preClose runs before server.close(): the only hook order
  // that can destroy upgraded sockets without deadlocking.
  app.addHook('preClose', async () => {
    shutdown();
  });

  return {
    hub,
    close: async () => {
      shutdown();
    },
  };
}
