// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// Minimal RFC 6455 frame codec for the workspace events
// WebSocket route (W4-WIRE). No WebSocket dependency exists in
// this package, and the protocol surface is small: text
// messages (possibly fragmented), ping/pong, and close. This
// module owns bytes only: it knows nothing about the watcher
// protocol, sessions, or the hub.
//
// Rules enforced here, per RFC 6455:
// - Client frames MUST be masked; an unmasked frame is a
//   protocol error (close 1002).
// - Control frames (close, ping, pong) MUST NOT be fragmented
//   and carry at most 125 bytes of payload.
// - A continuation frame without an open fragmented message,
//   or a new data frame while one is open, is a protocol
//   error (close 1002).
// - Reserved opcodes and the RSV bits are protocol errors.
// - One message larger than WS_MAX_MESSAGE_BYTES closes with
//   1009 (message too big).
// - Server frames are never masked.
//
// The parser is incremental: push() consumes arbitrary TCP
// chunks and returns the complete messages and control frames
// decoded so far, keeping a partial frame buffered.

export const WS_OP_CONTINUATION = 0x0;
export const WS_OP_TEXT = 0x1;
export const WS_OP_BINARY = 0x2;
export const WS_OP_CLOSE = 0x8;
export const WS_OP_PING = 0x9;
export const WS_OP_PONG = 0xa;

export const WS_CLOSE_NORMAL = 1000;
export const WS_CLOSE_GOING_AWAY = 1001;
export const WS_CLOSE_PROTOCOL_ERROR = 1002;
export const WS_CLOSE_MESSAGE_TOO_BIG = 1009;

export const WS_MAX_MESSAGE_BYTES = 1024 * 1024;

export class WsProtocolError extends Error {
  readonly closeCode: number;

  constructor(message: string, closeCode: number = WS_CLOSE_PROTOCOL_ERROR) {
    super(message);
    this.name = 'WsProtocolError';
    this.closeCode = closeCode;
  }
}

export type WsDecodedFrame =
  | { kind: 'text'; payload: Buffer }
  | { kind: 'binary'; payload: Buffer }
  | { kind: 'ping'; payload: Buffer }
  | { kind: 'pong'; payload: Buffer }
  | { kind: 'close'; code: number | undefined; reason: string };

export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  let headerLength = 2;
  if (length > 65535) {
    headerLength += 8;
  } else if (length > 125) {
    headerLength += 2;
  }
  const frame = Buffer.alloc(headerLength + length);
  frame[0] = (fin ? 0x80 : 0x00) | (opcode & 0x0f);
  if (length <= 125) {
    frame[1] = length;
  } else if (length <= 65535) {
    frame[1] = 126;
    frame.writeUInt16BE(length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(length), 2);
  }
  payload.copy(frame, headerLength);
  return frame;
}

export function encodeTextFrame(text: string): Buffer {
  return encodeFrame(WS_OP_TEXT, Buffer.from(text, 'utf8'));
}

export function encodeCloseFrame(code: number, reason = ''): Buffer {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeFrame(WS_OP_CLOSE, payload);
}

export function parseClosePayload(payload: Buffer): { code: number | undefined; reason: string } {
  if (payload.length === 0) {
    return { code: undefined, reason: '' };
  }
  if (payload.length === 1) {
    throw new WsProtocolError('Close payload of one byte is not valid.');
  }
  const code = payload.readUInt16BE(0);
  return { code, reason: payload.subarray(2).toString('utf8') };
}

interface PartialFrame {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payloadLength: number;
  headerLength: number;
}

export class WebSocketFrameParser {
  #buffer: Buffer = Buffer.alloc(0);
  #fragmentOpcode: number | undefined = undefined;
  #fragmentParts: Buffer[] = [];
  #fragmentLength = 0;

  push(chunk: Buffer): WsDecodedFrame[] {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    const frames: WsDecodedFrame[] = [];
    for (;;) {
      const header = this.#readHeader();
      if (header === undefined) {
        return frames;
      }
      const totalLength = header.headerLength + header.payloadLength;
      if (this.#buffer.length < totalLength) {
        return frames;
      }
      const frameBytes = this.#buffer.subarray(0, totalLength);
      this.#buffer = this.#buffer.subarray(totalLength);
      const payload = this.#extractPayload(frameBytes, header);
      const decoded = this.#dispatch(header, payload);
      if (decoded !== undefined) {
        frames.push(decoded);
      }
    }
  }

