import test from 'node:test';
import assert from 'node:assert/strict';
import { IdleThrottler, THROTTLE_STATE } from '../server/capture/idle-throttler.mjs';

test('IdleThrottler - 狀態機生命週期轉移 (ACTIVE ➔ IDLE ➔ FROZEN)', () => {
  let stateChanges = [];
  const throttler = new IdleThrottler({
    idleTimeoutMs: 500,
    freezeTimeoutMs: 2000,
    activeFps: 60,
    idleFps: 15,
    onStateChange: (newState, prevState) => {
      stateChanges.push({ newState, prevState });
    }
  });

  const baseTime = 10000;
  throttler.recordActivity(baseTime);
  assert.equal(throttler.state, THROTTLE_STATE.ACTIVE);
  assert.equal(throttler.getTargetFps(), 60);

  // 1. 超過 500ms 無活動 ➔ 轉移至 IDLE
  throttler.tick(baseTime + 600);
  assert.equal(throttler.state, THROTTLE_STATE.IDLE);
  assert.equal(throttler.getTargetFps(), 15);

  // 2. 超過 2000ms 無活動 ➔ 轉移至 FROZEN (0 FPS)
  throttler.tick(baseTime + 2100);
  assert.equal(throttler.state, THROTTLE_STATE.FROZEN);
  assert.equal(throttler.getTargetFps(), 0);

  // 狀態變更歷史檢查
  assert.equal(stateChanges.length, 2);
  assert.deepEqual(stateChanges[0], { newState: THROTTLE_STATE.IDLE, prevState: THROTTLE_STATE.ACTIVE });
  assert.deepEqual(stateChanges[1], { newState: THROTTLE_STATE.FROZEN, prevState: THROTTLE_STATE.IDLE });
});

test('IdleThrottler - 瞬間喚醒機制與注幀回調 (Wakeup Callback & 60 FPS Recovery)', () => {
  let wakeupTriggered = false;
  let wakeupData = null;

  const throttler = new IdleThrottler({
    idleTimeoutMs: 500,
    freezeTimeoutMs: 2000,
    onWakeup: (data) => {
      wakeupTriggered = true;
      wakeupData = data;
    }
  });

  const baseTime = 20000;
  throttler.recordActivity(baseTime);
  throttler.tick(baseTime + 2500); // 進入 FROZEN
  assert.equal(throttler.state, THROTTLE_STATE.FROZEN);

  // 模擬滑鼠移動瞬間喚醒
  const wakeupTime = baseTime + 2600;
  throttler.recordActivity(wakeupTime);

  assert.equal(throttler.state, THROTTLE_STATE.ACTIVE);
  assert.equal(throttler.getTargetFps(), 60);
  assert.equal(wakeupTriggered, true);
  assert.equal(wakeupData.fromState, THROTTLE_STATE.FROZEN);
  assert.equal(wakeupData.timestamp, wakeupTime);
});

test('IdleThrottler - shouldDropFrame 節能過濾演算法驗證', () => {
  const throttler = new IdleThrottler({
    idleTimeoutMs: 500,
    freezeTimeoutMs: 2000,
    idleFps: 10 // 每 100ms 允許 1 幀
  });

  const t0 = 30000;
  throttler.recordActivity(t0);

  // 1. 關鍵幀 (IDR) 永遠不丟棄
  assert.equal(throttler.shouldDropFrame(true, t0 + 10), false);

  // 2. 活躍態 (ACTIVE)：普通 P 幀正常送出
  assert.equal(throttler.shouldDropFrame(false, t0 + 20), false);

  // 3. 怠速態 (IDLE)：10 FPS，100ms 內連續來幀應被過濾丟棄
  const tIdle = t0 + 600;
  throttler.tick(tIdle);
  assert.equal(throttler.state, THROTTLE_STATE.IDLE);

  // 第一幀放行
  assert.equal(throttler.shouldDropFrame(false, tIdle), false);
  // 30ms 後的第二幀應被丟棄 (因為未滿 100ms 間隔)
  assert.equal(throttler.shouldDropFrame(false, tIdle + 30), true);
  // 60ms 後仍應丟棄
  assert.equal(throttler.shouldDropFrame(false, tIdle + 60), true);
  // 105ms 後放行
  assert.equal(throttler.shouldDropFrame(false, tIdle + 105), false);

  // 4. 凍結態 (FROZEN)：所有普通 P 幀 100% 丟棄，關鍵幀仍放行
  const tFrozen = t0 + 2500;
  throttler.tick(tFrozen);
  assert.equal(throttler.state, THROTTLE_STATE.FROZEN);
  assert.equal(throttler.shouldDropFrame(false, tFrozen), true);
  assert.equal(throttler.shouldDropFrame(false, tFrozen + 500), true);
  assert.equal(throttler.shouldDropFrame(true, tFrozen + 600), false); // 關鍵幀救命幀放行
});
