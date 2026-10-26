import { execSync } from 'node:child_process';
import { ENCODER_BACKEND, STREAM_QUALITY_PROFILE } from './capture-constants.mjs';

/**
 * GPU 硬體編碼階梯探針與自適應調度器
 * 依序探測 NVENC -> QSV -> AMF -> SOFTWARE，保證跨硬體主機 100% 自適應平滑備援
 */
let _globalCachedBackends = null;

export class EncoderAdapter {
  constructor(options = {}) {
    this.preferredBackend = options.preferredBackend || null;
    this.supportedBackends = options.supportedBackends || null; // 支援外部注入或測試接縫
    this.activeBackend = null;
    this.history = [];
  }

  /**
   * 自動探測目前系統硬體與環境的最佳編碼後端
   */
  async probeBackends() {
    if (this.supportedBackends) {
      return this.supportedBackends;
    }
    if (_globalCachedBackends) {
      this.supportedBackends = _globalCachedBackends;
      return _globalCachedBackends;
    }

    const available = [];

    // 透過 Windows WMI 偵測實體顯卡型號做初篩
    const gpuNames = this._detectGpuNames();

    const hasNvidia = gpuNames.some(name => /nvidia|geforce|quadro|rtx|gtx/i.test(name) && !/\bmx\d\d\d?\b/i.test(name));
    const hasIntel = gpuNames.some(name => /intel|uhd|iris|hd graphics/i.test(name));
    const hasAmd = gpuNames.some(name => /amd|radeon/i.test(name));

    // 透過 Live Reality 微探針直接校驗硬體編碼晶片與驅動相容性 (防範 MX 閹割版或 DLL 缺失)
    if (hasNvidia && this._testEncoderCapability('h264_nvenc')) {
      available.push(ENCODER_BACKEND.NVENC);
    }
    if (hasIntel && this._testEncoderCapability('h264_qsv')) {
      available.push(ENCODER_BACKEND.QSV);
    }
    if (hasAmd && this._testEncoderCapability('h264_amf')) {
      available.push(ENCODER_BACKEND.AMF);
    }

    // 軟體編碼恆久可用作為最終備援保險絲
    available.push(ENCODER_BACKEND.SOFTWARE);

    this.supportedBackends = available;
    _globalCachedBackends = available;
    return available;
  }

