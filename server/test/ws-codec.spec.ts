// SPDX-License-Identifier: GPL-3.0-only
// This file is part of the NoteGen web fork, licensed under the GNU General Public License v3.
// See LICENSE and FORK.md.

// RFC 6455 frame codec specs (W4-WIRE): server encoding,
// client-frame decoding with masking, fragmentation,
// control-frame rules, and protocol-error closes.

import { describe, expect, it } from 'vitest';
import {
  encodeCloseFrame,
  encodeFrame,
  encodeTextFrame,
  parseClosePayload,
  WebSocketFrameParser,
  WS_CLOSE_MESSAGE_TOO_BIG,
  WS_CLOSE_PROTOCOL_ERROR,
  WS_OP_BINARY,
  WS_OP_CLOSE,
  WS_OP_CONTINUATION,
  WS_OP_PING,
  WS_OP_TEXT,
  WsProtocolError,
} from '../src/services/workspace/ws-codec.js';

function maskedClientFrame(opcode: number, payload: Buffer, fin = true, mask = Buffer.from([1, 2, 3, 4])): Buffer {
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

describe('encodeFrame', () => {
  it('encodes short, 16-bit, and 64-bit lengths without a mask bit', () => {
    const short = encodeTextFrame('hi');
    expect(short[0]).toBe(0x81);
    expect(short[1]).toBe(2);
    expect(short.subarray(2).toString('utf8')).toBe('hi');
    const medium = encodeFrame(WS_OP_TEXT, Buffer.alloc(200, 0x61));
    expect(medium[1]).toBe(126);
    expect(medium.readUInt16BE(2)).toBe(200);
    const large = encodeFrame(WS_OP_TEXT, Buffer.alloc(70000, 0x61));
    expect(large[1]).toBe(127);
    expect(large.readBigUInt64BE(2)).toBe(70000n);
  });

  it('encodes close frames with code + reason', () => {
    const frame = encodeCloseFrame(1008, 'too many');
    expect(frame[0]).toBe(0x88);
    const parsed = parseClosePayload(frame.subarray(2));
    expect(parsed.code).toBe(1008);
    expect(parsed.reason).toBe('too many');
  });
});

describe('WebSocketFrameParser', () => {
  it('decodes a masked text frame split across TCP chunks', () => {
    const parser = new WebSocketFrameParser();
    const frame = maskedClientFrame(WS_OP_TEXT, Buffer.from('hello', 'utf8'));
    expect(parser.push(frame.subarray(0, 3))).toEqual([]);
    const decoded = parser.push(frame.subarray(3));
    expect(decoded).toEqual([{ kind: 'text', payload: Buffer.from('hello', 'utf8') }]);
  });

  it('decodes several frames in one chunk', () => {
    const parser = new WebSocketFrameParser();
    const combined = Buffer.concat([
      maskedClientFrame(WS_OP_TEXT, Buffer.from('one', 'utf8')),
      maskedClientFrame(WS_OP_PING, Buffer.from('p', 'utf8')),
    ]);
    const decoded = parser.push(combined);
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).toEqual({ kind: 'text', payload: Buffer.from('one', 'utf8') });
    expect(decoded[1]).toEqual({ kind: 'ping', payload: Buffer.from('p', 'utf8') });
  });

  it('reassembles fragmented messages and lets control frames interleave', () => {
    const parser = new WebSocketFrameParser();
    const frames = Buffer.concat([
      maskedClientFrame(WS_OP_TEXT, Buffer.from('hel', 'utf8'), false),
      maskedClientFrame(WS_OP_PING, Buffer.alloc(0)),
      maskedClientFrame(WS_OP_CONTINUATION, Buffer.from('lo', 'utf8'), true),
    ]);
    const decoded = parser.push(frames);
    expect(decoded).toEqual([
      { kind: 'ping', payload: Buffer.alloc(0) },
      { kind: 'text', payload: Buffer.from('hello', 'utf8') },
    ]);
  });

  it('decodes 16-bit and 64-bit extended lengths', () => {
    const parser = new WebSocketFrameParser();
    const medium = parser.push(maskedClientFrame(WS_OP_TEXT, Buffer.alloc(300, 0x62)));
    expect((medium[0] as { payload: Buffer }).payload.length).toBe(300);
    const large = parser.push(maskedClientFrame(WS_OP_BINARY, Buffer.alloc(70000, 0x63)));
    expect(large[0]).toMatchObject({ kind: 'binary' });
    expect((large[0] as { payload: Buffer }).payload.length).toBe(70000);
  });

  it('rejects unmasked client frames with close 1002', () => {
    const parser = new WebSocketFrameParser();
    const frame = encodeTextFrame('hi');
    let caught: WsProtocolError | undefined;
    try {
      parser.push(frame);
    } catch (error) {
      caught = error as WsProtocolError;
    }
    expect(caught).toBeInstanceOf(WsProtocolError);
    expect(caught?.closeCode).toBe(WS_CLOSE_PROTOCOL_ERROR);
  });

  it('rejects a continuation without an open message and a fragmented control frame', () => {
    const lone = new WebSocketFrameParser();
    expect(() => lone.push(maskedClientFrame(WS_OP_CONTINUATION, Buffer.from('x', 'utf8')))).toThrow(
      WsProtocolError,
    );
    const fragmentedPing = new WebSocketFrameParser();
    expect(() =>
      fragmentedPing.push(maskedClientFrame(WS_OP_PING, Buffer.from('x', 'utf8'), false)),
    ).toThrow(WsProtocolError);
  });

  it('rejects reserved opcodes and set RSV bits', () => {
    const reserved = new WebSocketFrameParser();
    const frame = maskedClientFrame(0x3, Buffer.from('x', 'utf8'));
    expect(() => reserved.push(frame)).toThrow(WsProtocolError);
    const rsv = new WebSocketFrameParser();
    const rsvFrame = maskedClientFrame(WS_OP_TEXT, Buffer.from('x', 'utf8'));
    rsvFrame[0] = (rsvFrame[0] as number) | 0x40;
    expect(() => rsv.push(rsvFrame)).toThrow(WsProtocolError);
  });

  it('rejects an oversized message with close 1009', () => {
    const parser = new WebSocketFrameParser();
    const big = maskedClientFrame(WS_OP_TEXT, Buffer.alloc(1024 * 1024 + 1, 0x61));
    let caught: WsProtocolError | undefined;
    try {
      parser.push(big);
    } catch (error) {
      caught = error as WsProtocolError;
    }
    expect(caught?.closeCode).toBe(WS_CLOSE_MESSAGE_TOO_BIG);
  });

  it('parses close payloads including the empty and one-byte edges', () => {
    expect(parseClosePayload(Buffer.alloc(0))).toEqual({ code: undefined, reason: '' });
    expect(() => parseClosePayload(Buffer.from([0x03]))).toThrow(WsProtocolError);
    const parser = new WebSocketFrameParser();
    const closePayload = Buffer.alloc(2);
    closePayload.writeUInt16BE(1000, 0);
    expect(parser.push(maskedClientFrame(WS_OP_CLOSE, closePayload))).toEqual([
      { kind: 'close', code: 1000, reason: '' },
    ]);
  });
});
