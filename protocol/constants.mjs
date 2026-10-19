/**
 * DuoTab-KVM 二進制通訊協議常數定義
 * 嚴格遵循網絡字節序 (Big-Endian)，全域二進制對齊
 */

export const PACKET_TYPE = Object.freeze({
  MOUSE_MOVE_REL: 0x01, // 8 Bytes: [type:1B][dx:int16BE][dy:int16BE][wheel:int8][buttons:uint8][seq:uint8]
  KEY_ACTION: 0x02,     // 6 Bytes: [type:1B][action:uint8][vkCode:uint16BE][modifiers:uint8][seq:uint8]
  HEARTBEAT: 0x03,      // 8 Bytes: [type:1B][role:uint8][leaseMs:uint16BE][timestamp:uint32BE]
  STREAM_CONTROL: 0x04  // 6 Bytes: [type:1B][displayId:uint8][targetBitrateKbps:uint16BE][fps:uint8][flags:uint8]
});

export const PACKET_SIZE = Object.freeze({
  [PACKET_TYPE.MOUSE_MOVE_REL]: 8,
  [PACKET_TYPE.KEY_ACTION]: 6,
  [PACKET_TYPE.HEARTBEAT]: 8,
  [PACKET_TYPE.STREAM_CONTROL]: 6
});

export const BUTTON_MASKS = Object.freeze({
  NONE: 0x00,
  LEFT: 1 << 0,       // 0x01
  RIGHT: 1 << 1,      // 0x02
  MIDDLE: 1 << 2,     // 0x04
  BACK: 1 << 3,       // 0x08 (滑鼠側鍵後退)
  FORWARD: 1 << 4     // 0x10 (滑鼠側鍵前進)
});

export const KEY_ACTION_TYPE = Object.freeze({
  UP: 0x00,
  DOWN: 0x01
});

export const MODIFIER_MASKS = Object.freeze({
  NONE: 0x00,
  SHIFT: 1 << 0,      // 0x01
  CTRL: 1 << 1,       // 0x02
  ALT: 1 << 2,        // 0x04
  META_WIN: 1 << 3    // 0x08 (Windows 鍵)
});

export const CLIENT_ROLE = Object.freeze({
  UNKNOWN: 0x00,
  CONSOLE: 0x01,      // 主要螢幕 (接收 Display 1 + 專屬 OTG 鍵鼠入口)
  DISPLAY: 0x02       // 延伸螢幕 (接收 Display 2，純放映)
});

export const PROTOCOL_CONFIG = Object.freeze({
  DEFAULT_HEARTBEAT_LEASE_MS: 1500, // 租約時效 1500ms
  HEARTBEAT_INTERVAL_MS: 500,       // 1/3 租約心跳間隔 (500ms)
  MAX_INT16: 32767,
  MIN_INT16: -32768
});
