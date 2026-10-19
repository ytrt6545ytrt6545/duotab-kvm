import {
  KEY_ACTION_TYPE,
  BUTTON_MASKS,
  PROTOCOL_CONFIG
} from './constants.mjs';

/**
 * 無頭輸入狀態機 (Headless Input State Machine)
 * 負責維護按鍵與滑鼠按下狀態，提供租約看門狗與黏鍵防護
 * 嚴格 0-DOM 依賴，可在 Node.js 與各端點完全獨立運行
 */
export class InputStateMachine {
  constructor(options = {}) {
    this.leaseMs = options.leaseMs || PROTOCOL_CONFIG.DEFAULT_HEARTBEAT_LEASE_MS;
    this.activeKeyCodes = new Set();
    this.activeMouseButtons = BUTTON_MASKS.NONE;
    this.activeModifiers = 0;
    this.lastInputTime = Date.now();
    this.isEmergencyReleased = false;

    // 回調監聽
    this.onEmergencyRelease = options.onEmergencyRelease || null;
  }

  /**
   * 處理鍵盤動作
   * @param {Object} keyEvent { action, vkCode, modifiers, seq, timestamp }
   * @returns {Object|null} 處理結果，若為無效/冗餘事件則返回 null
   */
  processKeyAction({ action, vkCode, modifiers = 0, timestamp = Date.now() }) {
    this.touch(timestamp);
    this.activeModifiers = modifiers;

    if (action === KEY_ACTION_TYPE.DOWN) {
      this.activeKeyCodes.add(vkCode);
      return { action: KEY_ACTION_TYPE.DOWN, vkCode, modifiers };
    } else if (action === KEY_ACTION_TYPE.UP) {
      this.activeKeyCodes.delete(vkCode);
      return { action: KEY_ACTION_TYPE.UP, vkCode, modifiers };
    }
    return null;
  }

  /**
   * 處理滑鼠動作
   * @param {Object} mouseEvent { dx, dy, wheel, buttons, timestamp }
   * @returns {Object} 包含差異與按鈕變更
   */
  processMouseMove({ dx, dy, wheel, buttons, timestamp = Date.now() }) {
    this.touch(timestamp);
    const prevButtons = this.activeMouseButtons;
    this.activeMouseButtons = buttons;

    const pressedButtons = (~prevButtons) & buttons;  // 新按下的鍵
    const releasedButtons = prevButtons & (~buttons); // 剛釋放的鍵

    return {
      dx,
      dy,
      wheel,
      buttons,
      pressedButtons,
      releasedButtons
    };
  }

  /**
   * 更新活動時間
   */
  touch(timestamp = Date.now()) {
    this.lastInputTime = timestamp;
    this.isEmergencyReleased = false;
  }

  /**
   * 檢查租約看門狗 (Watchdog)
   * 若超時未收到任何信令，強制執行全鍵釋放清單，消滅黏鍵與系統鎖死
   * @param {number} now 當前時間戳
   * @returns {Object|null} 若觸發急停釋放，返回釋放清單；否則返回 null
   */
  checkLease(now = Date.now()) {
    if (this.isEmergencyReleased) {
      return null; // 已處於急停狀態，不重複觸發
    }

    const elapsed = now - this.lastInputTime;
    if (elapsed > this.leaseMs) {
      // 租約超時，觸發急停釋放
      const releaseList = this.generateEmergencyRelease();
      this.isEmergencyReleased = true;

      if (typeof this.onEmergencyRelease === 'function') {
        this.onEmergencyRelease(releaseList);
      }
      return releaseList;
    }
    return null;
  }

  /**
   * 生成所有當前按住的鍵盤與滑鼠釋放清單
   */
  generateEmergencyRelease() {
    const keysToRelease = Array.from(this.activeKeyCodes);
    const mouseToRelease = this.activeMouseButtons;

    // 清空內部狀態
    this.activeKeyCodes.clear();
    this.activeMouseButtons = BUTTON_MASKS.NONE;
    this.activeModifiers = 0;

    return {
      reason: 'LEASE_EXPIRED',
      keysToRelease,
      mouseToRelease,
      timestamp: Date.now()
    };
  }

  /**
   * 取得當前狀態快照
   */
  getSnapshot() {
    return {
      activeKeyCount: this.activeKeyCodes.size,
      activeKeys: Array.from(this.activeKeyCodes),
      activeMouseButtons: this.activeMouseButtons,
      activeModifiers: this.activeModifiers,
      lastInputTime: this.lastInputTime,
      isEmergencyReleased: this.isEmergencyReleased
    };
  }
}
