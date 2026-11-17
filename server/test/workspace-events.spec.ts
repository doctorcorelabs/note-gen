// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Workspace events WebSocket route over live sockets (W4-WIRE,
// V3-08 part 2, desain 9.2-9.4). The Node global WebSocket
// client cannot set a Cookie header, so these specs speak raw
// TCP: handshake bytes, masked client frames, and unmasked
// server-frame parsing. The first section drives the route
// module on a standalone app with a stub verifier; the last
// section drives the rank-160 adapter through buildApp with a
// real auth context and a seeded session.

import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { hashToken } from '../src/auth/crypto.js';
import type { VerifySessionFn } from '../src/middleware/auth-hook.js';
import { ApiError } from '../src/plugins/envelope.js';
import {
  registerWorkspaceEventsRoutes,
  WORKSPACE_EVENTS_PATH,
  type WorkspaceEventsHandle,
} from '../src/routes/workspace-events.js';
import { CANONICAL_ORIGIN, makeTestAuth, testConfig, TEST_NOW_MS } from './auth/helpers.js';

const TEST_ORIGIN = 'https://app.example.invalid';

function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const length = payload.length;
  let headerLength = 2;
  if (length > 65535) {
    headerLength += 8;
  } else if (length > 125) {
    headerLength += 2;
  }
  const frame = Buffer.alloc(headerLength + 4 + length);
  frame[0] = (fin ? 0x80 : 0x00) | opcode;
  if (length <= 125) {
    frame[1] = 0x80 | length;
  } else if (length <= 65535) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  mask.copy(frame, headerLength);
  for (let i = 0; i < length; i += 1) {
    frame[headerLength + 4 + i] = (payload[i] as number) ^ (mask[i % 4] as number);
  }
  return frame;
}

interface ServerFrame {
  opcode: number;
  payload: Buffer;
}

