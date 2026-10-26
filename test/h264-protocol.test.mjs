import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKET_TYPE,
  PACKET_SIZE,
  STREAM_MAGIC,
  H264_FRAME_FLAGS,
  NALU_TYPE
} from '../protocol/constants.mjs';
import {
  encodeH264Frame,
  decodeH264Frame,
  parseAnnexBNalus
} from '../protocol/packet-codec.mjs';

function makeNaluRaw(type, payloadLength = 16, useThreeByteStart = false) {
  const startCode = useThreeByteStart ? Buffer.from([0x00, 0x00, 0x01]) : Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const header = Buffer.from([type & 0x1F]);
  const payload = Buffer.alloc(payloadLength, 0x5A);
  return Buffer.concat([startCode, header, payload]);
}

test('H.264 Protocol - 標準 Annex-B NALU 封裝與長度前綴校驗 (encodeH264Frame)', (t) => {
  // 1. 已自帶 4-Byte 起始碼之 NALU
  const naluWithStart = makeNaluRaw(NALU_TYPE.IDR, 32);
  const packet1 = encodeH264Frame({
    naluData: naluWithStart,
    seq: 42,
    flags: H264_FRAME_FLAGS.KEYFRAME
  });

  assert.equal(packet1.length, PACKET_SIZE.H264_HEADER + naluWithStart.length);
  assert.equal(packet1[0], STREAM_MAGIC.BYTE1, '魔數 1 必須為 0x44 (D)');
  assert.equal(packet1[1], STREAM_MAGIC.BYTE2, '魔數 2 必須為 0x54 (T)');
  assert.equal(packet1[2], PACKET_TYPE.VIDEO_FRAME_H264, '封包類型必須為 0x06');
  assert.equal(packet1[3], 42, 'seq 幀序號必須對齊');
  assert.equal(packet1[4] & H264_FRAME_FLAGS.KEYFRAME, H264_FRAME_FLAGS.KEYFRAME, 'flags 必須包含 KEYFRAME');
  assert.equal(packet1.readUInt32BE(5), naluWithStart.length, '4-Byte 長度前綴必須精確對齊 payload 長度');

  // 2. 缺少起始碼之裸 NALU (自動補齊 4-Byte 00 00 00 01)
  const bareNalu = Buffer.concat([Buffer.from([NALU_TYPE.NON_IDR]), Buffer.alloc(20, 0xBB)]);
  const packet2 = encodeH264Frame({
    naluData: bareNalu,
    seq: 1,
    enforceStartCode: true
  });

  assert.equal(packet2.length, PACKET_SIZE.H264_HEADER + 4 + bareNalu.length);
  // 驗證 payload 前 4 Bytes 是否補全為 00 00 00 01
  assert.equal(packet2[PACKET_SIZE.H264_HEADER], 0x00);
  assert.equal(packet2[PACKET_SIZE.H264_HEADER + 1], 0x00);
  assert.equal(packet2[PACKET_SIZE.H264_HEADER + 2], 0x00);
  assert.equal(packet2[PACKET_SIZE.H264_HEADER + 3], 0x01);
});

test('H.264 Protocol - NALU 類型萃取與 Flags 自動標記 (SPS, PPS, IDR, P 幀)', (t) => {
  // 1. SPS 自動賦予 CONFIG
  const spsNalu = makeNaluRaw(NALU_TYPE.SPS, 10);
  const spsPacket = encodeH264Frame({ naluData: spsNalu, autoDetect: true });
  assert.equal(Boolean(spsPacket[4] & H264_FRAME_FLAGS.CONFIG), true, 'SPS 必須自動標記 CONFIG');
  assert.equal(Boolean(spsPacket[4] & H264_FRAME_FLAGS.KEYFRAME), false);

  // 2. PPS 自動賦予 CONFIG
  const ppsNalu = makeNaluRaw(NALU_TYPE.PPS, 8);
  const ppsPacket = encodeH264Frame({ naluData: ppsNalu, autoDetect: true });
  assert.equal(Boolean(ppsPacket[4] & H264_FRAME_FLAGS.CONFIG), true, 'PPS 必須自動標記 CONFIG');

  // 3. IDR 自動賦予 KEYFRAME
  const idrNalu = makeNaluRaw(NALU_TYPE.IDR, 40);
  const idrPacket = encodeH264Frame({ naluData: idrNalu, autoDetect: true });
  assert.equal(Boolean(idrPacket[4] & H264_FRAME_FLAGS.KEYFRAME), true, 'IDR 必須自動標記 KEYFRAME');

  // 4. 普通 P 幀 (NON_IDR) 預設無特殊 flags
  const pNalu = makeNaluRaw(NALU_TYPE.NON_IDR, 25);
  const pPacket = encodeH264Frame({ naluData: pNalu, autoDetect: true });
  assert.equal(pPacket[4], H264_FRAME_FLAGS.NONE, '普通 P 幀 flags 應為 NONE');
});

