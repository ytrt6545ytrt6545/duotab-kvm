import dgram from 'node:dgram';
import { networkInterfaces, hostname as getOsHostname } from 'node:os';

export const DISCOVERY_PORT = 5857;
export const MAGIC_PROBE = 'DUOTAB_DISCOVERY_PROBE';
export const MAGIC_ANNOUNCE = 'DUOTAB_DISCOVERY_ANNOUNCE';

/**
 * DuoTab-KVM 局域網自動尋標與服務廣播器 (ZeroConf / mDNS UDP Broadcast)
 * 支援多主機身分識別 (Host ID & Hostname) 與雙通道連接埠廣播
 */
export class DiscoveryService {
  constructor(options = {}) {
    this.port = options.port || DISCOVERY_PORT;
    this.tcpPort = options.tcpPort || 5858;
    this.videoPort = options.videoPort || (this.tcpPort === 5858 ? 5859 : this.tcpPort + 1);
    this.udpPort = options.udpPort || 5858;
    this.hostname = options.hostname || getOsHostname() || 'DuoTab-Host';
    this.hostId = options.hostId || `duotab-${this.hostname.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
    this.broadcastIntervalMs = options.broadcastIntervalMs || 1000;

    this.socket = null;
    this.timer = null;
    this.isAdvertising = false;
  }

  /**
   * 啟動 UDP 廣播與探測監聽
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        if (!this.isAdvertising) {
          reject(err);
        }
      });

      this.socket.on('message', (msg, rinfo) => {
        const text = msg.toString('utf-8').trim();
        if (text === MAGIC_PROBE) {
          // 收到客戶端探測，立即向其單播回應主機配置
          this._sendAnnounce(rinfo.address, rinfo.port);
        }
      });

      this.socket.bind(this.port, () => {
        try {
          this.socket.setBroadcast(true);
        } catch (e) {}

        this.isAdvertising = true;
        // 定期向局域網發送心跳廣播
        this.timer = setInterval(() => {
          this._sendAnnounce('255.255.255.255', this.port);
        }, this.broadcastIntervalMs);

        resolve({ port: this.port });
      });
    });
  }

  _sendAnnounce(targetHost, targetPort) {
    if (!this.socket || !this.isAdvertising) return;

    const payload = JSON.stringify({
      magic: MAGIC_ANNOUNCE,
      hostname: this.hostname,
      hostId: this.hostId,
      tcpPort: this.tcpPort,
      videoPort: this.videoPort,
      udpPort: this.udpPort,
      ips: this._getLocalIps(),
      timestamp: Date.now()
    });

    const msg = Buffer.from(payload, 'utf-8');
    this.socket.send(msg, 0, msg.length, targetPort, targetHost, (err) => {});
  }

  _getLocalIps() {
    const ips = [];
    const nets = networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) {
          ips.push(net.address);
        }
      }
    }
    return ips;
  }

  async stop() {
    this.isAdvertising = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.socket) {
      await new Promise(r => this.socket.close(r));
      this.socket = null;
    }
  }
}
