import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PACKET_TYPE, PACKET_SIZE, CLIENT_ROLE, STREAM_CONTROL_FLAGS } from '../../protocol/constants.mjs';
import { decodeHeartbeat, decodeStreamControl, decodeMouseMove, decodeKeyAction } from '../../protocol/packet-codec.mjs';
import { InputStateMachine } from '../../protocol/input-state-machine.mjs';
import { InputInjector } from '../input-injector.mjs';
import { ScreenCaptureManager } from '../capture/screen-capture-manager.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STREAM_TIERS = {
  1: { width: 854, bitrateKbps: 1800, fps: 60, q: '26', name: '低畫質 (480p, 1.8Mbps, 60fps 省電保底)' },
  2: { width: 1280, bitrateKbps: 3500, fps: 60, q: '22', name: '中畫質 (720p, 3.5Mbps, 60fps 最佳平衡)' },
  3: { width: 1920, bitrateKbps: 6500, fps: 60, q: '18', name: '高畫質 (1080p, 6.5Mbps, 60fps 原畫細緻)' }
};

/**
 * DuoTab-KVM 雙通道全雙工網路協調器
 * 控制通道 (TCP) + 低延遲輸入通道 (UDP) + 雙螢幕串流對接
 */
export class NetworkCoordinator {
  constructor(options = {}) {
    this.tcpPort = options.tcpPort || 5858;
    this.videoPort = options.videoPort || (this.tcpPort === 5858 ? 5859 : this.tcpPort + 1);
    this.udpPort = options.udpPort || 5858;

    this.inputInjector = options.inputInjector || new InputInjector(options);
    this.inputStateMachine = options.inputStateMachine || new InputStateMachine(options);
    this.captureManager = options.captureManager || new ScreenCaptureManager(options);

    this.tcpServer = null;
    this.videoServer = null;
    this.videoSocket = null; // 當前活躍之專屬獨立視訊通道
    this.udpSocket = null;

    // 活躍客戶端映射表
    this.clients = {
      console: null,  // { socket, remoteAddress, remotePort, lastSeen }
      display: null   // { socket, remoteAddress, remotePort, lastSeen }
    };

    this._activeSockets = new Set();
    this.allowUnauthenticatedUdp = options.allowUnauthenticatedUdp ?? false;
    this.isListening = false;
    this.history = [];
    this._captureProcess = null;
    this._currentStreamTier = 2; // 預設使用 Tier 2 (中畫質 640p)
    this._manualTier = null;     // 客戶端手動鎖定之畫質 Tier (1:低, 2:中, 3:高, null:自動ABR)
    this._lowFpsCounter = 0;
    this._highFpsCounter = 0;
    this._cachedSps = new Map();        // streamRole -> SPS NALU (Type 7)
    this._cachedPps = new Map();        // streamRole -> PPS NALU (Type 8)
    this._cachedConfigNalus = new Map(); // 相容舊版: streamRole -> NALU (SPS/PPS)
    this._cachedKeyframes = new Map();   // streamRole -> NALU (IDR Type 5)
    this._currentSeq = 0;
  }

