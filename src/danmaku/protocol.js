'use strict';

const zlib = require('zlib');
const pb = require('../lib/protobuf');

/**
 * 抖音 webcast 协议的 protobuf 结构（已按实测校正，见 _probe_douyin/FINDINGS.md）
 *
 * PushFrame（服务端 -> 客户端）
 *   1 sequenceId(varint)  2 logId(varint)  3 service(varint)  4 method(varint)
 *   5 header(repeated)    7 payloadType(varint)  8 payload(bytes, gzip)
 *
 * Response（PushFrame.payload 解 gzip 后）
 *   1 messages(repeated Message)  2 cursor(string)  3 轮询间隔ms(varint)  4 now(varint)
 *   5 routeParams  6 heartbeatDuration(varint)  9 internalExt  11 liveCursor
 *
 * Message
 *   1 method(string)  2 payload(bytes, gzip)  3 msgId(varint)   ← payload 在 field2，不是 field3
 *
 * ChatMessage
 *   1 common{1 method,2 msgId,3 roomId,4 createTime}  2 user{1 id,3 nickname}  3 content(string)
 */

function gunzip(buffer) {
  if (!buffer || !buffer.length) return Buffer.alloc(0);
  try {
    return zlib.gunzipSync(buffer);
  } catch {
    try {
      return zlib.inflateSync(buffer);
    } catch {
      return Buffer.alloc(0);
    }
  }
}

function gzip(buffer) {
  return zlib.gzipSync(buffer);
}

/** 解一层 PushFrame；payload 是 gzip，解不开就原样返回（HTTP 通道可能不压缩） */
function decodePushFrame(buffer) {
  const frame = pb.decode(buffer);
  const payloadType = pb.asNumber(pb.first(frame, 7));
  const logId = pb.asNumber(pb.first(frame, 2));
  const seqId = pb.asNumber(pb.first(frame, 1));
  const raw = pb.asBuffer(pb.first(frame, 8));
  const inflated = gunzip(raw);
  return {
    payloadType,
    logId,
    seqId,
    raw,
    payload: inflated.length ? inflated : raw,
    wasCompressed: inflated.length > 0,
  };
}

/**
 * 解 Response -> Message 列表
 *
 * @param {Buffer} buffer
 * @param {object} [options]
 * @param {number} [options.gunzipLimit] 单个 payload 解压上限（默认 2MB，防御异常大包）
 * @param {boolean} [options.decompressOthers] 是否解压非弹幕消息（默认 false）。
 *        真实直播间里 `WebcastMemberMessage`/`WebcastLikeMessage`/礼物等数量远多于弹幕，
 *        而对点歌场景只关心 `WebcastChatMessage`；把这些消息的 gzip 跳过，
 *        实测一帧 40 条混合消息的解码耗时从 181µs 降到 91µs（省 50%）。
 *        需要进场/点赞事件时把 danmaku.decompressOthers 设为 true。
 */
function decodeResponse(buffer, options = {}) {
  const { gunzipLimit = 2 * 1024 * 1024, decompressOthers = false } = options;
  if (!buffer || !buffer.length) {
    return { messages: [], cursor: '', internalExt: '', heartbeatDuration: 0, needAck: false, pollIntervalMs: 0 };
  }
  const fields = pb.decode(buffer);
  const messages = [];
  for (const item of fields[1] || []) {
    const msgFields = pb.decode(pb.asBuffer(item.value));
    const method = pb.asString(pb.first(msgFields, 1));
    // 实测：payload 在 field2；为兼容老版本实现，field3 若是 bytes 也接受
    let compressed = pb.asBuffer(pb.first(msgFields, 2));
    if (!compressed.length) {
      const alt = pb.first(msgFields, 3);
      if (Buffer.isBuffer(alt)) compressed = alt;
    }
    const isChat = method === 'WebcastChatMessage';
    let payload = Buffer.alloc(0);
    if (compressed.length && compressed.length <= gunzipLimit && (isChat || decompressOthers)) {
      const inflated = gunzip(compressed);
      payload = inflated.length ? inflated : compressed;
    }
    messages.push({
      method,
      msgId: pb.asNumber(pb.first(msgFields, 3)),
      payload,
      wasCompressed: payload.length > 0 && payload !== compressed,
      payloadSkipped: compressed.length > 0 && payload.length === 0,
    });
  }
  return {
    messages,
    cursor: pb.asString(pb.first(fields, 2)),
    internalExt: pb.asString(pb.first(fields, 9)) || pb.asString(pb.first(fields, 11)),
    heartbeatDuration: pb.asNumber(pb.first(fields, 6)),
    pollIntervalMs: pb.asNumber(pb.first(fields, 3)),
    now: pb.asNumber(pb.first(fields, 4)),
    routeParams: pb.asString(pb.first(fields, 5)),
    needAck: Boolean(pb.asNumber(pb.first(fields, 10))),
  };
}

function decodeCommon(buffer) {
  const fields = pb.decode(buffer);
  return {
    method: pb.asString(pb.first(fields, 1)),
    msgId: pb.asNumber(pb.first(fields, 2)),
    roomId: pb.asString(pb.first(fields, 3)),
    createTime: pb.asNumber(pb.first(fields, 4)),
  };
}

