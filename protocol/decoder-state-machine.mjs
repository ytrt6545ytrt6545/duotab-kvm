import { NALU_TYPE, DECODER_STATE, STREAM_CONTROL_FLAGS } from './constants.mjs';

/**
 * DuoTab-KVM 無頭 H.264 解碼器狀態機
 * 專注純領域 NALU 分幀、SPS/PPS 參數集捕獲、IDR 關鍵幀門禁與異常自癒重傳決策
 * 嚴格遵循介面與邏輯物理解耦鐵律 (0-DOM, 0-Android API, 100% 可在 Node.js 中測試)
 */
export class DecoderStateMachine {
  constructor(options = {}) {
    this.displayId = options.displayId ?? 0;
    this.state = DECODER_STATE.UNINITIALIZED;

    this.spsBuffer = null;
    this.ppsBuffer = null;
    this.lastDecodedSeq = null;

    this.decodedFrameCount = 0;
    this.droppedFrameCount = 0;
    this.idrRequestCount = 0;
    this.lastIdrRequestTime = 0;
    this.idrThrottleMs = options.idrThrottleMs ?? 250; // 最小 250ms 冷卻窗口防風暴

    this.history = [];
  }

  /**
   * 解析二進制 Buffer 中的 NALU 單元
   * 支援標準 Annex-B (00 00 00 01 或 00 00 01 起始碼)
   * @param {Buffer} buffer
   * @returns {Array<{ type: number, raw: Buffer, offset: number, size: number }>}
   */
  parseNalus(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
      return [];
    }

    const nalus = [];
    const len = buffer.length;
    let i = 0;

    const startCodeIndices = [];
    while (i < len - 2) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00) {
        if (buffer[i + 2] === 0x01) {
          startCodeIndices.push({ index: i, headerLen: 3 });
          i += 3;
          continue;
        } else if (i < len - 3 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x01) {
          startCodeIndices.push({ index: i, headerLen: 4 });
          i += 4;
          continue;
        }
      }
      i++;
    }

    for (let k = 0; k < startCodeIndices.length; k++) {
      const current = startCodeIndices[k];
      const nextIndex = k + 1 < startCodeIndices.length ? startCodeIndices[k + 1].index : len;
      const naluStart = current.index + current.headerLen;

      if (naluStart < nextIndex) {
        const headerByte = buffer[naluStart];
        const naluType = headerByte & 0x1F;
        const naluBuf = buffer.subarray(naluStart, nextIndex);

        nalus.push({
          type: naluType,
          raw: naluBuf,
          offset: naluStart,
          size: naluBuf.length
        });
      }
    }

    return nalus;
  }

  /**
   * 饋入一個 H.264 影像資料包
   * @param {Buffer} buffer 包含一個或多個 NALU 的二進制封包
   * @param {number|null} seq 幀序號 (用於檢測幀丟失)
   * @returns {{
   *   renderable: boolean,
   *   state: string,
   *   requestKeyframe: boolean,
   *   naluTypes: number[]
   * }}
   */
  _shouldRequestKeyframe(now = Date.now()) {
    if (now - this.lastIdrRequestTime >= this.idrThrottleMs) {
      this.lastIdrRequestTime = now;
      this.idrRequestCount++;
      return true;
    }
    return false;
  }

  feedPacket(buffer, seq = null, now = Date.now()) {
    const nalus = this.parseNalus(buffer);
    const naluTypes = nalus.map(n => n.type);
    let requestKeyframe = false;
    let renderable = false;

    // 1. 幀序號連續性檢查 (序列跳號判定為丟包)
    if (seq !== null && this.lastDecodedSeq !== null) {
      const expectedSeq = (this.lastDecodedSeq + 1) & 0xFF;
      if (seq !== expectedSeq) {
        this.droppedFrameCount++;
        this.state = DECODER_STATE.ERROR_RECOVERY;
        requestKeyframe = this._shouldRequestKeyframe(now);
      }
    }

    // 2. 提取 SPS 與 PPS 參數集
    for (const nalu of nalus) {
      if (nalu.type === NALU_TYPE.SPS) {
        this.spsBuffer = Buffer.from(nalu.raw);
      } else if (nalu.type === NALU_TYPE.PPS) {
        this.ppsBuffer = Buffer.from(nalu.raw);
      }
    }

    // 3. 狀態機轉移
    const hasConfig = this.spsBuffer !== null && this.ppsBuffer !== null;
    const hasIdr = naluTypes.includes(NALU_TYPE.IDR);

    switch (this.state) {
      case DECODER_STATE.UNINITIALIZED:
        if (hasConfig) {
          if (hasIdr) {
            this.state = DECODER_STATE.ACTIVE_STREAMING;
            renderable = true;
          } else {
            this.state = DECODER_STATE.WAITING_FOR_IDR;
            requestKeyframe = this._shouldRequestKeyframe(now);
          }
        }
        break;

      case DECODER_STATE.WAITING_FOR_IDR:
        if (hasIdr) {
          this.state = DECODER_STATE.ACTIVE_STREAMING;
          renderable = true;
        } else {
          // 在等待 IDR 期間收到的非 IDR 幀不能渲染（避免花屏）
          renderable = false;
        }
        break;

      case DECODER_STATE.ACTIVE_STREAMING:
        // 正常串流狀態下，IDR 或 Non-IDR 均可渲染
        if (naluTypes.includes(NALU_TYPE.IDR) || naluTypes.includes(NALU_TYPE.NON_IDR)) {
          renderable = true;
        }
        break;

      case DECODER_STATE.ERROR_RECOVERY:
        if (hasIdr) {
          // 重傳之關鍵幀抵達，解除異常恢復正常串流
          this.state = DECODER_STATE.ACTIVE_STREAMING;
          renderable = true;
        } else {
          // 異常恢復期間拋棄所有 P 幀，防止參考幀丟失導致綠屏/馬賽克
          renderable = false;
          // 若距上次請求已超過冷卻窗口，再次發起重傳請求
          if (this._shouldRequestKeyframe(now)) {
            requestKeyframe = true;
          }
        }
        break;
    }

    if (renderable) {
      this.decodedFrameCount++;
    }

    if (seq !== null) {
      this.lastDecodedSeq = seq;
    }

    const action = {
      displayId: this.displayId,
      state: this.state,
      renderable,
      requestKeyframe,
      naluTypes
    };

    this.history.push(action);
    return action;
  }

  /**
   * 解碼器拋出底層解碼錯誤時的自癒接口
   */
  notifyDecodeError() {
    this.state = DECODER_STATE.ERROR_RECOVERY;
    this.idrRequestCount++;
    return {
      state: this.state,
      requestKeyframe: true
    };
  }

  /**
   * 重置狀態機 (例如客戶端重新連線時)
   */
  reset() {
    this.state = DECODER_STATE.UNINITIALIZED;
    this.spsBuffer = null;
    this.ppsBuffer = null;
    this.lastDecodedSeq = null;
    this.decodedFrameCount = 0;
    this.droppedFrameCount = 0;
    this.idrRequestCount = 0;
    this.lastIdrRequestTime = 0;
  }
}
