import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKET_TYPE,
  BUTTON_MASKS,
  KEY_ACTION_TYPE,
  MODIFIER_MASKS,
  CLIENT_ROLE
} from '../protocol/constants.mjs';
import {
  encodeMouseMove,
  decodeMouseMove,
  encodeKeyAction,
  decodeKeyAction,
  encodeHeartbeat,
  decodeHeartbeat,
  encodeStreamControl,
  decodeStreamControl
} from '../protocol/packet-codec.mjs';

test('Protocol Codec - MouseMove Encoding & Decoding', (t) => {
  // 1. 正常位移與按鍵
  const original = {
    dx: 120,
    dy: -45,
    wheel: 1,
    buttons: BUTTON_MASKS.LEFT | BUTTON_MASKS.RIGHT,
    seq: 42
  };
  const buf = encodeMouseMove(original);
  assert.equal(buf.length, 8, '滑鼠封包長度必須嚴格為 8 Bytes');
  assert.equal(buf[0], PACKET_TYPE.MOUSE_MOVE_REL, '封包標頭必須為 0x01');

  const decoded = decodeMouseMove(buf);
  assert.equal(decoded.type, PACKET_TYPE.MOUSE_MOVE_REL);
  assert.equal(decoded.dx, 120);
  assert.equal(decoded.dy, -45);
  assert.equal(decoded.wheel, 1);
  assert.equal(decoded.buttons, BUTTON_MASKS.LEFT | BUTTON_MASKS.RIGHT);
  assert.equal(decoded.seq, 42);

  // 2. 極限邊界測試 (INT16 邊界: -32768 ~ 32767)
  const extreme = {
    dx: 40000, // 應被 clamp 為 32767
    dy: -50000, // 應被 clamp 為 -32768
    wheel: -128,
    buttons: 0xFF,
    seq: 255
  };
  const extremeBuf = encodeMouseMove(extreme);
  const extremeDecoded = decodeMouseMove(extremeBuf);
  assert.equal(extremeDecoded.dx, 32767);
  assert.equal(extremeDecoded.dy, -32768);
  assert.equal(extremeDecoded.wheel, -128);
  assert.equal(extremeDecoded.seq, 255);

  // 3. 損壞封包容錯
  assert.throws(() => decodeMouseMove(Buffer.from([0x01, 0x00])), /Invalid mouse packet size/);
  assert.throws(() => decodeMouseMove(Buffer.from([0x99, 0, 0, 0, 0, 0, 0, 0])), /Unexpected packet type/);
});

test('Protocol Codec - KeyAction Encoding & Decoding', (t) => {
  // 測試 Win + D 組合鍵
  const keyAction = {
    action: KEY_ACTION_TYPE.DOWN,
    vkCode: 0x5B, // VK_LWIN
    modifiers: MODIFIER_MASKS.META_WIN,
    seq: 101
  };
  const buf = encodeKeyAction(keyAction);
  assert.equal(buf.length, 6, '鍵盤封包長度必須嚴格為 6 Bytes');
  assert.equal(buf[0], PACKET_TYPE.KEY_ACTION, '封包標頭必須為 0x02');

  const decoded = decodeKeyAction(buf);
  assert.equal(decoded.type, PACKET_TYPE.KEY_ACTION);
  assert.equal(decoded.action, KEY_ACTION_TYPE.DOWN);
  assert.equal(decoded.vkCode, 0x5B);
  assert.equal(decoded.modifiers, MODIFIER_MASKS.META_WIN);
  assert.equal(decoded.seq, 101);

  // 異常尺寸防護
  assert.throws(() => decodeKeyAction(Buffer.alloc(3)), /Invalid key packet size/);
});

test('Protocol Codec - Heartbeat Encoding & Decoding', (t) => {
  const now = 1700000000;
  const hb = {
    role: CLIENT_ROLE.CONSOLE,
    leaseMs: 1500,
    timestamp: now
  };
  const buf = encodeHeartbeat(hb);
  assert.equal(buf.length, 8, '心跳封包長度必須嚴格為 8 Bytes');
  assert.equal(buf[0], PACKET_TYPE.HEARTBEAT, '封包標頭必須為 0x03');

  const decoded = decodeHeartbeat(buf);
  assert.equal(decoded.role, CLIENT_ROLE.CONSOLE);
  assert.equal(decoded.leaseMs, 1500);
  assert.equal(decoded.timestamp, now);
});

test('Protocol Codec - StreamControl Encoding & Decoding', (t) => {
  const ctrl = {
    displayId: 2,
    targetBitrateKbps: 8500,
    fps: 60,
    flags: 0x01
  };
  const buf = encodeStreamControl(ctrl);
  assert.equal(buf.length, 6, '串流控制封包長度必須嚴格為 6 Bytes');

  const decoded = decodeStreamControl(buf);
  assert.equal(decoded.displayId, 2);
  assert.equal(decoded.targetBitrateKbps, 8500);
  assert.equal(decoded.fps, 60);
  assert.equal(decoded.flags, 0x01);
});