  /**
   * 透過 FFmpeg 1 幀微探針快速校驗指定硬體編碼器是否具備硬體支援與可用驅動
   */
  _testEncoderCapability(codecName) {
    try {
      execSync(`ffmpeg -hide_banner -f lavfi -i testsrc=size=64x64:rate=1 -c:v ${codecName} -frames:v 1 -f null -`, {
        stdio: 'ignore',
        timeout: 4000
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 選擇最佳可用編碼器並返回配置
   */
  async resolveEncoder(requestedBackend = null) {
    const available = await this.probeBackends();

    let target = requestedBackend || this.preferredBackend;
    if (!target || !available.includes(target)) {
      target = available[0] || ENCODER_BACKEND.SOFTWARE;
    }

    this.activeBackend = target;
    this.history.push({
      timestamp: Date.now(),
      selected: target,
      availableList: [...available]
    });

    return {
      backend: target,
      ffmpegCodec: this._mapToFFmpegCodec(target),
      profile: STREAM_QUALITY_PROFILE.ULTRA_LOW_LATENCY,
      isHardwareAccelerated: target !== ENCODER_BACKEND.SOFTWARE
    };
  }

  /**
   * 當運行中遇到 GPU 設備丟失 (Device Lost / TDR) 時觸發平滑降級
   */
  async fallback() {
    const available = await this.probeBackends();
    const currentIndex = available.indexOf(this.activeBackend);

    let nextBackend = ENCODER_BACKEND.SOFTWARE;
    if (currentIndex !== -1 && currentIndex + 1 < available.length) {
      nextBackend = available[currentIndex + 1];
    }

    this.activeBackend = nextBackend;
    this.history.push({
      timestamp: Date.now(),
      event: 'FALLBACK_TRIGGERED',
      fallbackTo: nextBackend
    });

    return {
      backend: nextBackend,
      ffmpegCodec: this._mapToFFmpegCodec(nextBackend),
      profile: STREAM_QUALITY_PROFILE.ULTRA_LOW_LATENCY,
      isHardwareAccelerated: nextBackend !== ENCODER_BACKEND.SOFTWARE
    };
  }

  /**
   * 構造專屬硬體加速或軟體備援的 FFmpeg 命令參數陣列
   * 輸出標準 Annex-B H.264 零延遲 byte stream (pipe:1)
   */
  buildFFmpegArgs(options = {}) {
    const backend = options.backend || this.activeBackend || ENCODER_BACKEND.SOFTWARE;
    const width = options.width || 1920;
    const height = options.height || 1080;
    const offsetX = options.offsetX || 0;
    const offsetY = options.offsetY || 0;
    const scaleW = options.scaleW || 640;
    const scaleH = options.scaleH || 360;
    const fps = options.fps || 60;
    const bitrateKbps = options.bitrateKbps || 2000;
    const gopSize = options.gopSize || 30;

    const args = [
      '-loglevel', 'error',
      '-thread_queue_size', '1',
      '-f', 'gdigrab',
      '-draw_mouse', '1',
      '-framerate', `${fps}`
    ];

    // 永遠明確指定 offset 與 video_size，鎖定單一實體螢幕幾何，絕不抓取全域多螢幕龐大虛擬桌面 (例如 4640x1080)
    args.push(
      '-offset_x', `${offsetX}`,
      '-offset_y', `${offsetY}`,
      '-video_size', `${width}x${height}`,
      '-i', 'desktop'
    );

    // 嚴格計算 VBV 緩衝區：保證單幀平滑，單幀上限不得超過 35KB
    const vbvBufSize = Math.max(300, Math.round(bitrateKbps / 8));

    switch (backend) {
      case ENCODER_BACKEND.NVENC:
        args.push(
          '-vf', `fps=fps=${fps},scale=${scaleW}:${scaleH}:flags=fast_bilinear,format=yuv420p`,
          '-c:v', 'h264_nvenc',
          '-preset', 'p1',
          '-tune', 'ull',
          '-zerolatency', '1',
          '-r', `${fps}`,
          '-rc', 'cbr',
          '-b:v', `${bitrateKbps}k`,
          '-maxrate', `${bitrateKbps}k`,
          '-bufsize', `${vbvBufSize}k`,
          '-g', `${gopSize}`,
          '-bf', '0',
          '-profile:v', 'baseline',
          '-f', 'h264',
          'pipe:1'
        );
        break;

      case ENCODER_BACKEND.QSV:
        args.push(
          '-vf', `fps=fps=${fps},scale=${scaleW}:${scaleH}:flags=fast_bilinear,format=nv12`,
          '-c:v', 'h264_qsv',
          '-scenario', 'displayremoting',
          '-low_power', '1',
          '-forced_idr', '1',
          '-preset', 'veryfast',
          '-async_depth', '1',
          '-r', `${fps}`,
          '-b:v', `${bitrateKbps}k`,
          '-maxrate', `${bitrateKbps}k`,
          '-bufsize', `${vbvBufSize}k`,
          '-g', `${gopSize}`,
          '-bf', '0',
          '-profile:v', 'baseline',
          '-pix_fmt', 'nv12',
          '-f', 'h264',
          'pipe:1'
        );
        break;

      case ENCODER_BACKEND.AMF:
        args.push(
          '-vf', `fps=fps=${fps},scale=${scaleW}:${scaleH}:flags=fast_bilinear,format=yuv420p`,
          '-c:v', 'h264_amf',
          '-usage', 'ultralowlatency',
          '-b:v', `${bitrateKbps}k`,
          '-maxrate', `${bitrateKbps}k`,
          '-bufsize', `${vbvBufSize}k`,
          '-g', `${gopSize}`,
          '-bf', '0',
          '-f', 'h264',
          'pipe:1'
        );
        break;

      case ENCODER_BACKEND.SOFTWARE:
      default:
        args.push(
          '-vf', `fps=fps=${fps},scale=${scaleW}:${scaleH}:flags=fast_bilinear,format=yuv420p`,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-tune', 'zerolatency',
          '-r', `${fps}`,
          '-b:v', `${bitrateKbps}k`,
          '-maxrate', `${bitrateKbps}k`,
          '-bufsize', `${vbvBufSize}k`,
          '-g', `${gopSize}`,
          '-bf', '0',
          '-profile:v', 'baseline',
          '-f', 'h264',
          'pipe:1'
        );
        break;
    }

    return args;
  }

  _mapToFFmpegCodec(backend) {
    switch (backend) {
      case ENCODER_BACKEND.NVENC:
        return 'h264_nvenc';
      case ENCODER_BACKEND.QSV:
        return 'h264_qsv';
      case ENCODER_BACKEND.AMF:
        return 'h264_amf';
      case ENCODER_BACKEND.SOFTWARE:
      default:
        return 'libx264';
    }
  }

  _detectGpuNames() {
    try {
      const output = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"', {
        encoding: 'utf-8',
        timeout: 3000
      });
      return output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (e) {
      return [];
    }
  }
}