  #readHeader(): PartialFrame | undefined {
    if (this.#buffer.length < 2) {
      return undefined;
    }
    const first = this.#buffer[0] as number;
    const second = this.#buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    if (rsv !== 0) {
      throw new WsProtocolError('Reserved bits must be zero without negotiated extensions.');
    }
    const opcode = first & 0x0f;
    if (
      opcode !== WS_OP_CONTINUATION &&
      opcode !== WS_OP_TEXT &&
      opcode !== WS_OP_BINARY &&
      opcode !== WS_OP_CLOSE &&
      opcode !== WS_OP_PING &&
      opcode !== WS_OP_PONG
    ) {
      throw new WsProtocolError(`Reserved opcode ${opcode}.`);
    }
    const masked = (second & 0x80) !== 0;
    if (!masked) {
      throw new WsProtocolError('Client frames must be masked.');
    }
    let payloadLength = second & 0x7f;
    let headerLength = 2;
    if (payloadLength === 126) {
      if (this.#buffer.length < 4) {
        return undefined;
      }
      payloadLength = this.#buffer.readUInt16BE(2);
      headerLength = 4;
    } else if (payloadLength === 127) {
      if (this.#buffer.length < 10) {
        return undefined;
      }
      const extended = this.#buffer.readBigUInt64BE(2);
      if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new WsProtocolError('Frame length exceeds the representable range.');
      }
      payloadLength = Number(extended);
      headerLength = 10;
    }
    const isControl = opcode >= WS_OP_CLOSE;
    if (isControl) {
      if (!fin) {
        throw new WsProtocolError('Control frames must not be fragmented.');
      }
      if (payloadLength > 125) {
        throw new WsProtocolError('Control frame payload exceeds 125 bytes.');
      }
    }
    headerLength += 4;
    if (this.#buffer.length < headerLength) {
      return undefined;
    }
    return { fin, opcode, masked, payloadLength, headerLength };
  }

  #extractPayload(frameBytes: Buffer, header: PartialFrame): Buffer {
    const maskStart = header.headerLength - 4;
    const mask = frameBytes.subarray(maskStart, header.headerLength);
    const maskedPayload = frameBytes.subarray(header.headerLength);
    const payload = Buffer.alloc(maskedPayload.length);
    for (let i = 0; i < maskedPayload.length; i += 1) {
      payload[i] = (maskedPayload[i] as number) ^ (mask[i % 4] as number);
    }
    return payload;
  }

  #dispatch(header: PartialFrame, payload: Buffer): WsDecodedFrame | undefined {
    switch (header.opcode) {
      case WS_OP_CLOSE: {
        const parsed = parseClosePayload(payload);
        return { kind: 'close', code: parsed.code, reason: parsed.reason };
      }
      case WS_OP_PING:
        return { kind: 'ping', payload };
      case WS_OP_PONG:
        return { kind: 'pong', payload };
      case WS_OP_CONTINUATION: {
        if (this.#fragmentOpcode === undefined) {
          throw new WsProtocolError('Continuation frame without an open fragmented message.');
        }
        this.#fragmentParts.push(payload);
        this.#fragmentLength += payload.length;
        if (this.#fragmentLength > WS_MAX_MESSAGE_BYTES) {
          throw new WsProtocolError('Message exceeds the size limit.', WS_CLOSE_MESSAGE_TOO_BIG);
        }
        if (!header.fin) {
          return undefined;
        }
        const opcode = this.#fragmentOpcode;
        const complete = Buffer.concat(this.#fragmentParts);
        this.#fragmentOpcode = undefined;
        this.#fragmentParts = [];
        this.#fragmentLength = 0;
        return opcode === WS_OP_TEXT
          ? { kind: 'text', payload: complete }
          : { kind: 'binary', payload: complete };
      }
      default: {
        // Text or binary data frame.
        if (this.#fragmentOpcode !== undefined) {
          throw new WsProtocolError('New data frame while a fragmented message is open.');
        }
        if (payload.length > WS_MAX_MESSAGE_BYTES) {
          throw new WsProtocolError('Message exceeds the size limit.', WS_CLOSE_MESSAGE_TOO_BIG);
        }
        if (!header.fin) {
          this.#fragmentOpcode = header.opcode;
          this.#fragmentParts = [payload];
          this.#fragmentLength = payload.length;
          return undefined;
        }
        return header.opcode === WS_OP_TEXT
          ? { kind: 'text', payload }
          : { kind: 'binary', payload };
      }
    }
  }
}
