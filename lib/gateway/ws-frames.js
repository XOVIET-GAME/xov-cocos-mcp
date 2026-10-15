'use strict';

const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

function encodeFrame(opcode, payload, options = {}) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || '');
  const masked = options.mask === true;
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, (masked ? 0x80 : 0) | length]);
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = (masked ? 0x80 : 0) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  if (!masked) return Buffer.concat([header, data]);
  const mask = options.maskKey ? Buffer.from(options.maskKey) : require('crypto').randomBytes(4);
  if (mask.length !== 4) throw new Error('WebSocket mask keys must contain four bytes.');
  const maskedData = Buffer.from(data);
  for (let index = 0; index < maskedData.length; index += 1) maskedData[index] ^= mask[index % 4];
  return Buffer.concat([header, mask, maskedData]);
}

function decodeFrame(buffer, options = {}) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let length = second & 0x7f;
  let offset = 2;
  if (options.expectMasked === true && !masked) throw new Error('Client WebSocket frames must be masked.');
  if (options.expectMasked === false && masked) throw new Error('Server WebSocket frames must not be masked.');
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const wideLength = buffer.readBigUInt64BE(offset);
    if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('WebSocket frame length is not supported.');
    length = Number(wideLength);
    offset += 8;
  }
  const maxFrameBytes = Number.isFinite(options.maxFrameBytes) ? options.maxFrameBytes : DEFAULT_MAX_FRAME_BYTES;
  if (length > maxFrameBytes) throw new Error('WebSocket frame exceeds the maximum payload size.');
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return null;
  let payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { fin, opcode, payload, bytesConsumed: offset + maskLength + length };
}

module.exports = { DEFAULT_MAX_FRAME_BYTES, decodeFrame, encodeFrame };
