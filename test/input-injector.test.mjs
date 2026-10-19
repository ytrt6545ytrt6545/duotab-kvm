import test from 'node:test';
import assert from 'node:assert/strict';
import { InputInjector } from '../server/input-injector.mjs';
import { PACKET_TYPE, BUTTON_MASKS, KEY_ACTION_TYPE, MODIFIER_MASKS } from '../protocol/constants.mjs';
import { decodeMouseMove, decodeKeyAction } from '../protocol/packet-codec.mjs';

test('InputInjector - Mock Mode Injection Seam', async (t) => {
  const injector = new InputInjector({ mock: true });
  await injector.start();

  // 1. 注入滑鼠事件
  const mouseEvt = { dx: 15, dy: -20, wheel: 0, buttons: BUTTON_MASKS.LEFT, seq: 1 };
  const ok1 = injector.injectMouseMove(mouseEvt);
  assert.equal(ok1, true);

  // 2. 注入鍵盤事件
  const keyEvt = { action: KEY_ACTION_TYPE.DOWN, vkCode: 0x41, modifiers: MODIFIER_MASKS.NONE, seq: 2 };
  const ok2 = injector.injectKeyAction(keyEvt);
  assert.equal(ok2, true);

  // 3. 觸發急停
  const ok3 = injector.emergencyRelease();
  assert.equal(ok3, true);

  assert.equal(injector.injectedEvents.length, 3);

  // 檢驗注入的二進制內容是否正確解碼
  const decodedMouse = decodeMouseMove(injector.injectedEvents[0].raw);
  assert.equal(decodedMouse.dx, 15);
  assert.equal(decodedMouse.dy, -20);
  assert.equal(decodedMouse.buttons, BUTTON_MASKS.LEFT);

  const decodedKey = decodeKeyAction(injector.injectedEvents[1].raw);
  assert.equal(decodedKey.vkCode, 0x41);
  assert.equal(decodedKey.action, KEY_ACTION_TYPE.DOWN);

  assert.equal(injector.injectedEvents[2].type, 0xFF);

  injector.close();
});

test('InputInjector - Native Win32 Process Execution (Live Reality)', async (t) => {
  const injector = new InputInjector({ mock: false });
  await injector.start();
  assert.equal(injector.isOpen, true, '原生進程必須成功拉起並處於就緒狀態');

  // 注入一次微幅相對位移 (dx: 1, dy: 1)
  const sentMouse = injector.injectMouseMove({ dx: 1, dy: 1, wheel: 0, buttons: 0, seq: 10 });
  assert.equal(sentMouse, true, '原生 Stdin 管道必須成功寫入滑鼠封包');

  // 注入急停釋放
  const sentRelease = injector.emergencyRelease();
  assert.equal(sentRelease, true, '急停信令必須成功寫入');

  // 關閉並驗證清理
  await injector.close();
  assert.equal(injector.isOpen, false);
});
