/**
 * DuoTab-KVM 靜態畫面動態降載與瞬間喚醒狀態機 (Idle Throttler)
 * 遵循深模組規範：100% Headless 純邏輯，零 DOM 依賴，保證可在 Node.js 中完全自測
 */

export const THROTTLE_STATE = {
  ACTIVE: 'ACTIVE',       // 活躍態：60 FPS 全速推流 (有滑鼠、鍵盤或畫面持續變更)
  IDLE: 'IDLE',           // 怠速態：15 FPS 降頻節能 (無操作超過 idleTimeoutMs，例如 500ms)
  FROZEN: 'FROZEN'        // 凍結態：0 FPS 深度睡眠 (無操作超過 freezeTimeoutMs，例如 3000ms，僅推心跳)
};

export class IdleThrottler {
  constructor(options = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 500;
    this.freezeTimeoutMs = options.freezeTimeoutMs ?? 3000;
    this.activeFps = options.activeFps ?? 60;
    this.idleFps = options.idleFps ?? 15;

    this.state = THROTTLE_STATE.ACTIVE;
    this.lastActivityTime = Date.now();
    this.lastEmittedFrameTime = 0;
    this.onStateChange = options.onStateChange || null;
    this.onWakeup = options.onWakeup || null;
  }

  /**
   * 外部注入使用者操作事件 (滑鼠移動/點擊/鍵盤按鍵/畫面髒區變動)
   */
  recordActivity(now = Date.now()) {
    const prevState = this.state;
    this.lastActivityTime = now;

    if (prevState !== THROTTLE_STATE.ACTIVE) {
      this.state = THROTTLE_STATE.ACTIVE;
      if (this.onStateChange) {
        this.onStateChange(this.state, prevState);
      }
      if (this.onWakeup) {
        this.onWakeup({ fromState: prevState, timestamp: now });
      }
    }
  }

  /**
   * 週期性時鐘檢查，判定是否應轉移至 IDLE 或 FROZEN
   */
  tick(now = Date.now()) {
    const elapsed = now - this.lastActivityTime;
    const prevState = this.state;

    if (elapsed >= this.freezeTimeoutMs) {
      this.state = THROTTLE_STATE.FROZEN;
    } else if (elapsed >= this.idleTimeoutMs) {
      this.state = THROTTLE_STATE.IDLE;
    } else {
      this.state = THROTTLE_STATE.ACTIVE;
    }

    if (this.state !== prevState && this.onStateChange) {
      this.onStateChange(this.state, prevState);
    }

    return this.state;
  }

  /**
   * 判斷當前幀是否應丟棄 (節能過濾核心邏輯)
   * @param {boolean} isKeyframe 若為關鍵幀 (IDR/SPS/PPS)，永遠保留不丟棄
   * @param {number} now 當前時間戳
   * @returns {boolean} true 代表應丟棄以節能，false 代表應正常送出
   */
  shouldDropFrame(isKeyframe = false, now = Date.now()) {
    // 關鍵幀絕對不丟，確保解碼器狀態完整
    if (isKeyframe) {
      this.lastEmittedFrameTime = now;
      return false;
    }

    this.tick(now);

    // 凍結態：非關鍵幀 100% 丟棄，達到 0 FPS 深度省電
    if (this.state === THROTTLE_STATE.FROZEN) {
      return true;
    }

    // 怠速態：依 idleFps 間隔抽取影格 (例如 15 FPS = 66.6ms 一幀)
    if (this.state === THROTTLE_STATE.IDLE) {
      const minIntervalMs = 1000 / this.idleFps;
      if (now - this.lastEmittedFrameTime < minIntervalMs) {
        return true; // 丟棄多餘的 P 幀
      }
    }

    // 活躍態：全速送出
    this.lastEmittedFrameTime = now;
    return false;
  }

  /**
   * 獲取當前建議的目標 FPS
   */
  getTargetFps() {
    switch (this.state) {
      case THROTTLE_STATE.FROZEN:
        return 0;
      case THROTTLE_STATE.IDLE:
        return this.idleFps;
      case THROTTLE_STATE.ACTIVE:
      default:
        return this.activeFps;
    }
  }
}
