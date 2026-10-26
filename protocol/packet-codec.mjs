import {
  PACKET_TYPE,
  PACKET_SIZE,
  PROTOCOL_CONFIG,
  STREAM_MAGIC,
  H264_FRAME_FLAGS,
  NALU_TYPE
} from './constants.mjs';

function clampInt16(val) {
  if (val > PROTOCOL_CONFIG.MAX_INT16) return PROTOCOL_CONFIG.MAX_INT16;
  if (val < PROTOCOL_CONFIG.MIN_INT16) return PROTOCOL_CONFIG.MIN_INT16;
  return Math.trunc(val);
}

function clampInt8(val) {
  if (val > 127) return 127;
  if (val < -128) return -128;
  return Math.trunc(val);
}

/**
 * 編碼滑鼠相對位移封包 (8 Bytes)
 * [type:1B][dx:int16BE][dy:int16BE][wheel:int8][buttons:uint8][seq:uint8]
 */
export function encodeMouseMove({ dx = 0, dy = 0, wheel = 0, buttons = 0, seq = 0 }) {
  const buf = Buffer.allocUnsafe(PACKET_SIZE[PACKET_TYPE.MOUSE_MOVE_REL]);
  buf.writeUInt8(PACKET_TYPE.MOUSE_MOVE_REL, 0);
  buf.writeInt16BE(clampInt16(dx), 1);
  buf.writeInt16BE(clampInt16(dy), 3);
  buf.writeInt8(clampInt8(wheel), 5);
  buf.writeUInt8(buttons & 0xFF, 6);
  buf.writeUInt8(seq & 0xFF, 7);
  return buf;
}

/**
 * 解碼滑鼠相對位移封包
 */
export function decodeMouseMove(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PACKET_SIZE[PACKET_TYPE.MOUSE_MOVE_REL]) {
    throw new Error(`[PacketCodec] Invalid mouse packet size: expected at least ${PACKET_SIZE[PACKET_TYPE.MOUSE_MOVE_REL]}, got ${buf?.length}`);
  }
  const type = buf.readUInt8(0);
  if (type !== PACKET_TYPE.MOUSE_MOVE_REL) {
    throw new Error(`[PacketCodec] Unexpected packet type: expected ${PACKET_TYPE.MOUSE_MOVE_REL}, got ${type}`);
  }
  return {
    type,
    dx: buf.readInt16BE(1),
    dy: buf.readInt16BE(3),
    wheel: buf.readInt8(5),
    buttons: buf.readUInt8(6),
    seq: buf.readUInt8(7)
  };
}

/**
 * 編碼鍵盤按鍵動作封包 (6 Bytes)
 * [type:1B][action:uint8][vkCode:uint16BE][modifiers:uint8][seq:uint8]
 */
export function encodeKeyAction({ action = 0, vkCode = 0, modifiers = 0, seq = 0 }) {
  const buf = Buffer.allocUnsafe(PACKET_SIZE[PACKET_TYPE.KEY_ACTION]);
  buf.writeUInt8(PACKET_TYPE.KEY_ACTION, 0);
  buf.writeUInt8(action & 0xFF, 1);
  buf.writeUInt16BE(vkCode & 0xFFFF, 2);
  buf.writeUInt8(modifiers & 0xFF, 4);
  buf.writeUInt8(seq & 0xFF, 5);
  return buf;
}

/**
 * 解碼鍵盤按鍵動作封包
 */
export function decodeKeyAction(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PACKET_SIZE[PACKET_TYPE.KEY_ACTION]) {
    throw new Error(`[PacketCodec] Invalid key packet size: expected at least ${PACKET_SIZE[PACKET_TYPE.KEY_ACTION]}, got ${buf?.length}`);
  }
  const type = buf.readUInt8(0);
  if (type !== PACKET_TYPE.KEY_ACTION) {
    throw new Error(`[PacketCodec] Unexpected packet type: expected ${PACKET_TYPE.KEY_ACTION}, got ${type}`);
  }
  return {
    type,
    action: buf.readUInt8(1),
    vkCode: buf.readUInt16BE(2),
    modifiers: buf.readUInt8(4),
    seq: buf.readUInt8(5)
  };
}

/**
 * 編碼心跳租約封包 (8 Bytes)
 * [type:1B][role:uint8][leaseMs:uint16BE][timestamp:uint32BE]
 */
export function encodeHeartbeat({ role = 0, leaseMs = PROTOCOL_CONFIG.DEFAULT_HEARTBEAT_LEASE_MS, timestamp = Date.now() }) {
  const buf = Buffer.allocUnsafe(PACKET_SIZE[PACKET_TYPE.HEARTBEAT]);
  buf.writeUInt8(PACKET_TYPE.HEARTBEAT, 0);
  buf.writeUInt8(role & 0xFF, 1);
  buf.writeUInt16BE(leaseMs & 0xFFFF, 2);
  // timestamp 取下 32 位毫秒數
  buf.writeUInt32BE((timestamp & 0xFFFFFFFF) >>> 0, 4);
  return buf;
}

/**
 * 解碼心跳租約封包
 */
