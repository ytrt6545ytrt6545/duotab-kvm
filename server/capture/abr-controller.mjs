import { ABR_CONFIG } from './capture-constants.mjs';

/**
 * 動態頻寬自適應控制器 (ABR Controller)
 * 根據 Wi-Fi 網路 RTT、丟包率與幀延遲動態計算目標碼率與幀率，兼顧畫質與極低延遲
 */
export class AbrController {
  constructor(options = {}) {
    this.minBitrate = options.minBitrate || ABR_CONFIG.MIN_BITRATE_KBPS;
    this.defaultBitrate = options.defaultBitrate || ABR_CONFIG.DEFAULT_BITRATE_KBPS;
    this.maxBitrate = options.maxBitrate || ABR_CONFIG.MAX_BITRATE_KBPS;

    this.currentBitrate = this.defaultBitrate;
    this.currentFps = 60;
    this.isCongested = false;

    this._goodNetworkCounter = 0;
    this._consecutiveLossCounter = 0;
    this.history = [];
  }

  /**
   * 饋入網路指標並反饋最新編碼參數
   * @param {{ rttMs: number, packetLoss: number, frameDrops?: number }} metrics
   */
  feedMetrics({ rttMs, packetLoss = 0, frameDrops = 0 }) {
    const prevBitrate = this.currentBitrate;
    const prevFps = this.currentFps;

    // 1. 擁塞判定：丟包率過高或延遲激增
    if (packetLoss >= ABR_CONFIG.LOSS_THRESHOLD_HIGH || rttMs >= ABR_CONFIG.RTT_THRESHOLD_HIGH_MS) {
      this.isCongested = true;
      this._goodNetworkCounter = 0;
      this._consecutiveLossCounter++;

      // 降碼率策略：若嚴重丟包則砍 30%，一般超時砍 15%
      const reductionRatio = packetLoss >= 0.05 ? 0.7 : 0.85;
      this.currentBitrate = Math.max(this.minBitrate, Math.round(this.currentBitrate * reductionRatio));

      // 若延遲極高（>60ms）或連續丟包，幀率降至 30fps 保障流暢不卡死
      if (rttMs > 60 || this._consecutiveLossCounter >= 3) {
        this.currentFps = 30;
      }
    } else if (rttMs <= ABR_CONFIG.RTT_THRESHOLD_LOW_MS && packetLoss === 0) {
      // 2. 良好網路恢復策略（具備防抖 Hysteresis 窗口，連續 3 次良好才上調）
      this._goodNetworkCounter++;
      this._consecutiveLossCounter = 0;

      if (this._goodNetworkCounter >= 3) {
        this.isCongested = false;
        this.currentBitrate = Math.min(this.maxBitrate, Math.round(this.currentBitrate * 1.15));
        this.currentFps = 60; // 恢復 60fps
        this._goodNetworkCounter = 0; // 重置計數器，強制要求下一個完整窗口才能再次回升
      }
    } else {
      // 處於正常穩定區間 (15ms ~ 35ms)，保持當前狀態
      this._consecutiveLossCounter = 0;
    }

    const changed = prevBitrate !== this.currentBitrate || prevFps !== this.currentFps;

    const snapshot = {
      timestamp: Date.now(),
      metrics: { rttMs, packetLoss, frameDrops },
      bitrateKbps: this.currentBitrate,
      fps: this.currentFps,
      isCongested: this.isCongested,
      changed
    };

    this.history.push(snapshot);
    return snapshot;
  }

  reset() {
    this.currentBitrate = this.defaultBitrate;
    this.currentFps = 60;
    this.isCongested = false;
    this._goodNetworkCounter = 0;
    this._consecutiveLossCounter = 0;
  }
}
