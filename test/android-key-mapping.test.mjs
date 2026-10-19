import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ANDROID_KEYCODES,
  WINDOWS_VK,
  androidToWindowsVk,
  androidButtonsToWindows,
  androidMetaStateToModifiers
} from '../protocol/android-keycodes.mjs';
import { BUTTON_MASKS, MODIFIER_MASKS, KEY_ACTION_TYPE } from '../protocol/constants.mjs';
import { encodeKeyAction, decodeKeyAction, encodeMouseMove, decodeMouseMove } from '../protocol/packet-codec.mjs';
import { InputStateMachine } from '../protocol/input-state-machine.mjs';

test('Android Key Mapping - Core Windows Shortcuts (Win+D, Alt+Tab, Ctrl+C)', (t) => {
  // 1. 驗證 Win 鍵 (Meta) 映射
  const winKey = androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_META_LEFT);
  assert.equal(winKey, WINDOWS_VK.VK_LWIN, 'Android KEYCODE_META_LEFT 必須精準對應 Windows VK_LWIN (0x5B)');

  const dKey = androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_D);
  assert.equal(dKey, WINDOWS_VK.VK_D, 'Android KEYCODE_D 必須精準對應 Windows VK_D (0x44)');

  // 2. 驗證 Alt+Tab 映射
  const altKey = androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_ALT_LEFT);
  assert.equal(altKey, WINDOWS_VK.VK_LMENU, 'Android KEYCODE_ALT_LEFT 必須對應 Windows VK_LMENU');

  const tabKey = androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_TAB);
  assert.equal(tabKey, WINDOWS_VK.VK_TAB, 'Android KEYCODE_TAB 必須對應 Windows VK_TAB');

  // 3. 驗證 Ctrl 鍵
  const ctrlKey = androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_CTRL_LEFT);
  assert.equal(ctrlKey, WINDOWS_VK.VK_LCONTROL, 'Android KEYCODE_CTRL_LEFT 必須對應 Windows VK_LCONTROL');

  // 4. 驗證 Backspace 與 Delete
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_DEL), WINDOWS_VK.VK_BACK);
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_FORWARD_DEL), WINDOWS_VK.VK_DELETE);
});

test('Android Key Mapping - Function Keys (F1~F12) & Arrow Keys', (t) => {
  // 驗證 F1 ~ F12 連續對齊
  for (let i = 1; i <= 12; i++) {
    const androidCode = ANDROID_KEYCODES[`KEYCODE_F${i}`];
    const expectedVk = WINDOWS_VK[`VK_F${i}`];
    assert.equal(
      androidToWindowsVk(androidCode),
      expectedVk,
      `F${i} 鍵碼映射錯誤: Android=${androidCode}, Expected VK=${expectedVk}`
    );
  }

  // 驗證方向鍵
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_DPAD_UP), WINDOWS_VK.VK_UP);
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_DPAD_DOWN), WINDOWS_VK.VK_DOWN);
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_DPAD_LEFT), WINDOWS_VK.VK_LEFT);
  assert.equal(androidToWindowsVk(ANDROID_KEYCODES.KEYCODE_DPAD_RIGHT), WINDOWS_VK.VK_RIGHT);
});