  /**
   * 啟動 TCP 控制服務、TCP 獨立視訊服務與 UDP 低延遲輸入接收 (三網解耦架構)
   */
  async start() {
    // 1. 初始化底層輸入注入器與畫面捕獲拓撲
    if (!this.inputInjector.isOpen) {
      await this.inputInjector.start();
    }
    await this.captureManager.initialize();

    // 2. 啟動 TCP 控制通道 (Port 5858，專任心跳保活、鍵鼠輸入、設定切換)
    await new Promise((resolve, reject) => {
      this.tcpServer = net.createServer((socket) => {
        socket.on('error', (err) => {
          console.warn(`[DuoTab-NET] 🔴 平板 TCP 控制連線異常 (${err.code || err.message})`);
        });
        this._activeSockets.add(socket);
        console.log(`[DuoTab-NET] 🟢 平板已建立 TCP 控制連線！來自: ${socket.remoteAddress}:${socket.remotePort}`);
        socket.once('close', () => {
          this._activeSockets.delete(socket);
          console.log(`[DuoTab-NET] 🔴 平板 TCP 連線已關閉 (${socket.remoteAddress})`);
        });
        this._handleTcpConnection(socket);
      });

      this.tcpServer.on('error', reject);
      this.tcpServer.listen(this.tcpPort, () => {
        resolve();
      });
    });

    // 3. 啟動 TCP 獨立視訊串流通道 (Port 5859，專任視訊資料流，物理打破隊頭阻塞)
    await new Promise((resolve, reject) => {
      this.videoServer = net.createServer((socket) => {
        try { socket.setNoDelay(true); } catch (e) {}
        socket.on('error', (err) => {
          console.warn(`[DuoTab-NET] 📺 視訊通道連線異常中斷 (${err.code || err.message})，安全回收`);
        });
        this._activeSockets.add(socket);
        this.videoSocket = socket;
        console.log(`[DuoTab-NET] 📺 平板已建立獨立視訊通道連線！來自: ${socket.remoteAddress}:${socket.remotePort}`);

        socket.once('close', () => {
          this._activeSockets.delete(socket);
          if (this.videoSocket === socket) {
            this.videoSocket = null;
          }
          console.log(`[DuoTab-NET] 📺 平板獨立視訊通道已關閉 (${socket.remoteAddress})`);
        });

        // 獨立視訊通道建立後，若當前已有活躍角色，立即切換為從獨立通道推流
        if (this._currentStreamRole && !this._isStreamPaused) {
          const targetTier = this._manualTier || this._currentStreamTier || 2;
          this._startScreenStreaming(socket, targetTier, true, this._currentStreamRole);
        }
      });

      this.videoServer.on('error', (err) => {
        console.warn(`[DuoTab-NET] ⚠️ 視訊通道啟動警示: ${err.message}`);
        resolve(); // 容錯 fallback
      });

      this.videoServer.listen(this.videoPort, () => {
        resolve();
      });
    });

    // 4. 啟動 UDP 低延遲輸入通道
    await new Promise((resolve, reject) => {
      this.udpSocket = dgram.createSocket('udp4');
      this.udpSocket.on('error', reject);
      this.udpSocket.on('message', (msg, rinfo) => {
        this._handleUdpMessage(msg, rinfo);
      });
      this.udpSocket.bind(this.udpPort, () => {
        resolve();
      });
    });

    this.isListening = true;
    return {
      tcpPort: this.tcpPort,
      videoPort: this.videoPort,
      udpPort: this.udpPort,
      topology: this.captureManager.topology
    };
  }

