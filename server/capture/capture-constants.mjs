/**
 * DuoTab-KVM 螢幕拓撲與畫面捕獲常數與幾何定義
 */

export const ENCODER_BACKEND = {
  NVENC: 'nvenc',         // NVIDIA 獨立顯卡 (NVENC H.264/HEVC)
  QSV: 'qsv',             // Intel QuickSync 內顯 (Intel UHD / Iris Xe)
  AMF: 'amf',             // AMD Radeon 硬體編碼
  SOFTWARE: 'software'    // CPU 軟體備援 (OpenH264 / x264)
};

export const CAPTURE_SOURCE = {
  DDAGRAB: 'ddagrab',     // Windows 原生 D3D11 Desktop Duplication (GPU 零拷貝顯存原生捕獲，近乎 0% CPU)
  GDIGRAB: 'gdigrab'      // Windows GDI 傳統截圖 (全相容備援)
};

export const STREAM_QUALITY_PROFILE = {
  ULTRA_LOW_LATENCY: {
    gopSize: 30,          // 關鍵幀間隔 (半秒 1 個 IDR)
    rcMode: 'cbr',        // 固定碼率 (Constant Bitrate)
    tune: 'zerolatency',  // 零延遲模式
    preset: 'p1'          // 最高速度優先
  }
};

export const ABR_CONFIG = {
  MIN_BITRATE_KBPS: 2000,     // 最低保障碼率 2 Mbps
  DEFAULT_BITRATE_KBPS: 12000,// 預設高畫質碼率 12 Mbps
  MAX_BITRATE_KBPS: 25000,    // 最高頻寬上限 25 Mbps
  RTT_THRESHOLD_HIGH_MS: 35,  // 超過 35ms 判定網路擁塞開始降碼率
  RTT_THRESHOLD_LOW_MS: 15,   // 低於 15ms 且無丟包平滑回升
  LOSS_THRESHOLD_HIGH: 0.03   // 丟包率 > 3% 立即啟動快速降碼率
};
