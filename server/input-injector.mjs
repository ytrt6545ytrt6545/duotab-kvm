import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeMouseMove, encodeKeyAction } from '../protocol/packet-codec.mjs';
import { PACKET_TYPE } from '../protocol/constants.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export class InputInjector {
  constructor(options = {}) {
    this.mock = options.mock ?? false;
    this.exePath = options.exePath || resolve(__dirname, 'native', 'InputBridge.exe');
    this.process = null;
    this.injectedEvents = []; // Mock 模式下的事件記錄
    this.mockCursor = { x: 500, y: 500 }; // Mock 模式下的游標模擬
    this.isOpen = false;
    this._stdoutBuffer = Buffer.alloc(0);
    this._pendingResolvers = [];
    this.antivirusBlocked = false; // 是否被防毒軟體攔截
  }

  /**
   * 初始化並拉起原生輸入進程
   */
  async start() {
    if (this.mock) {
      this.isOpen = true;
      return;
    }

    if (!existsSync(this.exePath)) {
      // 若檔案不存在（可能被防毒刪除），自動回退至 Mock 模式並標記
      this.antivirusBlocked = true;
      this.mock = true;
      this.isOpen = true;
      console.warn(`[InputInjector] Native executable not found (possibly quarantined by Antivirus). Fallback to Mock.`);
      return;
    }

    try {
      this.process = spawn(this.exePath, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });

      this.process.stdout.on('data', (chunk) => {
        this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, chunk]);
        this._flushPendingQueries();
      });

      this.process.stdin.on('error', (err) => {
        this.isOpen = false;
      });

      this.process.on('error', (err) => {
        // 若遭防毒攔截 (errno -4094 或 EPERM)，安全降級
        this.isOpen = false;
        this.antivirusBlocked = true;
        this.mock = true;
        this.isOpen = true;
      });

      this.process.on('exit', (code) => {
        this.isOpen = false;
      });

      this.isOpen = true;
    } catch (err) {
      this.antivirusBlocked = true;
      this.mock = true;
      this.isOpen = true;
      console.warn(`[InputInjector] Spawn failed (${err.code}). Antivirus quarantine detected. Safe fallback activated.`);
    }
  }

  _flushPendingQueries() {
    while (this._pendingResolvers.length > 0 && this._stdoutBuffer.length >= 4) {
      const resolver = this._pendingResolvers.shift();
      const x = this._stdoutBuffer.readInt16BE(0);
      const y = this._stdoutBuffer.readInt16BE(2);
      this._stdoutBuffer = this._stdoutBuffer.subarray(4);
      resolver({ x, y });
    }
  }

  /**
   * 獲取真實 Windows 游標座標 (Win32 GetCursorPos)
   */
  async getCursorPos() {
    if (!this.isOpen) return null;

    if (this.mock || this.antivirusBlocked) {
      return { ...this.mockCursor };
    }

    if (!this.process?.stdin?.writable) return null;

    return new Promise((resolve) => {
      this._pendingResolvers.push(resolve);
      this.process.stdin.write(Buffer.from([0x00]));
    });
  }

  /**
   * 注入滑鼠位移與按鈕
   * @param {Buffer|Object} mousePacket 8-Byte Buffer 或滑鼠物件
   */
  injectMouseMove(mousePacket) {
    if (!this.isOpen || !this.process?.stdin?.writable || this.antivirusBlocked) {
      if ((this.mock || this.antivirusBlocked) && this.isOpen) {
        const buf = Buffer.isBuffer(mousePacket) ? mousePacket : encodeMouseMove(mousePacket);
        this.injectedEvents.push({ type: PACKET_TYPE.MOUSE_MOVE_REL, raw: buf });
        if (!Buffer.isBuffer(mousePacket)) {
          this.mockCursor.x += mousePacket.dx || 0;
          this.mockCursor.y += mousePacket.dy || 0;
        }
        return true;
      }
      return false;
    }

    const buf = Buffer.isBuffer(mousePacket) ? mousePacket : encodeMouseMove(mousePacket);
    try {
      return this.process.stdin.write(buf);
    } catch (e) {
      return false;
    }
  }

  /**
   * 注入鍵盤動作
   * @param {Buffer|Object} keyPacket 6-Byte Buffer 或按鍵物件
   */
  injectKeyAction(keyPacket) {
    if (!this.isOpen || !this.process?.stdin?.writable || this.antivirusBlocked) {
      if ((this.mock || this.antivirusBlocked) && this.isOpen) {
        const buf = Buffer.isBuffer(keyPacket) ? keyPacket : encodeKeyAction(keyPacket);
        this.injectedEvents.push({ type: PACKET_TYPE.KEY_ACTION, raw: buf });
        return true;
      }
      return false;
    }

    const buf = Buffer.isBuffer(keyPacket) ? keyPacket : encodeKeyAction(keyPacket);
    try {
      return this.process.stdin.write(buf);
    } catch (e) {
      return false;
    }
  }

  /**
   * 急停釋放所有按鍵
   */
  emergencyRelease() {
    if (!this.isOpen) return false;

    if (this.mock || this.antivirusBlocked) {
      this.injectedEvents.push({ type: 0xFF, reason: 'EMERGENCY_RELEASE' });
      return true;
    }

    if (this.process?.stdin?.writable) {
      try {
        return this.process.stdin.write(Buffer.from([0xFF]));
      } catch (e) {
        return false;
      }
    }
    return false;
  }

  /**
   * 優雅關閉注入器
   */
  async close() {
    this.isOpen = false;
    if (this.process) {
      const proc = this.process;
      this.process = null;

      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { proc.kill(); } catch (e) {}
          resolve();
        }, 300);

        proc.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });

        try {
          proc.stdin.end();
        } catch (e) {
          clearTimeout(timer);
          resolve();
        }
      });
    }
  }
}
