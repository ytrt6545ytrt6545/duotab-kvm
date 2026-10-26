import { TopologyProbe } from './topology-probe.mjs';
import { EncoderAdapter } from './encoder-adapter.mjs';
import { AbrController } from './abr-controller.mjs';

/**
 * DuoTab-KVM PC 端畫面捕獲與自適應串流總管理器
 */
export class ScreenCaptureManager {
  constructor(options = {}) {
    this.topologyProbe = options.topologyProbe || new TopologyProbe(options);
    this.encoderAdapter = options.encoderAdapter || new EncoderAdapter(options);

    // 兩路獨立串流之 ABR 控制器 (Console 主螢幕 與 Display 延伸螢幕)
    this.consoleAbr = new AbrController(options);
    this.displayAbr = new AbrController(options);

    this.activeEncoder = null;
    this.topology = null;
    this.isCapturing = false;
  }

  /**
   * 初始化雙螢幕畫面捕獲與自適應編碼鏈
   */
  async initialize() {
    // 1. 探測實體螢幕拓撲
    this.topology = this.topologyProbe.getDualScreenTopology();

    // 2. 探測並選取最佳 GPU 硬體編碼器
    this.activeEncoder = await this.encoderAdapter.resolveEncoder();

    this.isCapturing = true;

    return {
      topology: this.topology,
      encoder: this.activeEncoder,
      isDualScreen: this.topology.hasDualScreens
    };
  }

  /**
   * 饋入客戶端回傳之網路品質指標，進行 ABR 動態調控
   * @param {'console'|'display'} streamType
   * @param {{ rttMs: number, packetLoss: number }} metrics
   */
  handleNetworkFeedback(streamType, metrics) {
    const abr = streamType === 'console' ? this.consoleAbr : this.displayAbr;
    return abr.feedMetrics(metrics);
  }

  /**
   * 當 GPU 發生故障 (TDR / 顯存耗盡) 時自動平滑降級備援
   */
  async handleGpuFailure() {
    this.activeEncoder = await this.encoderAdapter.fallback();
    return this.activeEncoder;
  }

  /**
   * 停止並釋放資源
   */
  async stop() {
    this.isCapturing = false;
  }
}
