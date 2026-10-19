import test from 'node:test';
import assert from 'node:assert/strict';
import {
  KEY_ACTION_TYPE,
  BUTTON_MASKS,
  MODIFIER_MASKS
} from '../protocol/constants.mjs';
import { InputStateMachine } from '../protocol/input-state-machine.mjs';

test('InputStateMachine - Key Down/Up state tracking', (t) => {
  const sm = new InputStateMachine({ leaseMs: 1000 });

  // 1. 按下 Win 鍵 (0x5B)
  const downRes = sm.processKeyAction({
    action: KEY_ACTION_TYPE.DOWN,
    vkCode: 0x5B,
    modifiers: MODIFIER_MASKS.META_WIN
  });
  assert.equal(downRes.action, KEY_ACTION_TYPE.DOWN);
  assert.equal(downRes.vkCode, 0x5B);

  let snap = sm.getSnapshot();
  assert.equal(snap.activeKeyCount, 1);
  assert.deepEqual(snap.activeKeys, [0x5B]);

  // 2. 按下 D 鍵 (0x44)
  sm.processKeyAction({
    action: KEY_ACTION_TYPE.DOWN,
    vkCode: 0x44,
    modifiers: MODIFIER_MASKS.META_WIN
  });
  snap = sm.getSnapshot();
  assert.equal(snap.activeKeyCount, 2);

  // 3. 釋放 D 鍵
  sm.processKeyAction({
    action: KEY_ACTION_TYPE.UP,
    vkCode: 0x44,
    modifiers: MODIFIER_MASKS.META_WIN
  });
  snap = sm.getSnapshot();
  assert.equal(snap.activeKeyCount, 1);
  assert.deepEqual(snap.activeKeys, [0x5B]);
});

test('InputStateMachine - Mouse Button Delta Tracking', (t) => {
  const sm = new InputStateMachine();

  // 1. 移動並按下左鍵
  const r1 = sm.processMouseMove({
    dx: 10,
    dy: -5,
    wheel: 0,
    buttons: BUTTON_MASKS.LEFT
  });
  assert.equal(r1.pressedButtons, BUTTON_MASKS.LEFT);
  assert.equal(r1.releasedButtons, BUTTON_MASKS.NONE);

  // 2. 保持左鍵，同時按下右鍵
  const r2 = sm.processMouseMove({
    dx: 0,
    dy: 0,
    wheel: 0,
    buttons: BUTTON_MASKS.LEFT | BUTTON_MASKS.RIGHT
  });
  assert.equal(r2.pressedButtons, BUTTON_MASKS.RIGHT);
  assert.equal(r2.releasedButtons, BUTTON_MASKS.NONE);

  // 3. 釋放左鍵，保留右鍵
  const r3 = sm.processMouseMove({
    dx: 2,
    dy: 2,
    wheel: 0,
    buttons: BUTTON_MASKS.RIGHT
  });
  assert.equal(r3.pressedButtons, BUTTON_MASKS.NONE);
  assert.equal(r3.releasedButtons, BUTTON_MASKS.LEFT);
});

test('InputStateMachine - Lease Watchdog & Emergency Release (防黏鍵硬鎖)', (t) => {
  let emergencyTriggered = false;
  let receivedRelease = null;

  const sm = new InputStateMachine({
    leaseMs: 500,
    onEmergencyRelease: (list) => {
      emergencyTriggered = true;
      receivedRelease = list;
    }
  });

  const baseTime = 100000;
  sm.touch(baseTime);

  // 模擬按住 Ctrl (0x11) 與滑鼠左鍵
  sm.processKeyAction({ action: KEY_ACTION_TYPE.DOWN, vkCode: 0x11, modifiers: MODIFIER_MASKS.CTRL, timestamp: baseTime });
  sm.processMouseMove({ dx: 0, dy: 0, wheel: 0, buttons: BUTTON_MASKS.LEFT, timestamp: baseTime });

  assert.equal(sm.getSnapshot().activeKeyCount, 1);
  assert.equal(sm.getSnapshot().activeMouseButtons, BUTTON_MASKS.LEFT);

  // 經過 300ms (未超時)
  const r1 = sm.checkLease(baseTime + 300);
  assert.equal(r1, null);
  assert.equal(emergencyTriggered, false);

  // 經過 600ms (已超時 500ms 租約)
  const r2 = sm.checkLease(baseTime + 600);
  assert.notEqual(r2, null);
  assert.equal(emergencyTriggered, true);
  assert.equal(receivedRelease.reason, 'LEASE_EXPIRED');
  assert.deepEqual(receivedRelease.keysToRelease, [0x11]);
  assert.equal(receivedRelease.mouseToRelease, BUTTON_MASKS.LEFT);

  // 斷言內部狀態已被自動清空，杜絕黏鍵
  const snapAfter = sm.getSnapshot();
  assert.equal(snapAfter.activeKeyCount, 0);
  assert.equal(snapAfter.activeMouseButtons, BUTTON_MASKS.NONE);
  assert.equal(snapAfter.isEmergencyReleased, true);

  // 再次檢查不重複觸發
  const r3 = sm.checkLease(baseTime + 800);
  assert.equal(r3, null);
});