test('Android Mouse & Modifier Translation - 5 Buttons & MetaState', (t) => {
  // 1. Android 按鈕遮罩轉 Windows 按鈕遮罩
  assert.equal(androidButtonsToWindows(1), BUTTON_MASKS.LEFT);
  assert.equal(androidButtonsToWindows(2), BUTTON_MASKS.RIGHT);
  assert.equal(androidButtonsToWindows(4), BUTTON_MASKS.MIDDLE);
  assert.equal(androidButtonsToWindows(8), BUTTON_MASKS.BACK);
  assert.equal(androidButtonsToWindows(16), BUTTON_MASKS.FORWARD);
  // 多鍵組合 (左鍵 + 右鍵 + 側鍵前進)
  assert.equal(
    androidButtonsToWindows(1 | 2 | 16),
    BUTTON_MASKS.LEFT | BUTTON_MASKS.RIGHT | BUTTON_MASKS.FORWARD
  );

  // 2. Android 修飾鍵 (MetaState) 轉換
  // Meta/Win: 0x10000 (META_META_ON)
  assert.equal(androidMetaStateToModifiers(0x10000), MODIFIER_MASKS.META_WIN);
  // Ctrl: 0x1000 (META_CTRL_ON)
  assert.equal(androidMetaStateToModifiers(0x1000), MODIFIER_MASKS.CTRL);
  // Alt: 0x02 (META_ALT_ON)
  assert.equal(androidMetaStateToModifiers(0x02), MODIFIER_MASKS.ALT);
  // Shift: 0x01 (META_SHIFT_ON)
  assert.equal(androidMetaStateToModifiers(0x01), MODIFIER_MASKS.SHIFT);
  // 複合 (Ctrl + Shift + Win)
  assert.equal(
    androidMetaStateToModifiers(0x1000 | 0x01 | 0x10000),
    MODIFIER_MASKS.CTRL | MODIFIER_MASKS.SHIFT | MODIFIER_MASKS.META_WIN
  );
});

test('Android to PC Round-Trip - 全鏈路二進制閉環驗證 (Win+D 注入狀態機)', (t) => {
  const sm = new InputStateMachine();

  // 1. 模擬 Android 平板接收 OTG 實體按鍵: Left Windows Key Down
  const androidWinCode = ANDROID_KEYCODES.KEYCODE_META_LEFT;
  const vkWin = androidToWindowsVk(androidWinCode);
  const modsWin = androidMetaStateToModifiers(0x10000); // MetaState 包含 Meta 鍵

  // Android 打包二進制
  const winPacket = encodeKeyAction({
    action: KEY_ACTION_TYPE.DOWN,
    vkCode: vkWin,
    modifiers: modsWin,
    seq: 1
  });

  // PC 端解碼
  const decodedWin = decodeKeyAction(winPacket);
  assert.equal(decodedWin.vkCode, 0x5B); // VK_LWIN
  assert.equal(decodedWin.action, KEY_ACTION_TYPE.DOWN);

  // 餵入 PC 端狀態機
  sm.processKeyAction(decodedWin);
  assert.equal(sm.getSnapshot().activeKeyCount, 1);
  assert.ok(sm.getSnapshot().activeKeys.includes(0x5B));

  // 2. 模擬 Android 接收 D Key Down
  const androidDCode = ANDROID_KEYCODES.KEYCODE_D;
  const vkD = androidToWindowsVk(androidDCode);
  const dPacket = encodeKeyAction({
    action: KEY_ACTION_TYPE.DOWN,
    vkCode: vkD,
    modifiers: modsWin,
    seq: 2
  });

  const decodedD = decodeKeyAction(dPacket);
  assert.equal(decodedD.vkCode, 0x44); // VK_D
  sm.processKeyAction(decodedD);

  assert.equal(sm.getSnapshot().activeKeyCount, 2);
  assert.ok(sm.getSnapshot().activeKeys.includes(0x5B));
  assert.ok(sm.getSnapshot().activeKeys.includes(0x44));

  // 3. 模擬 Android 平板滑鼠滾輪與相對位移 (dx: 15, dy: -30, 滾輪: 2)
  const androidButtons = 1 | 4; // 左鍵 + 中鍵
  const winButtons = androidButtonsToWindows(androidButtons);
  const mousePacket = encodeMouseMove({
    dx: 15,
    dy: -30,
    wheel: 2,
    buttons: winButtons,
    seq: 10
  });

  const decodedMouse = decodeMouseMove(mousePacket);
  assert.equal(decodedMouse.dx, 15);
  assert.equal(decodedMouse.dy, -30);
  assert.equal(decodedMouse.wheel, 2);
  assert.equal(decodedMouse.buttons, BUTTON_MASKS.LEFT | BUTTON_MASKS.MIDDLE);

  const mouseRes = sm.processMouseMove(decodedMouse);
  assert.equal(mouseRes.buttons, BUTTON_MASKS.LEFT | BUTTON_MASKS.MIDDLE);
});