  _handleTcpConnection(socket) {
    try { socket.setNoDelay(true); } catch (e) {}
    let clientRole = CLIENT_ROLE.UNKNOWN;
    let rxBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      rxBuffer = Buffer.concat([rxBuffer, chunk]);

      while (rxBuffer.length > 0) {
        const type = rxBuffer[0];
        const expectedSize = PACKET_SIZE[type];

        if (!expectedSize) {
          // 未知封包，丟棄首字節以尋求重新對齊
          rxBuffer = rxBuffer.subarray(1);
          continue;
        }

        if (rxBuffer.length < expectedSize) {
          // 封包尚未完整，等待下一個 chunk
          break;
        }

        const packet = rxBuffer.subarray(0, expectedSize);
        rxBuffer = rxBuffer.subarray(expectedSize);

        this._processControlPacket(type, packet, socket, (role) => {
          clientRole = role;
        });
      }
    });

    socket.on('close', () => {
      this._handleClientDisconnect(clientRole, socket);
    });

    socket.on('error', (err) => {
      // 容錯日誌
    });
  }

  _processControlPacket(type, packet, socket, onRoleIdentified) {
    if (type === PACKET_TYPE.HEARTBEAT) {
      const hb = decodeHeartbeat(packet);
      const roleName = hb.role === CLIENT_ROLE.CONSOLE ? 'console' : hb.role === CLIENT_ROLE.DISPLAY ? 'display' : 'unknown';

      if (roleName !== 'unknown') {
        onRoleIdentified(hb.role);
        // 註冊或刷新客戶端資訊
        this.clients[roleName] = {
          socket,
          remoteAddress: socket.remoteAddress,
          remotePort: socket.remotePort,
          lastSeen: Date.now()
        };

        if (hb.role === CLIENT_ROLE.CONSOLE) {
          this.inputStateMachine.touch();
        }

        console.log(`[DuoTab-NET] 💓 收到心跳保活: 角色=${roleName}, 租約=${hb.leaseMs}ms`);

        // 當客戶端切換角色或首次連線時啟動/切換串流 (增加 3 秒防抖冷卻，杜絕高頻重複殺死/拉起進程)
        const initialTier = this._manualTier || this._currentStreamTier || 2;
        if (this._currentStreamRole !== roleName && !this._isStreamPaused) {
          console.log(`[DuoTab-STREAM] 🔄 客戶端切換角色: ${this._currentStreamRole || '無'} ➔ ${roleName}`);
          this._currentStreamRole = roleName;
          this._startScreenStreaming(socket, initialTier, true, roleName);
        } else if (!this._captureProcess && !this._isStreamPaused) {
          const now = Date.now();
          if (!this._lastStreamAttemptTime || now - this._lastStreamAttemptTime > 3000) {
            this._lastStreamAttemptTime = now;
            this._currentStreamRole = roleName;
            this._startScreenStreaming(socket, initialTier, false, roleName);
          }
        }
      }

      // 回覆 ACK 心跳包
      socket.write(Buffer.from([0x06]));
    } else if (type === PACKET_TYPE.STREAM_CONTROL) {
      const ctrl = decodeStreamControl(packet);
      const streamName = ctrl.displayId === 0 ? 'console' : 'display';

      // 0. 弱網自癒看門狗：檢查是否請求立即發送 IDR 關鍵幀 (支援 0x01 與 0x08 別名)
      const isIdrRequested = ((ctrl.flags & STREAM_CONTROL_FLAGS.REQUEST_IDR_KEYFRAME) !== 0) || ((ctrl.flags & 0x08) !== 0);
      if (isIdrRequested) {
        console.log(`[DuoTab-RESILIENCE] 🛡️ 收到客戶端 IDR 關鍵幀自癒請求 (${streamName})，即時回送 SPS/PPS/IDR 鐵三角快照並啟動 ABR 防護`);
        const targetVidSocket = this.clients[streamName]?.socket || socket;
        if (targetVidSocket && !targetVidSocket.destroyed && targetVidSocket.writable) {
          const sps = this._cachedSps?.get(streamName);
          const pps = this._cachedPps?.get(streamName);
          const legacyConfig = this._cachedConfigNalus?.get(streamName);
          const keyframe = this._cachedKeyframes?.get(streamName);

          const sendPacket = (payload, flags) => {
            if (!payload || payload.length === 0) return;
            const hdr = Buffer.allocUnsafe(9);
            hdr[0] = 0x44;
            hdr[1] = 0x54;
            hdr[2] = 0x06;
            hdr[3] = (this._currentSeq++) & 0xFF;
            hdr[4] = flags;
            hdr.writeUInt32BE(payload.length, 5);
            targetVidSocket.write(hdr);
            targetVidSocket.write(payload);
          };

          targetVidSocket.cork();
          if (sps) {
            sendPacket(sps, 0x02); // SPS Config
          }
          if (pps) {
            sendPacket(pps, 0x02); // PPS Config
          }
          if (!sps && !pps && legacyConfig) {
            sendPacket(legacyConfig, 0x02);
          }
          if (keyframe) {
            sendPacket(keyframe, 0x01); // IDR Keyframe
          }
          targetVidSocket.uncork();
        }
      }

      // 1. 處理畫質等級切換 (targetBitrateKbps: 1:低, 2:中, 3:高, 0:自動)
      if (ctrl.targetBitrateKbps in STREAM_TIERS) {
        this._manualTier = ctrl.targetBitrateKbps;
        console.log(`[DuoTab-STREAM] 🎨 客戶端設定畫質 ➔ ${STREAM_TIERS[this._manualTier].name}`);
        if (this._currentStreamTier !== this._manualTier && !this._isStreamPaused) {
          // 若獨立視訊通道已就緒，直接使用獨立視訊通道；若剛連線尚未就緒，短暫防抖 100ms 優先等待獨立視訊通道，杜絕控制混流擠爆
          const targetVid = (this.videoSocket && !this.videoSocket.destroyed) ? this.videoSocket : null;
          if (targetVid) {
            this._startScreenStreaming(targetVid, this._manualTier, true, this._currentStreamRole || streamName);
          } else {
            setTimeout(() => {
              const delayedVid = (this.videoSocket && !this.videoSocket.destroyed) ? this.videoSocket : socket;
              this._startScreenStreaming(delayedVid, this._manualTier, true, this._currentStreamRole || streamName);
            }, 100);
          }
        }
      } else if (ctrl.targetBitrateKbps === 0) {
        if (this._manualTier !== null) {
          console.log(`[DuoTab-STREAM] 🎨 客戶端切換為自動畫質 (ABR 自適應)`);
          this._manualTier = null;
        }
      }

      if (ctrl.flags & STREAM_CONTROL_FLAGS.PAUSE_STREAM) {
        console.log(`[DuoTab-STREAM] ⏸️ 收到客戶端暫停串流指令 (${streamName})`);
        this._isStreamPaused = true;
        if (this._captureProcess) {
          try {
            this._captureProcess.stdout.removeAllListeners('data');
            this._captureProcess.kill();
            this._captureProcess = null;
          } catch (e) {}
        }
      } else if (ctrl.flags & STREAM_CONTROL_FLAGS.RESUME_STREAM) {
        console.log(`[DuoTab-STREAM] ▶️ 收到客戶端繼續串流指令 (${streamName})`);
        this._isStreamPaused = false;
        if (!this._captureProcess) {
          this._currentStreamRole = streamName;
          const targetTier = this._manualTier || this._currentStreamTier || 2;
          this._startScreenStreaming(socket, targetTier, true, streamName);
        }
      }

      // 若要求切換顯示器
      if (this._currentStreamRole !== streamName && !this._isStreamPaused) {
        console.log(`[DuoTab-STREAM] 🖥️ 切換推流螢幕: ${this._currentStreamRole || 'console'} ➔ ${streamName}`);
        this._currentStreamRole = streamName;
        const targetTier = this._manualTier || this._currentStreamTier || 2;
        this._startScreenStreaming(socket, targetTier, true, streamName);
      }

      // 饋入 ABR 反饋 (若請求 IDR 則判定為丟包 0.08，觸發快速降碼率)
      this.captureManager.handleNetworkFeedback(streamName, {
        rttMs: isIdrRequested ? 25 : 15,
        packetLoss: isIdrRequested ? 0.08 : 0
      });
    } else if (type === PACKET_TYPE.MOUSE_MOVE_REL) {
      const mouseEvt = decodeMouseMove(packet);
      this.inputStateMachine.processMouseMove(mouseEvt);
      this.inputInjector.injectMouseMove(packet);

      const now = Date.now();
      if (!this._lastMouseLog || now - this._lastMouseLog > 80 || mouseEvt.buttons !== 0 || mouseEvt.wheel !== 0) {
        console.log(`[DuoTab-INPUT] 🖱️ (TCP) 滑鼠操作: ΔX=${mouseEvt.dx}, ΔY=${mouseEvt.dy}, 按鍵=0x${mouseEvt.buttons.toString(16)}, 滾輪=${mouseEvt.wheel}`);
        this._lastMouseLog = now;
      }
    } else if (type === PACKET_TYPE.KEY_ACTION) {
      const keyEvt = decodeKeyAction(packet);
      this.inputStateMachine.processKeyAction(keyEvt);
      this.inputInjector.injectKeyAction(packet);
      console.log(`[DuoTab-INPUT] ⌨️ (TCP) 鍵盤動作: VK=0x${keyEvt.vkCode.toString(16).toUpperCase()} (${keyEvt.action === 1 ? '按下' : '釋放'}), 修飾鍵=0x${keyEvt.modifiers.toString(16)}`);
    }
  }

  _startScreenStreaming(socket, tier = 2, force = false, targetRole = 'console') {
    // 優先使用專屬獨立視訊通道 (Port 5859)，物理杜絕控制通道隊頭阻塞
    const targetSocket = (this.videoSocket && !this.videoSocket.destroyed) ? this.videoSocket : socket;
    if (!targetSocket || targetSocket.destroyed || this._isStreamPaused) return;
    if (this._captureProcess && !force && this._currentStreamTier === tier && this._currentStreamRole === targetRole && this._currentStreamSocket === targetSocket) return;
    this._currentStreamTier = tier;
    this._currentStreamRole = targetRole;
    this._currentStreamSocket = targetSocket;
    const tierConfig = STREAM_TIERS[tier] || STREAM_TIERS[2];

    try {
      // 依目標角色智慧選定實體顯示器幾何
      const isDisplay = targetRole === 'display';
      const targetScreen = (isDisplay && this.captureManager.topology?.displayScreen)
        ? this.captureManager.topology.displayScreen
        : (this.captureManager.topology?.consoleScreen || {});

      const bounds = targetScreen.bounds || targetScreen;
      const width = bounds.width || 1920;
      const height = bounds.height || 1080;
      const offsetX = bounds.x || 0;
      const offsetY = bounds.y || 0;

      // 依當前階梯動態計算等比縮放尺寸 (保證偶數)
      const targetWidth = Math.min(width, tierConfig.width);
      const targetHeight = Math.round((height * targetWidth) / width);
      const scaleW = targetWidth % 2 === 0 ? targetWidth : targetWidth - 1;
      const scaleH = targetHeight % 2 === 0 ? targetHeight : targetHeight - 1;

      const screenLabel = isDisplay ? `延伸螢幕 (${targetScreen.name || 'Display 2'})` : `主控制台 (${targetScreen.name || 'Primary'})`;
      const channelLabel = targetSocket === this.videoSocket ? '獨立視訊通道 (Port 5859)' : '控制混流通道 (Port 5858)';

      const backend = this.captureManager.activeEncoder?.backend || 'software';
      const args = this.captureManager.encoderAdapter.buildFFmpegArgs({
        backend,
        width,
        height,
        offsetX,
        offsetY,
        scaleW,
        scaleH,
        fps: tierConfig.fps || 60,
        bitrateKbps: tierConfig.bitrateKbps || 2000,
        gopSize: 30
      });

      const prevProcess = this._captureProcess;
      const currentProcess = spawn('ffmpeg', args, {
        env: { ...process.env, __COMPAT_LAYER: 'HighDpiAware' }
      });
      this._captureProcess = currentProcess;

      console.log(`[DuoTab-VIDEO] 📺 官方 FFmpeg H.264 桌面串流已啟動 (${screenLabel} | ${tierConfig.name} ➔ ${scaleW}x${scaleH} [${backend}] | 經由: ${channelLabel})，開始推送畫面...`);

      // 立即切斷前一個進程的 stdout 監聽並銷毀，杜絕新舊進程同時寫入 Socket 造成封包踩踏
      if (prevProcess) {
        try {
          prevProcess.stdout.removeAllListeners('data');
          prevProcess.kill();
        } catch (e) {}
      }

      let buffer = Buffer.alloc(0);
      let currentSeq = 0;
      let totalFrames = 0;
      let droppedFrames = 0;
      let secDroppedFrames = 0;
      let secFrames = 0;
      let secBytes = 0;
      let lastMetricTime = Date.now();

      // 根據當前畫質 Tier 動態計算安全緩衝水位 (Tier 1: 64KB, Tier 2: 128KB, Tier 3: 256KB)
      const maxBacklog = (tier === 1 ? 64 : tier === 3 ? 256 : 128) * 1024;

      function findNextStartCode(buf, startOffset) {
        const len = buf.length;
        for (let i = startOffset; i < len - 2; i++) {
          if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
            if (buf[i + 2] === 0x01) {
              return { index: i, headerLen: 3 };
            }
            if (i < len - 3 && buf[i + 2] === 0x00 && buf[i + 3] === 0x01) {
              return { index: i, headerLen: 4 };
            }
          }
        }
        return null;
      }

      currentProcess.stdout.on('data', (chunk) => {
        // 若當前進程已被新階梯取代，或 targetSocket 關閉，自動停止
        if (this._captureProcess !== currentProcess || targetSocket.destroyed) {
          try { currentProcess.kill(); } catch (e) {}
          return;
        }

        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const first = findNextStartCode(buffer, 0);
          if (!first) {
            // 安全防護：僅在緩衝區無起始碼且異常超過 4MB 時重置，杜絕大尺寸 1080p/IDR 畫面被腰斬
            if (buffer.length > 4 * 1024 * 1024) buffer = Buffer.alloc(0);
            break;
          }
          const second = findNextStartCode(buffer, first.index + first.headerLen);
          if (!second) {
            if (first.index > 0) {
              buffer = buffer.subarray(first.index);
            }
            break;
          }

          const nalu = buffer.subarray(first.index, second.index);
          buffer = buffer.subarray(second.index);

          const len = nalu.length;
          if (len === 0) continue;

          const naluType = nalu[first.headerLen] & 0x1F;
          const isKeyframe = naluType === 5; // IDR
          const isConfig = naluType === 7 || naluType === 8; // SPS/PPS

          let flags = 0;
          if (isKeyframe) flags |= 0x01;
          if (isConfig) flags |= 0x02;

          // 分離快取 SPS (7) 與 PPS (8)，杜絕互相覆蓋
          if (naluType === 7) {
            this._cachedSps.set(targetRole, nalu);
            this._cachedConfigNalus.set(targetRole, nalu);
          } else if (naluType === 8) {
            this._cachedPps.set(targetRole, nalu);
          }
          if (isKeyframe) {
            this._cachedKeyframes.set(targetRole, nalu);
          }

          // Anti-Bufferbloat 防血崩熔斷機制 (借鑑 Moonlight 擁塞追幀模型)
          // 正常狀態下 (backlog <= 512KB) 100% 保全所有幀；若網路嚴重積壓 (> 512KB) 立即熔斷拋棄過期 P 幀
          // 絕不讓 TCP 排隊膨脹至 10MB+ (消滅 15 秒大延遲)，並在下一個 IDR 到來時瞬間零延遲歸位
          const backlog = targetSocket.writableLength || 0;
          const BLOAT_LIMIT = 512 * 1024; // 512KB 延遲熔斷水位
          if (backlog > BLOAT_LIMIT && !isKeyframe && !isConfig) {
            droppedFrames++;
            secDroppedFrames++;
            continue;
          }

          // Zero-Copy 零拷貝傳輸：預分配 9 字節 H.264 Header，配合 Socket cork/uncork 直接向量發送
          const header = Buffer.allocUnsafe(9);
          header[0] = 0x44; // 'D'
          header[1] = 0x54; // 'T'
          header[2] = 0x06; // 0x06: VIDEO_FRAME_H264
          header[3] = currentSeq++ & 0xFF;
          header[4] = flags;
          header.writeUInt32BE(len, 5);

          // 若 targetSocket 已銷毀或不可寫，立即停止推流並釋放進程
          if (targetSocket.destroyed || !targetSocket.writable) {
            try { currentProcess.kill(); } catch (e) {}
            return;
          }

          targetSocket.cork();
          targetSocket.write(header);
          targetSocket.write(nalu);
          targetSocket.uncork();

          // 精準統計：NALU 為 VCL 影像幀 (IDR: 5, P幀: 1) 時精確累加真實幀數 (FPS)
          // 徹底消滅 SPS/PPS 配置包虛報，精準反映 60fps 真實渲染幀率與輕量單幀大小
          const isVcl = naluType === 1 || naluType === 5;
          if (isVcl) {
            totalFrames++;
            secFrames++;
          }
          secBytes += (9 + len);

          const now = Date.now();
          if (now - lastMetricTime >= 1000) {
            const deltaSec = (now - lastMetricTime) / 1000;
            const currentFpsNum = secFrames / deltaSec;
            const currentFps = currentFpsNum.toFixed(1);
            const mbps = ((secBytes * 8) / (deltaSec * 1024 * 1024)).toFixed(2);
            const avgFrameKb = secFrames > 0 ? (secBytes / secFrames / 1024).toFixed(1) : '0';
            const backlogKb = (backlog / 1024).toFixed(1);
            const maxBacklogKb = (maxBacklog / 1024).toFixed(0);
            const healthLight = backlog === 0 ? '🟢 極度流暢' : backlog < (maxBacklog / 2) ? '🟡 緩衝良好' : '🔴 輕微擁塞';

            console.log(`[DuoTab-STREAM-HUD] 📊 [T${this._currentStreamTier}] 推流: ${currentFps} FPS | 碼率: ${mbps} Mbps | 單幀: ${avgFrameKb} KB | TCP排隊: ${backlogKb}/${maxBacklogKb} KB | 丟幀: ${droppedFrames} (+${secDroppedFrames}/s) (${healthLight})`);

            secDroppedFrames = 0;

            // 動態 ABR 自適應降級與平滑回升調控 (僅在未手動鎖定畫質時生效)
            if (!this._manualTier) {
              if (currentFpsNum < 20) {
                this._lowFpsCounter++;
                this._highFpsCounter = 0;
                if (this._lowFpsCounter >= 2 && this._currentStreamTier > 1) {
                  const nextTier = this._currentStreamTier - 1; // 往低畫質降級
                  console.log(`[DuoTab-ABR] ⚠️ 偵測到連續低幀率 (FPS: ${currentFps} < 20)，啟動動態自適應降級 ➔ ${STREAM_TIERS[nextTier].name}`);
                  this._lowFpsCounter = 0;
                  this._startScreenStreaming(socket, nextTier, true, this._currentStreamRole || 'console');
                  return;
                }
              } else if (currentFpsNum >= 23 && backlog === 0) {
                this._highFpsCounter++;
                this._lowFpsCounter = 0;
                if (this._highFpsCounter >= 5 && this._currentStreamTier < 3) {
                  const nextTier = this._currentStreamTier + 1; // 往高畫質回升
                  console.log(`[DuoTab-ABR] 🚀 網路極佳且穩定 (FPS: ${currentFps} >= 23)，平滑回升 ➔ ${STREAM_TIERS[nextTier].name}`);
                  this._highFpsCounter = 0;
                  this._startScreenStreaming(socket, nextTier, true, this._currentStreamRole || 'console');
                  return;
                }
              } else {
                this._lowFpsCounter = 0;
              }
            }

            secFrames = 0;
            secBytes = 0;
            lastMetricTime = now;
          }
        }
      });

      currentProcess.stderr?.on('data', (errChunk) => {
        const msg = errChunk.toString().trim();
        if (msg) {
          console.warn(`[DuoTab-FFMPEG-LOG] ${msg}`);
        }
      });

      currentProcess.on('exit', (code, signal) => {
        if (code !== 0 && code !== null) {
          console.warn(`[DuoTab-FFMPEG-EXIT] ⚠️ FFmpeg 進程已退出: code=${code}, signal=${signal}`);
        }
        if (this._captureProcess === currentProcess) {
          this._captureProcess = null;
        }
      });
      currentProcess.on('error', (err) => {
        console.error(`[DuoTab-FFMPEG-ERR] 🔴 FFmpeg 啟動異常: ${err.message}`);
        if (this._captureProcess === currentProcess) {
          this._captureProcess = null;
        }
      });
    } catch (e) {
      this._captureProcess = null;
    }
  }

  _stopScreenStreaming() {
    if (this._captureProcess) {
      try { this._captureProcess.kill(); } catch (e) {}
      this._captureProcess = null;
    }
  }

  _handleUdpMessage(msg, rinfo) {
    if (msg.length < 1) return;

    // 安全防護：若未開啟測試旁路，且當前無活躍 Console 客戶端或 TCP 連線，直接丟棄未授權的 UDP 雜訊
    if (!this.allowUnauthenticatedUdp && !this.clients.console && this._activeSockets.size === 0) {
      console.warn(`[DuoTab-NET] ⚠️ 收到 UDP 輸入 (來自 ${rinfo.address}:${rinfo.port}) 但門禁未開放 (無活躍連線)`);
      return;
    }

    const type = msg[0];
    if (type === PACKET_TYPE.MOUSE_MOVE_REL) {
      if (msg.length >= PACKET_SIZE[PACKET_TYPE.MOUSE_MOVE_REL]) {
        const mouseEvt = decodeMouseMove(msg);
        this.inputStateMachine.processMouseMove(mouseEvt);
        this.inputInjector.injectMouseMove(msg);

        // 即時高頻遙測 (每次有位移、按鍵或滾輪變化時即時打印)
        const now = Date.now();
        if (!this._lastMouseLog || now - this._lastMouseLog > 80 || mouseEvt.buttons !== 0 || mouseEvt.wheel !== 0) {
          console.log(`[DuoTab-INPUT] 🖱️ 滑鼠操作: ΔX=${mouseEvt.dx}, ΔY=${mouseEvt.dy}, 按鍵=0x${mouseEvt.buttons.toString(16)}, 滾輪=${mouseEvt.wheel}`);
          this._lastMouseLog = now;
        }
      }
    } else if (type === PACKET_TYPE.KEY_ACTION) {
      if (msg.length >= PACKET_SIZE[PACKET_TYPE.KEY_ACTION]) {
        const keyEvt = decodeKeyAction(msg);
        this.inputStateMachine.processKeyAction(keyEvt);
        this.inputInjector.injectKeyAction(msg);
        console.log(`[DuoTab-INPUT] ⌨️ 鍵盤動作: VK=0x${keyEvt.vkCode.toString(16).toUpperCase()} (${keyEvt.action === 1 ? '按下' : '釋放'}), 修飾鍵=0x${keyEvt.modifiers.toString(16)}`);
      }
    }
  }

  _handleClientDisconnect(role, socket) {
    if (role === CLIENT_ROLE.CONSOLE) {
      this.clients.console = null;
      console.log(`[DuoTab-NET] 🔴 Console 主操作艙已斷開連線！已觸發急停看門狗釋放全部按鍵。`);
      this.inputStateMachine.triggerEmergencyRelease();
      this.inputInjector.emergencyRelease();
      this._stopScreenStreaming();
    } else if (role === CLIENT_ROLE.DISPLAY) {
      this.clients.display = null;
      console.log(`[DuoTab-NET] 🔴 Display 延伸螢幕已斷開連線。`);
      if (!this.clients.console) {
        this._stopScreenStreaming();
      }
    }
  }

  /**
   * 即時請求 IDR 關鍵幀與自癒重發
   * @param {'console'|'display'} roleName
   */
  requestIdr(roleName = 'console') {
    const streamName = roleName === 'display' ? 'display' : 'console';
    console.log(`[DuoTab-RESILIENCE] 🛡️ 觸發主動 IDR 自癒請求 (${streamName})`);
    const targetVidSocket = this.clients[streamName]?.socket;
    if (targetVidSocket && !targetVidSocket.destroyed && targetVidSocket.writable) {
      const sps = this._cachedSps?.get(streamName);
      const pps = this._cachedPps?.get(streamName);
      const legacyConfig = this._cachedConfigNalus?.get(streamName);
      const keyframe = this._cachedKeyframes?.get(streamName);

      const sendPacket = (payload, flags) => {
        if (!payload || payload.length === 0) return;
        const hdr = Buffer.allocUnsafe(9);
        hdr[0] = 0x44;
        hdr[1] = 0x54;
        hdr[2] = 0x06;
        hdr[3] = (this._currentSeq++) & 0xFF;
        hdr[4] = flags;
        hdr.writeUInt32BE(payload.length, 5);
        targetVidSocket.write(hdr);
        targetVidSocket.write(payload);
      };

      targetVidSocket.cork();
      if (sps) sendPacket(sps, 0x02);
      if (pps) sendPacket(pps, 0x02);
      if (!sps && !pps && legacyConfig) sendPacket(legacyConfig, 0x02);
      if (keyframe) sendPacket(keyframe, 0x01);
      targetVidSocket.uncork();
    }
    return this.captureManager.handleNetworkFeedback(streamName, {
      rttMs: 25,
      packetLoss: 0.08
    });
  }

  /**
   * 停止所有網路服務並釋放注入器與捕獲器
   */
  async stop() {
    this.isListening = false;
    this._stopScreenStreaming();

    // 主動關閉所有現存連線以防 tcpServer.close 卡住
    for (const socket of this._activeSockets) {
      try { socket.destroy(); } catch (e) {}
    }
    this._activeSockets.clear();

    // 關閉 TCP 控制通道
    if (this.tcpServer) {
      await new Promise(r => this.tcpServer.close(r));
      this.tcpServer = null;
    }

    // 關閉 TCP 獨立視訊通道
    if (this.videoServer) {
      await new Promise(r => this.videoServer.close(r));
      this.videoServer = null;
    }

    // 關閉 UDP
    if (this.udpSocket) {
      await new Promise(r => this.udpSocket.close(r));
      this.udpSocket = null;
    }

    // 關閉注入器與捕獲器
    await this.inputInjector.close();
    await this.captureManager.stop();
  }
}