export function decodeHeartbeat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PACKET_SIZE[PACKET_TYPE.HEARTBEAT]) {
    throw new Error(`[PacketCodec] Invalid heartbeat packet size: expected at least ${PACKET_SIZE[PACKET_TYPE.HEARTBEAT]}, got ${buf?.length}`);
  }
  const type = buf.readUInt8(0);
  if (type !== PACKET_TYPE.HEARTBEAT) {
    throw new Error(`[PacketCodec] Unexpected packet type: expected ${PACKET_TYPE.HEARTBEAT}, got ${type}`);
  }
  return {
    type,
    role: buf.readUInt8(1),
    leaseMs: buf.readUInt16BE(2),
    timestamp: buf.readUInt32BE(4)
  };
}

/**
 * 編碼串流控制封包 (6 Bytes)
 * [type:1B][displayId:uint8][targetBitrateKbps:uint16BE][fps:uint8][flags:uint8]
 */
export function encodeStreamControl({ displayId = 1, targetBitrateKbps = 6000, fps = 60, flags = 0 }) {
  const buf = Buffer.allocUnsafe(PACKET_SIZE[PACKET_TYPE.STREAM_CONTROL]);
  buf.writeUInt8(PACKET_TYPE.STREAM_CONTROL, 0);
  buf.writeUInt8(displayId & 0xFF, 1);
  buf.writeUInt16BE(targetBitrateKbps & 0xFFFF, 2);
  buf.writeUInt8(fps & 0xFF, 4);
  buf.writeUInt8(flags & 0xFF, 5);
  return buf;
}

/**
 * 解碼串流控制封包
 */
export function decodeStreamControl(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < PACKET_SIZE[PACKET_TYPE.STREAM_CONTROL]) {
    throw new Error(`[PacketCodec] Invalid stream control packet size: expected at least ${PACKET_SIZE[PACKET_TYPE.STREAM_CONTROL]}, got ${buf?.length}`);
  }
  const type = buf.readUInt8(0);
  if (type !== PACKET_TYPE.STREAM_CONTROL) {
    throw new Error(`[PacketCodec] Unexpected packet type: expected ${PACKET_TYPE.STREAM_CONTROL}, got ${type}`);
  }
  return {
    type,
    displayId: buf.readUInt8(1),
    targetBitrateKbps: buf.readUInt16BE(2),
    fps: buf.readUInt8(4),
    flags: buf.readUInt8(5)
  };
}

/**
 * 解析二進制 Buffer 中的 Annex-B NALU 單元 (零拷貝 slice/subarray)
 * 支援標準 4-Byte (00 00 00 01) 與 3-Byte (00 00 01) 起始碼
 * @param {Buffer} buffer
 * @returns {Array<{ type: number, raw: Buffer, offset: number, size: number, headerLen: number }>}
 */
export function parseAnnexBNalus(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return [];
  }

  const nalus = [];
  const len = buffer.length;
  let i = 0;

  const startCodeIndices = [];
  while (i < len - 2) {
    if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
      if (buffer[i + 2] === 0x01) {
        startCodeIndices.push({ index: i, headerLen: 3 });
        i += 3;
        continue;
      } else if (i < len - 3 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
        startCodeIndices.push({ index: i, headerLen: 4 });
        i += 4;
        continue;
      }
    }
    i++;
  }

  for (let k = 0; k < startCodeIndices.length; k++) {
    const current = startCodeIndices[k];
    const nextIndex = k + 1 < startCodeIndices.length ? startCodeIndices[k + 1].index : len;
    const naluStart = current.index + current.headerLen;

    if (naluStart < nextIndex) {
      const headerByte = buffer[naluStart];
      const naluType = headerByte & 0x1F;
      const naluBuf = buffer.subarray(naluStart, nextIndex);

      nalus.push({
        type: naluType,
        raw: naluBuf,
        offset: naluStart,
        size: naluBuf.length,
        headerLen: current.headerLen
      });
    }
  }

  return nalus;
}

/**
 * 編碼 H.264 視訊傳輸封包
 * 格式: [magic:2B 'DT'][type:1B 0x06][seq:1B][flags:1B][length:4B uint32BE][payload: N Bytes]
 * @param {Object} options
 * @param {Buffer} options.naluData 視訊幀 NALU 資料 (若缺少 Annex-B 起始碼且 enforceStartCode=true，自動補齊 4-Byte 00 00 00 01)
 * @param {number} [options.seq=0] 幀序號 (0~255)
 * @param {number} [options.flags=0] 自訂旗標 (參見 H264_FRAME_FLAGS)
 * @param {boolean} [options.autoDetect=true] 自動偵測 NALU 類型並補充 KEYFRAME/CONFIG 旗標
 * @param {boolean} [options.enforceStartCode=true] 自動校驗/補齊 Annex-B 起始碼
 * @returns {Buffer}
 */