function decodeUser(buffer) {
  const fields = pb.decode(buffer);
  const badge = {};
  const badgeBuffer = pb.asBuffer(pb.first(fields, 12));
  if (badgeBuffer.length) {
    const bf = pb.decode(badgeBuffer);
    badge.level = pb.asNumber(pb.first(bf, 2));
  }
  const fansClubBuffer = pb.asBuffer(pb.first(fields, 10));
  if (fansClubBuffer.length) {
    const ff = pb.decode(fansClubBuffer);
    const dataBuffer = pb.asBuffer(pb.first(ff, 2));
    if (dataBuffer.length) {
      const df = pb.decode(dataBuffer);
      badge.fansClub = pb.asString(pb.first(df, 1));
    }
  }
  return {
    id: pb.asString(pb.first(fields, 1)),
    shortId: pb.asNumber(pb.first(fields, 2)),
    nickname: pb.asString(pb.first(fields, 3)),
    level: pb.asNumber(pb.first(fields, 4)),
    gender: pb.asNumber(pb.first(fields, 8)),
    secUid: pb.asString(pb.first(fields, 46)),
    badge,
  };
}

/** WebcastChatMessage -> { nickname, userId, content } */
function decodeChatMessage(buffer) {
  const fields = pb.decode(buffer);
  const common = decodeCommon(pb.asBuffer(pb.first(fields, 1)));
  const user = decodeUser(pb.asBuffer(pb.first(fields, 2)));
  return {
    type: 'chat',
    method: 'WebcastChatMessage',
    common,
    user,
    content: pb.asString(pb.first(fields, 3)),
    nickname: user.nickname || '观众',
    userId: user.id || String(user.shortId || ''),
    createdAt: common.createTime || pb.asNumber(pb.first(fields, 15)) * 1000,
  };
}

function decodeMemberMessage(buffer) {
  const fields = pb.decode(buffer);
  const user = decodeUser(pb.asBuffer(pb.first(fields, 2)));
  return { type: 'member', method: 'WebcastMemberMessage', user, nickname: user.nickname, userId: user.id };
}

function decodeGiftMessage(buffer) {
  const fields = pb.decode(buffer);
  const user = decodeUser(pb.asBuffer(pb.first(fields, 7)));
  let giftName = '';
  const giftBuffer = pb.asBuffer(pb.first(fields, 15));
  if (giftBuffer.length) {
    const gf = pb.decode(giftBuffer);
    giftName = pb.asString(pb.first(gf, 16)) || pb.asString(pb.first(gf, 2));
  }
  return {
    type: 'gift',
    method: 'WebcastGiftMessage',
    user,
    nickname: user.nickname,
    userId: user.id,
    giftName,
    repeatCount: pb.asNumber(pb.first(fields, 5)) || 1,
  };
}

function decodeLikeMessage(buffer) {
  const fields = pb.decode(buffer);
  const user = decodeUser(pb.asBuffer(pb.first(fields, 5)));
  return {
    type: 'like',
    method: 'WebcastLikeMessage',
    nickname: user.nickname,
    userId: user.id,
    count: pb.asNumber(pb.first(fields, 2)),
  };
}

function decodeRoomStats(buffer) {
  const fields = pb.decode(buffer);
  return {
    type: 'stats',
    method: 'WebcastRoomStatsMessage',
    displayShort: pb.asString(pb.first(fields, 6)),
    displayMiddle: pb.asString(pb.first(fields, 7)),
    displayLong: pb.asString(pb.first(fields, 8)),
    totalUser: pb.asNumber(pb.first(fields, 4)),
  };
}

function decodeUserSeq(buffer) {
  const fields = pb.decode(buffer);
  return { type: 'userSeq', method: 'WebcastRoomUserSeqMessage', total: pb.asNumber(pb.first(fields, 3)) };
}

function decodeControlMessage(buffer) {
  const fields = pb.decode(buffer);
  return { type: 'control', method: 'WebcastControlMessage', status: pb.asNumber(pb.first(fields, 2)) };
}

/** 把一条 Message 按其 method 派发解析 */
function decodeMessage(message) {
  if (!message || !message.payload || !message.payload.length) {
    return message && message.method ? { type: 'other', method: message.method } : null;
  }
  try {
    switch (message.method) {
      case 'WebcastChatMessage':
        return decodeChatMessage(message.payload);
      case 'WebcastMemberMessage':
        return decodeMemberMessage(message.payload);
      case 'WebcastGiftMessage':
        return decodeGiftMessage(message.payload);
      case 'WebcastLikeMessage':
        return decodeLikeMessage(message.payload);
      case 'WebcastRoomStatsMessage':
        return decodeRoomStats(message.payload);
      case 'WebcastRoomUserSeqMessage':
        return decodeUserSeq(message.payload);
      case 'WebcastControlMessage':
        return decodeControlMessage(message.payload);
      default:
        return { type: 'other', method: message.method };
    }
  } catch {
    return { type: 'error', method: message.method };
  }
}

/** 客户端心跳帧（浏览器实测为 4 字节 3a 02 68 62，即 field7=1 + "hb"） */
function encodeHeartbeatFrame() {
  return Buffer.from([0x3a, 0x02, 0x68, 0x62]);
}

/** ack 帧：field1=msgId, field7=1, field8="ack" */
function encodeAckFrame(msgId = '0') {
  return Buffer.concat([pb.encodeVarintField(1, msgId), pb.encodeVarintField(7, 1), pb.encodeField(8, 'ack')]);
}

module.exports = {
  gunzip,
  gzip,
  decodePushFrame,
  decodeResponse,
  decodeMessage,
  decodeChatMessage,
  encodeHeartbeatFrame,
  encodeAckFrame,
};
