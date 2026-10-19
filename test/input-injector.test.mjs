import test from 'node:test';
import assert from 'node:assert/strict';
import { InputInjector } from '../server/input-injector.mjs';
import { PACKET_TYPE, BUTTON_MASKS, KEY_ACTION_TYPE, MODIFIER_MASKS } from '../protocol/constants.mjs';
import { decodeMouseMove, decodeKeyAction } from '../protocol/packet-codec.mjs';

test('InputInjector - Mock Mode Injection Seam', async (t) => {
  const injector = new InputInjector({ mock: true });
  await injector.start();

  try {
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

    const decodedMouse = decodeMouseMove(injector.injectedEvents[0].raw);
    assert.equal(decodedMouse.dx, 15);
    assert.equal(decodedMouse.dy, -20);
    assert.equal(decodedMouse.buttons, BUTTON_MASKS.LEFT);

    const decodedKey = decodeKeyAction(injector.injectedEvents[1].raw);
    assert.equal(decodedKey.vkCode, 0x41);
    assert.equal(decodedKey.action, KEY_ACTION_TYPE.DOWN);

    assert.equal(injector.injectedEvents[2].type, 0xFF);
  } finally {
    await injector.close();
  }
});

test('InputInjector - Native Win32 Process Execution (Live Reality 物理位移硬鎖)', async (t) => {
  const injector = new InputInjector({ mock: false });
  await injector.start();
  assert.equal(injector.isOpen, true, '原生進程必須成功拉起並處於就緒狀態');

  try {
    // 1. 獲取注入前真實 Windows 游標座標 (Win32 GetCursorPos)
    const posBefore = await injector.getCursorPos();
    console.log(`[Test] 注入前實體座標: (${posBefore?.x}, ${posBefore?.y})`);
    assert.ok(posBefore, '必須成功讀取注入前真實游標座標');

    // 2. 注入實體物理位移 (dx: 30, dy: 30)
    const sentMouse = injector.injectMouseMove({ dx: 30, dy: 30, wheel: 0, buttons: 0, seq: 10 });
    assert.equal(sentMouse, true, '原生 Stdin 管道必須成功寫入滑鼠封包');

    // 等待 50ms 讓 Win32 派發
    await new Promise((r) => setTimeout(r, 50));

    // 3. 獲取注入後真實 Windows 游標座標
    const posAfter = await injector.getCursorPos();
    console.log(`[Test] 注入後實體座標: (${posAfter?.x}, ${posAfter?.y})`);
    assert.ok(posAfter, '必須成功讀取注入後真實游標座標');

    const deltaX = posAfter.x - posBefore.x;
    const deltaY = posAfter.y - posBefore.y;
    console.log(`[Test] 實體座標位移差分: ΔX=${deltaX}, ΔY=${deltaY}`);

    // 物理硬鎖斷言：游標必須真實位移，絕不接受假綠燈！
    assert.notEqual(deltaX, 0, `Windows 游標 X 軸必須發生真實物理位移！before=${posBefore.x}, after=${posAfter.x}`);
    assert.notEqual(deltaY, 0, `Windows 游標 Y 軸必須發生真實物理位移！before=${posBefore.y}, after=${posAfter.y}`);
  } finally {
    await injector.close();
  }
});
