import test from 'node:test';
import assert from 'node:assert/strict';
import { ScreenCaptureManager } from '../server/capture/screen-capture-manager.mjs';
import { TopologyProbe } from '../server/capture/topology-probe.mjs';
import { EncoderAdapter } from '../server/capture/encoder-adapter.mjs';
import { AbrController } from '../server/capture/abr-controller.mjs';
import { ENCODER_BACKEND, ABR_CONFIG } from '../server/capture/capture-constants.mjs';

test('TopologyProbe - Live Reality 實體螢幕拓撲探針 (Win32 多螢幕幾何)', async (t) => {
  const probe = new TopologyProbe();
  const screens = probe.getScreens();
  console.log(`[Test] 偵測到實體螢幕數量: ${screens.length}`);
  screens.forEach((s, idx) => {
    console.log(`[Test] 螢幕 #${idx + 1}: ${s.name}, Primary=${s.isPrimary}, 幾何=(${s.bounds.x}, ${s.bounds.y}, ${s.bounds.width}x${s.bounds.height})`);
  });

  assert.ok(screens.length >= 1, '必須至少偵測到 1 個實體顯示器');
  assert.ok(screens.some(s => s.isPrimary), '必須有且僅有 1 個主螢幕 (Primary Display)');

  const topology = probe.getDualScreenTopology();
  assert.ok(topology.consoleScreen, '必須成功指派 Console 主螢幕');
  assert.equal(topology.consoleScreen.isPrimary, true, 'Console 螢幕必須是 Primary');

  if (screens.length >= 2) {
    assert.ok(topology.displayScreen, '多螢幕環境下必須成功指派延伸副螢幕');
    console.log(`[Test] 智慧選定主力副螢幕: ${topology.displayScreen.name} (${topology.displayScreen.bounds.width}x${topology.displayScreen.bounds.height})`);
    // 在現場 3 螢幕下，驗證選中的副螢幕解析度不是 800x600，而是較大的 1920x1080
    assert.ok(topology.displayScreen.bounds.width >= 1024, '副螢幕必須智慧挑選較高解析度的主力顯示器！');
  }

  // 驗證 TTL 快取有效性 (第二遍呼叫應為同一引用且 0ms)
  const cachedScreens = probe.getScreens();
  assert.equal(cachedScreens, screens, '在 TTL 窗口內重複呼叫必須直接命中記憶體快取！');
});

test('EncoderAdapter - Live Reality 真機 GPU 探測與編碼階梯解析', async (t) => {
  const adapter = new EncoderAdapter();
  const available = await adapter.probeBackends();
  console.log(`[Test] 真機可用硬體編碼階梯: ${JSON.stringify(available)}`);

  assert.ok(available.length >= 1, '可用編碼清單必須非空');
  assert.ok(available.includes(ENCODER_BACKEND.SOFTWARE), '軟體編碼必須作為最後保險絲恆久可用');

  const resolved = await adapter.resolveEncoder();
  console.log(`[Test] 初始選定最佳編碼器: ${resolved.backend} (FFmpeg: ${resolved.ffmpegCodec})`);
  assert.ok(resolved.backend, '必須選定合法的編碼器後端');
  assert.ok(resolved.ffmpegCodec, '必須映射出對應的 FFmpeg 編碼參數');
});

test('EncoderAdapter - GPU 故障動態平滑備援降級鏈 (Failover & Fallback)', async (t) => {
  // 建立包含 NVENC, QSV, SOFTWARE 階梯的受控探針
  const adapter = new EncoderAdapter({
    supportedBackends: [ENCODER_BACKEND.NVENC, ENCODER_BACKEND.QSV, ENCODER_BACKEND.SOFTWARE]
  });

  const first = await adapter.resolveEncoder(ENCODER_BACKEND.NVENC);
  assert.equal(first.backend, ENCODER_BACKEND.NVENC);
  assert.equal(first.ffmpegCodec, 'h264_nvenc');

  // 模擬第 1 次 GPU 故障 (例如 TDR 設備丟失) -> 自動無感降級至 QSV
  const second = await adapter.fallback();
  console.log(`[Test] 第 1 次降級至: ${second.backend}`);
  assert.equal(second.backend, ENCODER_BACKEND.QSV);
  assert.equal(second.ffmpegCodec, 'h264_qsv');

  // 模擬第 2 次故障 -> 自動無感降級至 SOFTWARE (CPU 軟解)
  const third = await adapter.fallback();
  console.log(`[Test] 第 2 次降級至: ${third.backend}`);
  assert.equal(third.backend, ENCODER_BACKEND.SOFTWARE);
  assert.equal(third.ffmpegCodec, 'libx264');
  assert.equal(third.isHardwareAccelerated, false);
});