test('H.264 Protocol - 複合封包 (SPS + PPS + IDR) 批量解析與零拷貝截取 (decodeH264Frame)', (t) => {
  const sps = makeNaluRaw(NALU_TYPE.SPS, 12, false); // 4-byte start
  const pps = makeNaluRaw(NALU_TYPE.PPS, 8, true);   // 3-byte start
  const idr = makeNaluRaw(NALU_TYPE.IDR, 64, false); // 4-byte start
  const compoundPayload = Buffer.concat([sps, pps, idr]);

  const packet = encodeH264Frame({
    naluData: compoundPayload,
    seq: 99,
    autoDetect: true
  });

  const decoded = decodeH264Frame(packet);
  assert.equal(decoded.type, PACKET_TYPE.VIDEO_FRAME_H264);
  assert.equal(decoded.seq, 99);
  assert.equal(decoded.isKeyframe, true);
  assert.equal(decoded.isConfig, true);
  assert.equal(decoded.nalus.length, 3);

  assert.equal(decoded.nalus[0].type, NALU_TYPE.SPS);
  assert.equal(decoded.nalus[1].type, NALU_TYPE.PPS);
  assert.equal(decoded.nalus[2].type, NALU_TYPE.IDR);

  // 零拷貝檢驗：decoded.payload 與 decoded.nalus[0].raw 共享底層記憶體
  assert.equal(decoded.payload.buffer, packet.buffer, '零拷貝斷言: payload 必須與原 packet 共享 ArrayBuffer');
  assert.equal(decoded.nalus[0].raw.buffer, packet.buffer, '零拷貝斷言: NALU 切片必須共享 ArrayBuffer');
});

test('H.264 Protocol - 1MB 大尺寸 NALU 極限吞吐與長度邊界保護', (t) => {
  const ONE_MB = 1024 * 1024;
  const bigPayload = Buffer.alloc(ONE_MB, 0x7E);
  // 前置 4-Byte 起始碼 + IDR Header
  bigPayload[0] = 0x00;
  bigPayload[1] = 0x00;
  bigPayload[2] = 0x00;
  bigPayload[3] = 0x01;
  bigPayload[4] = NALU_TYPE.IDR;

  const t0 = performance.now();
  const bigPacket = encodeH264Frame({
    naluData: bigPayload,
    seq: 120,
    autoDetect: true
  });
  const encodeDuration = performance.now() - t0;

  assert.equal(bigPacket.length, PACKET_SIZE.H264_HEADER + ONE_MB);

  const t1 = performance.now();
  const decoded = decodeH264Frame(bigPacket);
  const decodeDuration = performance.now() - t1;

  assert.equal(decoded.payloadLength, ONE_MB);
  assert.equal(decoded.nalus.length, 1);
  assert.equal(decoded.nalus[0].type, NALU_TYPE.IDR);
  assert.equal(decoded.payload[decoded.payloadLength - 1], 0x7E, '首尾數據完整性校驗');

  console.log(`[Test] 1MB NALU 編碼耗時: ${encodeDuration.toFixed(2)}ms, 解碼耗時: ${decodeDuration.toFixed(2)}ms`);

  // 異常超大長度保護 (>10MB 拒絕)
  assert.throws(() => {
    encodeH264Frame({ naluData: Buffer.alloc(11 * 1024 * 1024) });
  }, /exceeds max limit/);
});

test('H.264 Protocol - 雙端合約二進制對齊與畸變容錯 (Android <-> Node.js 網絡字節序)', (t) => {
  // 1. 模擬 Android PacketBuilder.buildH264Frame 產生的二進制 byte array
  // Header 9B: [0x44, 0x54][0x06][seq: 128][flags: 0x03 (KEYFRAME|CONFIG)][len: uint32BE 18]
  const androidHeader = Buffer.from([
    0x44, 0x54,
    0x06,
    128,
    0x03, // FLAG_KEYFRAME (0x01) | FLAG_CONFIG (0x02)
    0x00, 0x00, 0x00, 18
  ]);
  const androidNalu = makeNaluRaw(NALU_TYPE.IDR, 13); // 4 + 1 + 13 = 18 bytes
  const androidWirePacket = Buffer.concat([androidHeader, androidNalu]);

  const parsed = decodeH264Frame(androidWirePacket);
  assert.equal(parsed.seq, 128, 'Android 端發送的 seq=128 必須在 Node.js 端無失真還原');
  assert.equal(parsed.isKeyframe, true);
  assert.equal(parsed.isConfig, true);
  assert.equal(parsed.payloadLength, 18);

  // 2. 畸變容錯: 魔數損壞 (非 0x44 0x54)
  const corruptedMagic = Buffer.from(androidWirePacket);
  corruptedMagic[0] = 0x00;
  assert.throws(() => {
    decodeH264Frame(corruptedMagic);
  }, /Invalid stream magic/);

  // 3. 畸變容錯: 類型非 VIDEO_FRAME_H264
  const wrongType = Buffer.from(androidWirePacket);
  wrongType[2] = 0x01; // MOUSE_MOVE
  assert.throws(() => {
    decodeH264Frame(wrongType);
  }, /Unexpected packet type/);

  // 4. 畸變容錯: 封包截斷 (半包)
  const truncated = androidWirePacket.subarray(0, 15); // 少於 9 + 18
  assert.throws(() => {
    decodeH264Frame(truncated);
  }, /Truncated H264 packet/);
});
