/**
 * DuoTab-KVM 二進制通訊協議常數定義
 * 嚴格遵循網絡字節序 (Big-Endian)，全域二進制對齊
 */

export const PACKET_TYPE = Object.freeze({
  MOUSE_MOVE_REL: 0x01, // 8 Bytes: [type:1B][dx:int16BE][dy:int16BE][wheel:int8][buttons:uint8][seq:uint8]
  KEY_ACTION: 0x02,     // 6 Bytes: [type:1B][action:uint8][vkCode:uint16BE][modifiers:uint8][seq:uint8]
  HEARTBEAT: 0x03,      // 8 Bytes: [type:1B][role:uint8][leaseMs:uint16BE][timestamp:uint32BE]
  STREAM_CONTROL: 0x04, // 6 Bytes: [type:1B][displayId:uint8][targetBitrateKbps:uint16BE][fps:uint8][flags:uint8]
  VIDEO_FRAME_JPEG: 0x05, // 舊版 JPEG 串流
  VIDEO_FRAME_H264: 0x06  // 9 Bytes Header + NALU: [magic:2B 'DT'][type:1B 0x06][seq:1B][flags:1B][length:4B uint32BE]
});

export const PACKET_SIZE = Object.freeze({
  [PACKET_TYPE.MOUSE_MOVE_REL]: 8,
  [PACKET_TYPE.KEY_ACTION]: 6,
  [PACKET_TYPE.HEARTBEAT]: 8,
  [PACKET_TYPE.STREAM_CONTROL]: 6,
  H264_HEADER: 9 // [magic:2B][type:1B][seq:1B][flags:1B][length:4B uint32BE]
});

export const STREAM_MAGIC = Object.freeze({
  BYTE1: 0x44, // 'D'
  BYTE2: 0x54  // 'T'
});

export const H264_FRAME_FLAGS = Object.freeze({
  NONE: 0x00,
  KEYFRAME: 1 << 0, // 0x01: IDR 關鍵幀
  CONFIG: 1 << 1,   // 0x02: 包含 SPS/PPS 參數集
  END_OF_FRAME: 1 << 2 // 0x04: 幀結束標記
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

export const DEFAULT_PORTS = Object.freeze({
  DISCOVERY: 5857,
  CONTROL_TCP: 5858,
  INPUT_UDP: 5858,
  VIDEO_TCP: 5859
});

export const QUALITY_TIER = Object.freeze({
  AUTO: 0,
  LOW: 1,    // 480p, q28, ~1Mbps (極致流暢防斷線)
  MEDIUM: 2, // 640p, q24, ~2Mbps (預設平衡)
  HIGH: 3    // 960p, q20, ~4Mbps (細膩高清)
});

export const STREAM_CONTROL_FLAGS = Object.freeze({
  NONE: 0x00,
  REQUEST_IDR_KEYFRAME: 1 << 0, // 0x01 要求立即發送 IDR 關鍵幀（解碼出錯或首幀）
  PAUSE_STREAM: 1 << 1,         // 0x02 暫停串流（省電）
  RESUME_STREAM: 1 << 2,        // 0x04 恢復串流
  REQUEST_IDR: 1 << 3           // 0x08 即時 IDR 請求別名
});

export const NALU_TYPE = Object.freeze({
  UNSPECIFIED: 0,
  NON_IDR: 1,     // 普通 P/B 幀
  PARTITION_A: 2,
  PARTITION_B: 3,
  PARTITION_C: 4,
  IDR: 5,         // 關鍵幀
  SEI: 6,         // 補充增強資訊
  SPS: 7,         // 序列參數集 (Sequence Parameter Set)
  PPS: 8,         // 圖像參數集 (Picture Parameter Set)
  AUD: 9          // 訪問單元分隔符
});

export const DECODER_STATE = Object.freeze({
  UNINITIALIZED: 'UNINITIALIZED',       // 尚未收到 SPS/PPS
  WAITING_FOR_IDR: 'WAITING_FOR_IDR',   // 已收 SPS/PPS，等待首個關鍵幀渲染
  ACTIVE_STREAMING: 'ACTIVE_STREAMING', // 正常串流解碼中
  ERROR_RECOVERY: 'ERROR_RECOVERY'      // 幀丟失，請求重發 IDR
});

