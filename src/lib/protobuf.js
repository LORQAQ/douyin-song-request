'use strict';

/**
 * 极简 protobuf 解码器（只读），够用来解抖音弹幕协议。
 * 支持 wire type: 0 varint / 1 fixed64 / 2 length-delimited / 5 fixed32。
 *
 * 性能注意：varint 走**纯数字快路径**，不碰 BigInt。
 * 之前用 BigInt 逐字节移位，在高频弹幕（每秒几十条）下会产生大量短命 BigInt，
 * 拖慢速度也增加 GC 压力。现在只有真正超过 2^53 的大数才回退到 BigInt，
 * 并且回退后的返回值类型（字符串）与旧实现保持一致。
 */
function readVarint(buf, pos) {
  // 快路径：4 字节以内（覆盖绝大多数字段：长度、tag、时间戳低位、枚举值）
  let p = pos;
  let lo = 0;
  for (let i = 0; i < 4 && p < buf.length; i += 1) {
    const byte = buf[p];
    lo += (byte & 0x7f) * 2 ** (7 * i);
    p += 1;
    if ((byte & 0x80) === 0) return { value: lo >>> 0, pos: p, big: false };
  }
  // 慢路径：>= 5 字节（大 ID / 时间戳），用 BigInt 保证不丢精度
  let result = BigInt(lo >>> 0);
  let shift = 28n;
  while (p < buf.length) {
    const byte = buf[p];
    result |= BigInt(byte & 0x7f) << shift;
    p += 1;
    if ((byte & 0x80) === 0) break;
    shift += 7n;
    if (shift > 70n) break;
  }
  if (result <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return { value: Number(result), pos: p, big: false };
  }
  return { value: result.toString(), pos: p, big: true };
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return value;
  if (value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return value.toString();
}

/**
 * 解析一层消息，返回 { fieldNumber: [{ wireType, value }] }
 * value: number(bigint 转) | Buffer | {hi,lo}
 */
function decode(buf) {
  const out = {};
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    try {
      tag = readVarint(buf, pos);
    } catch {
      break;
    }
    pos = tag.pos;
    const key = Number(tag.value);
    const fieldNumber = key >> 3;
    const wireType = key & 0x07;
    if (fieldNumber === 0) break;

    let value;
    if (wireType === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      value = toNumber(v.value);
    } else if (wireType === 1) {
      if (pos + 8 > buf.length) break;
      value = { fixed64: buf.subarray(pos, pos + 8).toString('hex') };
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const size = Number(len.value);
      if (pos + size > buf.length) break;
      value = buf.subarray(pos, pos + size);
      pos += size;
    } else if (wireType === 5) {
      if (pos + 4 > buf.length) break;
      value = { fixed32: buf.subarray(pos, pos + 4).toString('hex') };
      pos += 4;
    } else {
      // 未知 wire type，无法继续，直接结束
      break;
    }
    if (!out[fieldNumber]) out[fieldNumber] = [];
    out[fieldNumber].push({ wireType, value });
  }
  return out;
}

const first = (fields, num) => (fields[num] && fields[num].length ? fields[num][0].value : undefined);

function asString(value) {
  if (value === undefined || value === null) return '';
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value);
}

function asNumber(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}

function asBuffer(value) {
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

/** 编码一个 varint */
function writeVarint(value) {
  let v = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) byte |= 0x80;
    bytes.push(byte);
  } while (v > 0n);
  return Buffer.from(bytes);
}

/** 编码 length-delimited 字段 */
function encodeField(fieldNumber, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([writeVarint((fieldNumber << 3) | 2), writeVarint(body.length), body]);
}

function encodeVarintField(fieldNumber, value) {
  return Buffer.concat([writeVarint(fieldNumber << 3), writeVarint(value)]);
}

module.exports = { decode, first, asString, asNumber, asBuffer, writeVarint, encodeField, encodeVarintField };