test('AbrController - 動態頻寬自適應 (擁塞快速降碼率 + 防抖平滑回升)', async (t) => {
  const abr = new AbrController({ defaultBitrate: 12000, minBitrate: 2000, maxBitrate: 25000 });
  assert.equal(abr.currentBitrate, 12000);
  assert.equal(abr.currentFps, 60);

  // 1. 網路良好但未滿 3 次防抖 -> 保持預設
  let res = abr.feedMetrics({ rttMs: 12, packetLoss: 0 });
  assert.equal(res.bitrateKbps, 12000);
  assert.equal(res.isCongested, false);

  // 2. 突發嚴重網路擁塞 (RTT 70ms + 丟包 5%) -> 立即啟動快速降碼率與降幀
  res = abr.feedMetrics({ rttMs: 70, packetLoss: 0.05 });
  console.log(`[Test] 網路擁塞降級: Bitrate=${res.bitrateKbps} Kbps, FPS=${res.fps}, Congested=${res.isCongested}`);
  assert.equal(res.isCongested, true);
  assert.ok(res.bitrateKbps < 12000, '碼率必須明顯下調');
  assert.equal(res.fps, 30, '嚴重擁塞時幀率必須降至 30fps 以保障控制延遲');

  // 3. 網路恢復極佳 (RTT 10ms, 丟包 0) 持續 3 次 -> 觸發平滑防抖回升
  abr.feedMetrics({ rttMs: 10, packetLoss: 0 }); // 第 1 次
  abr.feedMetrics({ rttMs: 10, packetLoss: 0 }); // 第 2 次
  const recovered = abr.feedMetrics({ rttMs: 10, packetLoss: 0 }); // 第 3 次 (窗口滿足)

  console.log(`[Test] 網路恢復回升: Bitrate=${recovered.bitrateKbps} Kbps, FPS=${recovered.fps}, Congested=${recovered.isCongested}`);
  assert.equal(recovered.isCongested, false);
  assert.equal(recovered.fps, 60, '幀率必須恢復為 60fps');
  assert.ok(recovered.bitrateKbps > res.bitrateKbps, '碼率必須平滑上升');

  // 4. 防抖驗證：第 4 次良好指標（計數器剛重置為 0，窗口未滿 3）-> 碼率應維持不變！
  const nextGood = abr.feedMetrics({ rttMs: 10, packetLoss: 0 }); // 第 1 次（新週期）
  assert.equal(nextGood.bitrateKbps, recovered.bitrateKbps, '窗口重置後未滿 3 次絕不可連續狂飆碼率！');
});

test('ScreenCaptureManager - 全鏈路初始化與雙通道調度', async (t) => {
  const manager = new ScreenCaptureManager();
  const initResult = await manager.initialize();

  console.log(`[Test] Manager 初始化完成: DualScreen=${initResult.isDualScreen}, Encoder=${initResult.encoder.backend}`);
  assert.ok(manager.isCapturing, '管理器必須處於捕獲運行狀態');
  assert.ok(initResult.topology.consoleScreen, '必須成功指派 Console 螢幕');

  // 測試 Console 串流的網路反饋
  const abrRes = manager.handleNetworkFeedback('console', { rttMs: 40, packetLoss: 0.04 });
  assert.equal(abrRes.isCongested, true);

  await manager.stop();
  assert.equal(manager.isCapturing, false);
});
