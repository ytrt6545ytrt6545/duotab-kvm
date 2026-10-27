import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessPerfMonitor } from '../server/capture/perf-monitor.mjs';

test('ProcessPerfMonitor - 初始狀態與 PID 切換防護', () => {
  const monitor = new ProcessPerfMonitor({
    cpuCount: 8
  });

  // 1. 未指定 PID 時應為空載指標
  const initial = monitor.getMetrics();
  assert.equal(initial.cpuPercent, '--');
  assert.equal(initial.gpuPercent, '--');
  assert.equal(initial.isAvailable, false);

  // 2. 指定 PID 後重置
  monitor.setTargetPid(1234);
  assert.equal(monitor.targetPid, 1234);

  // 3. 清除 PID 回復為空載
  monitor.setTargetPid(null);
  assert.equal(monitor.getMetrics().isAvailable, false);
});

test('ProcessPerfMonitor - 非同步採樣與 CPU / GPU 算力公式校驗', async () => {
  let sampleIndex = 0;
  const mockRunner = async (pid) => {
    sampleIndex++;
    if (sampleIndex === 1) {
      // 第一次採樣: 累計 10.0 秒 CPU, GPU 15.5%, 記憶體 45MB
      return '10.0,15.5,45.2';
    } else {
      // 2 秒後第二次採樣: 累計 10.32 秒 CPU (增長 0.32 秒), GPU 18.2%, 記憶體 46MB
      return '10.32,18.2,46.0';
    }
  };

  const monitor = new ProcessPerfMonitor({
    targetPid: 9999,
    cpuCount: 8, // 8 核心
    queryRunner: mockRunner
  });

  const t0 = 100000;
  // 首次採樣 (建立 baseline，CPU 顯示 0.0)
  await monitor.sample(t0);
  let m = monitor.getMetrics();
  assert.equal(m.cpuPercent, '0.0');
  assert.equal(m.gpuPercent, '15.5');
  assert.equal(m.memoryMb, '45.2');
  assert.equal(m.isAvailable, true);

  // 2000ms 後二次採樣
  // deltaCpu = 0.32s, deltaTime = 2s, 8 cores:
  // cpuPct = (0.32 / (2 * 8)) * 100 = 2.0%
  const t1 = t0 + 2000;
  await monitor.sample(t1);
  m = monitor.getMetrics();
  assert.equal(m.cpuPercent, '2.0');
  assert.equal(m.gpuPercent, '18.2');
  assert.equal(m.memoryMb, '46.0');
});

test('ProcessPerfMonitor - 查詢腳本異常容錯防護', async () => {
  const failingRunner = async () => {
    throw new Error('Command failed: Timeout');
  };

  const monitor = new ProcessPerfMonitor({
    targetPid: 8888,
    queryRunner: failingRunner
  });

  // 異常不應拋出未捕獲錯誤，保持既有安全快取
  await monitor.sample();
  const m = monitor.getMetrics();
  assert.equal(m.isAvailable, false);
});
