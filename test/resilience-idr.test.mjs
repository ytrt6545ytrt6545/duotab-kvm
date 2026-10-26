import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKET_TYPE,
  STREAM_CONTROL_FLAGS
} from '../protocol/constants.mjs';
import {
  encodeStreamControl,
  decodeStreamControl
} from '../protocol/packet-codec.mjs';
import { AbrController } from '../server/capture/abr-controller.mjs';
import { NetworkCoordinator } from '../server/network/network-coordinator.mjs';

test('Resilience - STREAM_CONTROL 編解碼與 REQUEST_IDR_KEYFRAME 旗標驗證', () => {
  // 1. 標準 REQUEST_IDR_KEYFRAME (0x01)
  const buf1 = encodeStreamControl({
    displayId: 0,
    targetBitrateKbps: 0,
    fps: 30,
    flags: STREAM_CONTROL_FLAGS.REQUEST_IDR_KEYFRAME
  });
  assert.equal(buf1.length, 6);
  assert.equal(buf1[0], PACKET_TYPE.STREAM_CONTROL);
  assert.equal(buf1[5], 0x01);

  const decoded1 = decodeStreamControl(buf1);
  assert.equal(decoded1.displayId, 0);
  assert.equal((decoded1.flags & STREAM_CONTROL_FLAGS.REQUEST_IDR_KEYFRAME) !== 0, true);

  // 2. 向後相容別名 REQUEST_IDR (0x08)
  const buf2 = encodeStreamControl({
    displayId: 1,
    targetBitrateKbps: 2000,
    fps: 60,
    flags: STREAM_CONTROL_FLAGS.REQUEST_IDR
  });
  const decoded2 = decodeStreamControl(buf2);
  assert.equal(decoded2.displayId, 1);
  assert.equal(decoded2.targetBitrateKbps, 2000);
  assert.equal((decoded2.flags & STREAM_CONTROL_FLAGS.REQUEST_IDR) !== 0, true);
});

test('Resilience - AbrController 丟包自癒與動態降碼率協同 (Instant Recovery)', () => {
  const abr = new AbrController({
    defaultBitrate: 10000,
    minBitrate: 2000,
    maxBitrate: 20000
  });

  assert.equal(abr.currentBitrate, 10000);
  assert.equal(abr.currentFps, 60);
  assert.equal(abr.isCongested, false);

  // 1. 模擬突發丟包 (8% 丟包率，超過 5% 門檻)
  const snap1 = abr.feedMetrics({ rttMs: 25, packetLoss: 0.08 });
  assert.equal(snap1.isCongested, true);
  // 嚴重丟包立即砍 30% 碼率: 10000 * 0.7 = 7000
  assert.equal(abr.currentBitrate, 7000);

  // 2. 連續丟包觸發幀率降至 30fps
  abr.feedMetrics({ rttMs: 30, packetLoss: 0.06 });
  const snap3 = abr.feedMetrics({ rttMs: 35, packetLoss: 0.07 });
  assert.equal(snap3.fps, 30);
  assert.equal(abr.currentBitrate < 7000, true);

  // 3. 網路恢復 (延遲 <= 15ms，無丟包)，需連續 3 次良好指標才平滑回升 (防抖 Hysteresis)
  abr.feedMetrics({ rttMs: 12, packetLoss: 0 });
  assert.equal(abr.currentFps, 30); // 尚未到 3 次良好，保持防護

  abr.feedMetrics({ rttMs: 14, packetLoss: 0 });
  const recoverySnap = abr.feedMetrics({ rttMs: 10, packetLoss: 0 }); // 第 3 次良好
  assert.equal(recoverySnap.isCongested, false);
  assert.equal(recoverySnap.fps, 60); // 恢復 60 FPS
  assert.equal(recoverySnap.bitrateKbps > 3000, true); // 碼率平滑回升
});

test('Resilience - NetworkCoordinator 主動自癒 requestIdr 與配置集快照重發', () => {
  // 建立 Mock 注入器與捕獲器
  const mockInjector = {
    isOpen: true,
    start: async () => {},
    close: async () => {},
    injectMouseMove: () => {},
    injectKeyAction: () => {},
    emergencyRelease: () => {}
  };

  const mockCaptureManager = {
    initialize: async () => ({ topology: {}, encoder: 'mock', isDualScreen: false }),
    stop: async () => {},
    handleNetworkFeedback: (streamType, metrics) => ({ streamType, metrics })
  };

  const coordinator = new NetworkCoordinator({
    inputInjector: mockInjector,
    captureManager: mockCaptureManager
  });

  // 模擬緩存 SPS/PPS 配置集
  const fakeSpsPps = Buffer.from([0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1f, 0x00, 0x00, 0x00, 0x01, 0x68, 0xce, 0x3c, 0x80]);
  coordinator._cachedConfigNalus.set('console', fakeSpsPps);

  // 模擬已連線客戶端 Socket
  const writtenData = [];
  const mockSocket = {
    destroyed: false,
    writable: true,
    cork: () => {},
    uncork: () => {},
    write: (chunk) => { writtenData.push(chunk); }
  };
  coordinator.clients.console = { socket: mockSocket };

  // 觸發自癒
  const result = coordinator.requestIdr('console');
  assert.equal(result.streamType, 'console');
  assert.equal(result.metrics.packetLoss, 0.08);

  // 斷言 SPS/PPS 封包被寫入 Socket
  assert.equal(writtenData.length >= 2, true);
  const header = writtenData[0];
  assert.equal(header[0], 0x44); // 'D'
  assert.equal(header[1], 0x54); // 'T'
  assert.equal(header[2], 0x06); // VIDEO_FRAME_H264
  assert.equal(header[4], 0x02); // isConfig
  assert.equal(header.readUInt32BE(5), fakeSpsPps.length);
  assert.deepEqual(writtenData[1], fakeSpsPps);
});

test('Resilience - Android 端丟包序號跳躍偵測演算法驗證 (0~255 環狀回繞)', () => {
  function detectLoss(lastSeq, newSeq) {
    if (lastSeq === -1) return false;
    const expected = (lastSeq + 1) & 0xFF;
    return newSeq !== expected;
  }

  // 1. 正常連續幀
  assert.equal(detectLoss(10, 11), false);
  assert.equal(detectLoss(255, 0), false); // 環狀回繞正常

  // 2. 發生丟包 (跳號)
  assert.equal(detectLoss(10, 12), true); // 漏掉 11
  assert.equal(detectLoss(254, 0), true);  // 漏掉 255
  assert.equal(detectLoss(255, 2), true);  // 漏掉 0, 1
});