class RawWsClient {
  readonly socket: Socket;
  #buffer: Buffer = Buffer.alloc(0);
  #waiters: ((chunk: Buffer) => void)[] = [];
  #closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const waiter of waiters) {
        waiter(this.#buffer);
      }
    });
    socket.on('close', () => {
      this.#closed = true;
    });
  }

  static async connect(port: number): Promise<RawWsClient> {
    const socket = connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    return new RawWsClient(socket);
  }

  get closed(): boolean {
    return this.#closed;
  }

  async handshake(
    path: string,
    headers: Record<string, string>,
    options: { includeKey?: boolean; version?: string } = {},
  ): Promise<number> {
    const key = randomBytes(16).toString('base64');
    const lines = [`GET ${path} HTTP/1.1`, 'Host: 127.0.0.1'];
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`);
    }
    lines.push('Upgrade: websocket', 'Connection: Upgrade');
    if (options.includeKey !== false) {
      lines.push(`Sec-WebSocket-Key: ${key}`);
    }
    lines.push(`Sec-WebSocket-Version: ${options.version ?? '13'}`, '', '');
    this.socket.write(lines.join('\r\n'));
    const head = await this.#readUntil(Buffer.from('\r\n\r\n'));
    const statusLine = head.toString('utf8').split('\r\n')[0] as string;
    const status = Number(statusLine.split(' ')[1]);
    return status;
  }

  async #readUntil(marker: Buffer, timeoutMs = 3000): Promise<Buffer> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.#buffer.indexOf(marker);
      if (index >= 0) {
        const out = this.#buffer.subarray(0, index + marker.length);
        this.#buffer = this.#buffer.subarray(index + marker.length);
        return out;
      }
      if (this.#closed) {
        throw new Error('Socket closed while waiting for data.');
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for socket data.');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  async readFrame(timeoutMs = 3000): Promise<ServerFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parsed = this.#tryParseFrame();
      if (parsed !== undefined) {
        return parsed;
      }
      if (this.#closed) {
        throw new Error('Socket closed while waiting for a frame.');
      }
      if (Date.now() > deadline) {
        throw new Error('Timed out waiting for a frame.');
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.#waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  #tryParseFrame(): ServerFrame | undefined {
    if (this.#buffer.length < 2) {
      return undefined;
    }
    const opcode = (this.#buffer[0] as number) & 0x0f;
    const masked = ((this.#buffer[1] as number) & 0x80) !== 0;
    if (masked) {
      throw new Error('Server frames must not be masked.');
    }
    let length = (this.#buffer[1] as number) & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (this.#buffer.length < 4) {
        return undefined;
      }
      length = this.#buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (length === 127) {
      if (this.#buffer.length < 10) {
        return undefined;
      }
      length = Number(this.#buffer.readBigUInt64BE(2));
      headerLength = 10;
    }
    if (this.#buffer.length < headerLength + length) {
      return undefined;
    }
    const payload = this.#buffer.subarray(headerLength, headerLength + length);
    this.#buffer = this.#buffer.subarray(headerLength + length);
    return { opcode, payload: Buffer.from(payload) };
  }

  async readMessage(timeoutMs = 3000): Promise<Record<string, unknown>> {
    const frame = await this.readFrame(timeoutMs);
    expect(frame.opcode).toBe(1);
    return JSON.parse(frame.payload.toString('utf8')) as Record<string, unknown>;
  }

  sendText(text: string): void {
    this.socket.write(maskedFrame(1, Buffer.from(text, 'utf8')));
  }

  sendPing(payload: Buffer = Buffer.alloc(0)): void {
    this.socket.write(maskedFrame(9, payload));
  }

  sendClose(code = 1000): void {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.socket.write(maskedFrame(8, payload));
  }

  sendRaw(buffer: Buffer): void {
    this.socket.write(buffer);
  }

  destroy(): void {
    this.socket.destroy();
  }
}

interface StandaloneFixture {
  app: FastifyInstance;
  handle: WorkspaceEventsHandle;
  port: number;
  clients: RawWsClient[];
}

const fixtures: StandaloneFixture[] = [];

async function setupStandalone(verifySession: VerifySessionFn): Promise<StandaloneFixture> {
  const app = Fastify({ logger: false });
  const handle = await registerWorkspaceEventsRoutes(app, {
    verifySession,
    canonicalOrigin: TEST_ORIGIN,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP listen address.');
  }
  const fixture: StandaloneFixture = { app, handle, port: address.port, clients: [] };
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  while (fixtures.length > 0) {
    const fixture = fixtures.pop() as StandaloneFixture;
    for (const client of fixture.clients) {
      client.destroy();
    }
    await fixture.handle.close();
    await fixture.app.close();
  }
});

const stubVerifier: VerifySessionFn = async ({ sessionId }) => {
  if (sessionId === 'good-session') {
    return { userId: 'user-1', role: 'user', sessionId: 'sess-1' };
  }
  if (sessionId === 'other-session') {
    return { userId: 'user-2', role: 'user', sessionId: 'sess-2' };
  }
  return null;
};

async function openClient(
  fixture: StandaloneFixture,
  sessionId: string,
  extraHeaders: Record<string, string> = {},
): Promise<RawWsClient> {
  const client = await RawWsClient.connect(fixture.port);
  fixture.clients.push(client);
  const status = await client.handshake(WORKSPACE_EVENTS_PATH, {
    Origin: TEST_ORIGIN,
    Cookie: `notegen_session=${sessionId}`,
    ...extraHeaders,
  });
  expect(status).toBe(101);
  return client;
}

describe('workspace events handshake', () => {
  it('upgrades an authenticated handshake and speaks hello first', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    const hello = await client.readMessage();
    expect(hello['type']).toBe('hello');
    expect(hello['protocolVersion']).toBe(1);
    expect(hello['workspaceRoot']).toBe('default');
    expect(hello['lastSeq']).toBe(0);
    expect(typeof hello['connectionId']).toBe('string');
    expect((hello['connectionId'] as string).length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(hello['serverTime'] as string))).toBe(false);
  });

  it('answers 401 without a session and ignores query-string tokens', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const noCookie = await RawWsClient.connect(fixture.port);
    fixture.clients.push(noCookie);
    expect(await noCookie.handshake(WORKSPACE_EVENTS_PATH, { Origin: TEST_ORIGIN })).toBe(401);
    const queryToken = await RawWsClient.connect(fixture.port);
    fixture.clients.push(queryToken);
    expect(
      await queryToken.handshake(`${WORKSPACE_EVENTS_PATH}?token=good-session`, { Origin: TEST_ORIGIN }),
    ).toBe(401);
    const badSession = await RawWsClient.connect(fixture.port);
    fixture.clients.push(badSession);
    expect(
      await badSession.handshake(WORKSPACE_EVENTS_PATH, {
        Origin: TEST_ORIGIN,
        Cookie: 'notegen_session=nope',
      }),
    ).toBe(401);
  });

  it('answers 403 for a mismatched or absent Origin', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const wrong = await RawWsClient.connect(fixture.port);
    fixture.clients.push(wrong);
    expect(
      await wrong.handshake(WORKSPACE_EVENTS_PATH, {
        Origin: 'https://evil.example.invalid',
        Cookie: 'notegen_session=good-session',
      }),
    ).toBe(403);
    const absent = await RawWsClient.connect(fixture.port);
    fixture.clients.push(absent);
    expect(
      await absent.handshake(WORKSPACE_EVENTS_PATH, { Cookie: 'notegen_session=good-session' }),
    ).toBe(403);
  });

  it('answers 400 for an upgrade missing the WebSocket key or version, and 404 for other paths', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const noKey = await RawWsClient.connect(fixture.port);
    fixture.clients.push(noKey);
    expect(
      await noKey.handshake(
        WORKSPACE_EVENTS_PATH,
        { Origin: TEST_ORIGIN, Cookie: 'notegen_session=good-session' },
        { includeKey: false },
      ),
    ).toBe(400);
    const wrongVersion = await RawWsClient.connect(fixture.port);
    fixture.clients.push(wrongVersion);
    expect(
      await wrongVersion.handshake(
        WORKSPACE_EVENTS_PATH,
        { Origin: TEST_ORIGIN, Cookie: 'notegen_session=good-session' },
        { version: '12' },
      ),
    ).toBe(400);
    const other = await RawWsClient.connect(fixture.port);
    fixture.clients.push(other);
    expect(
      await other.handshake('/api/other', {
        Origin: TEST_ORIGIN,
        Cookie: 'notegen_session=good-session',
      }),
    ).toBe(404);
  });

  it('answers 503 when the verifier throws service_unavailable', async () => {
    const fixture = await setupStandalone(async () => {
      throw ApiError.serviceUnavailable('The database is not available.');
    });
    const client = await RawWsClient.connect(fixture.port);
    fixture.clients.push(client);
    expect(
      await client.handshake(WORKSPACE_EVENTS_PATH, {
        Origin: TEST_ORIGIN,
        Cookie: 'notegen_session=good-session',
      }),
    ).toBe(503);
  });
});

describe('workspace events protocol', () => {
  it('answers app-level ping with pong and resync with resync-ok', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    client.sendText(JSON.stringify({ type: 'ping' }));
    const pong = await client.readMessage();
    expect(pong['type']).toBe('pong');
    client.sendText(JSON.stringify({ type: 'resync', sinceSeq: 0 }));
    const ok = await client.readMessage();
    expect(ok).toEqual({ type: 'resync-ok', lastSeq: 0 });
  });

  it('answers malformed messages with error and closes with 1008 at the fifth', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    for (let i = 0; i < 4; i += 1) {
      client.sendText('not json{');
      const error = await client.readMessage();
      expect(error['type']).toBe('error');
      expect(error['code']).toBe('malformed_message');
    }
    client.sendText('still not json{');
    const lastError = await client.readMessage();
    expect(lastError['code']).toBe('malformed_message');
    const close = await client.readFrame();
    expect(close.opcode).toBe(8);
    expect(close.payload.readUInt16BE(0)).toBe(1008);
  });

  it('answers unknown types with error and keeps the connection open', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    client.sendText(JSON.stringify({ type: 'subscribe', channel: 'x' }));
    const error = await client.readMessage();
    expect(error['type']).toBe('error');
    expect(error['code']).toBe('unknown_message_type');
    client.sendText(JSON.stringify({ type: 'ping' }));
    const pong = await client.readMessage();
    expect(pong['type']).toBe('pong');
  });

  it('answers RFC ping frames with pong frames carrying the payload', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    client.sendPing(Buffer.from('hb', 'utf8'));
    const pong = await client.readFrame();
    expect(pong.opcode).toBe(10);
    expect(pong.payload.toString('utf8')).toBe('hb');
  });

  it('echoes a close frame and ends the socket', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    client.sendClose(1000);
    const close = await client.readFrame();
    expect(close.opcode).toBe(8);
    expect(close.payload.readUInt16BE(0)).toBe(1000);
  });

  it('reassembles a fragmented text message', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const client = await openClient(fixture, 'good-session');
    await client.readMessage();
    const text = JSON.stringify({ type: 'ping' });
    const firstHalf = Buffer.from(text.slice(0, 6), 'utf8');
    const secondHalf = Buffer.from(text.slice(6), 'utf8');
    client.sendRaw(maskedFrame(1, firstHalf, false));
    client.sendRaw(maskedFrame(0, secondHalf, true));
    const pong = await client.readMessage();
    expect(pong['type']).toBe('pong');
  });

  it('fans published events out to the same user only', async () => {
    const fixture = await setupStandalone(stubVerifier);
    const first = await openClient(fixture, 'good-session');
    const second = await openClient(fixture, 'good-session');
    const other = await openClient(fixture, 'other-session');
    await first.readMessage();
    await second.readMessage();
    await other.readMessage();
    await fixture.handle.hub.publish('user-1', {
      kind: 'created',
      path: 'notes/a.md',
      previousPath: null,
      workspaceRoot: 'default',
      revision: 'r1',
      modifiedAt: '2026-11-17T14:00:00.000Z',
      isDirectory: false,
      actor: 'self',
      originConnectionId: null,
    });
    const eventFirst = await first.readMessage();
    expect(eventFirst['type']).toBe('workspace-file-changed');
    expect(eventFirst['seq']).toBe(1);
    expect(eventFirst['path']).toBe('notes/a.md');
    const eventSecond = await second.readMessage();
    expect(eventSecond['seq']).toBe(1);
    await expect(other.readFrame(300)).rejects.toThrow('Timed out');
  });

  it('replays buffered events on resync and then answers resync-ok', async () => {
    const fixture = await setupStandalone(stubVerifier);
    await fixture.handle.hub.publish('user-1', {
      kind: 'created',
      path: 'notes/a.md',
      previousPath: null,
      workspaceRoot: 'default',
      revision: 'r1',
      modifiedAt: '2026-11-17T14:00:00.000Z',
      isDirectory: false,
      actor: 'system',
      originConnectionId: null,
    });
    const client = await openClient(fixture, 'good-session');
    const hello = await client.readMessage();
    expect(hello['lastSeq']).toBe(1);
    client.sendText(JSON.stringify({ type: 'resync', sinceSeq: 0 }));
    const batch = await client.readMessage();
    expect(batch['type']).toBe('batch');
    expect((batch['events'] as { seq: number }[]).map((event) => event.seq)).toEqual([1]);
    const ok = await client.readMessage();
    expect(ok).toEqual({ type: 'resync-ok', lastSeq: 1 });
  });
});

describe('workspace events through buildApp (adapter rank 160)', () => {
  it('upgrades a handshake verified against a real auth context', async () => {
    const { auth, store, clock } = makeTestAuth();
    const { userId } = await store.createFirstAccount({
      email: 'ws@example.invalid',
      passwordHash: 'test-hash',
      workspaceName: 'main',
      now: new Date(TEST_NOW_MS),
      ip: null,
      userAgent: null,
    });
    await store.createSession({
      userId,
      sessionHash: hashToken('live-session-id'),
      csrfTokenHash: 'csrf-hash',
      credentialEpoch: 1,
      deviceLabel: 'test',
      userAgent: null,
      createdIp: null,
      lastSeenIp: null,
      createdAt: new Date(TEST_NOW_MS),
      lastSeenAt: new Date(TEST_NOW_MS),
      absoluteExpiresAt: new Date(TEST_NOW_MS + 24 * 60 * 60 * 1000),
      stepUpAt: null,
    });
    void clock;
    const app = await buildApp({
      config: testConfig({ workspaceRoot: '/tmp' }),
      pool: null,
      version: 'test',
      auth,
    });
    try {
      await app.listen({ port: 0, host: '127.0.0.1' });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected a TCP listen address.');
      }
      const client = await RawWsClient.connect(address.port);
      try {
        const status = await client.handshake(WORKSPACE_EVENTS_PATH, {
          Origin: CANONICAL_ORIGIN,
          Cookie: 'notegen_session=live-session-id',
        });
        expect(status).toBe(101);
        const hello = await client.readMessage();
        expect(hello['type']).toBe('hello');
      } finally {
        client.destroy();
      }
    } finally {
      await app.close();
    }
  });
});
