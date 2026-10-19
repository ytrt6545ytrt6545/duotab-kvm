import {
  PACKET_TYPE,
  PACKET_SIZE,
  PROTOCOL_CONFIG
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