export function encodeH264Frame({
  naluData,
  seq = 0,
  flags = H264_FRAME_FLAGS.NONE,
  autoDetect = true,
  enforceStartCode = true
}) {
  if (!Buffer.isBuffer(naluData)) {
    throw new Error('[PacketCodec] naluData must be a valid Buffer');
  }

  const MAX_PAYLOAD = 10 * 1024 * 1024; // 10MB 安全保護閾值
  if (naluData.length > MAX_PAYLOAD) {
    throw new Error(`[PacketCodec] naluData size ${naluData.length} exceeds max limit of ${MAX_PAYLOAD} bytes`);
  }

  // 檢查並補全 Annex-B 4-Byte 起始碼
  let payload = naluData;
  const hasStartCode = (naluData.length >= 3 && naluData[0] === 0x00 && naluData[1] === 0x00 && (naluData[2] === 0x01 || (naluData.length >= 4 && naluData[2] === 0x00 && naluData[3] === 0x01)));

  if (enforceStartCode && !hasStartCode) {
    const withStartCode = Buffer.allocUnsafe(4 + naluData.length);
    withStartCode[0] = 0x00;
    withStartCode[1] = 0x00;
    withStartCode[2] = 0x00;
    withStartCode[3] = 0x01;
    naluData.copy(withStartCode, 4);
    payload = withStartCode;
  }

  let finalFlags = flags;
  if (autoDetect) {
    const nalus = parseAnnexBNalus(payload);
    for (const nalu of nalus) {
      if (nalu.type === NALU_TYPE.IDR) {
        finalFlags |= H264_FRAME_FLAGS.KEYFRAME;
      } else if (nalu.type === NALU_TYPE.SPS || nalu.type === NALU_TYPE.PPS) {
        finalFlags |= H264_FRAME_FLAGS.CONFIG;
      }
    }
  }

  const headerSize = PACKET_SIZE.H264_HEADER; // 9 Bytes
  const totalLength = headerSize + payload.length;
  const packet = Buffer.allocUnsafe(totalLength);

  // 魔數 'DT'
  packet[0] = STREAM_MAGIC.BYTE1; // 0x44
  packet[1] = STREAM_MAGIC.BYTE2; // 0x54
  // 類型 0x06
  packet[2] = PACKET_TYPE.VIDEO_FRAME_H264;
  // 序號
  packet[3] = seq & 0xFF;
  // 旗標
  packet[4] = finalFlags & 0xFF;
  // 4-Byte 長度前綴 (uint32BE)
  packet.writeUInt32BE(payload.length, 5);

  // 拷貝 payload
  payload.copy(packet, headerSize);

  return packet;
}

/**
 * 解碼 H.264 視訊傳輸封包
 * @param {Buffer} buf
 * @returns {{
 *   type: number,
 *   seq: number,
 *   flags: number,
 *   payloadLength: number,
 *   payload: Buffer,
 *   nalus: Array<{ type: number, raw: Buffer, offset: number, size: number, headerLen: number }>,
 *   isKeyframe: boolean,
 *   isConfig: boolean
 * }}
 */
export function decodeH264Frame(buf) {
  const headerSize = PACKET_SIZE.H264_HEADER;
  if (!Buffer.isBuffer(buf) || buf.length < headerSize) {
    throw new Error(`[PacketCodec] Invalid H264 packet size: expected at least ${headerSize}, got ${buf?.length}`);
  }

  if (buf[0] !== STREAM_MAGIC.BYTE1 || buf[1] !== STREAM_MAGIC.BYTE2) {
    throw new Error(`[PacketCodec] Invalid stream magic: expected 0x44 0x54 ('DT'), got 0x${buf[0].toString(16)} 0x${buf[1].toString(16)}`);
  }

  const type = buf.readUInt8(2);
  if (type !== PACKET_TYPE.VIDEO_FRAME_H264) {
    throw new Error(`[PacketCodec] Unexpected packet type: expected ${PACKET_TYPE.VIDEO_FRAME_H264}, got ${type}`);
  }

  const seq = buf.readUInt8(3);
  const flags = buf.readUInt8(4);
  const payloadLength = buf.readUInt32BE(5);

  const MAX_PAYLOAD = 10 * 1024 * 1024;
  if (payloadLength > MAX_PAYLOAD) {
    throw new Error(`[PacketCodec] Corrupted payload length: ${payloadLength} exceeds max limit of ${MAX_PAYLOAD}`);
  }

  if (buf.length < headerSize + payloadLength) {
    throw new Error(`[PacketCodec] Truncated H264 packet: expected ${headerSize + payloadLength} bytes, but got ${buf.length}`);
  }

  // 零拷貝截取 payload
  const payload = buf.subarray(headerSize, headerSize + payloadLength);
  const nalus = parseAnnexBNalus(payload);

  const isKeyframe = Boolean(flags & H264_FRAME_FLAGS.KEYFRAME) || nalus.some(n => n.type === NALU_TYPE.IDR);
  const isConfig = Boolean(flags & H264_FRAME_FLAGS.CONFIG) || nalus.some(n => n.type === NALU_TYPE.SPS || n.type === NALU_TYPE.PPS);

  return {
    type,
    seq,
    flags,
    payloadLength,
    payload,
    nalus,
    isKeyframe,
    isConfig
  };
}
