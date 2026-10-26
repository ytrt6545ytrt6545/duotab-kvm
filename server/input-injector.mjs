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
    this.psScriptPath = options.psScriptPath || resolve(__dirname, 'native', 'bridge.ps1');
    this.process = null;
    this.injectedEvents = []; // 僅在明確指定 mock: true 時記錄
    this.isOpen = false;
    this._stdoutBuffer = Buffer.alloc(0);
    this._pendingResolvers = [];
  }

  /**
   * 初始化並拉起原生輸入進程
   * 優先使用 PowerShell 原生記憶體宿主（避開防毒軟體對無簽名 EXE 的誤殺）
   */
  async start() {
    if (this.mock) {
      this.isOpen = true;
      return;
    }

    // 判斷啟動方式：若有可信 exe 則用 exe，否則直接以微軟官方簽名 powershell.exe 執行 bridge.ps1
    let command;
    let args;

    if (existsSync(this.exePath)) {
      command = this.exePath;
      args = [];
    } else if (existsSync(this.psScriptPath)) {
      command = 'powershell.exe';
      args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.psScriptPath];
    } else {
      throw new Error(`[InputInjector] Neither native executable (${this.exePath}) nor PowerShell bridge (${this.psScriptPath}) found!`);
    }

    this.process = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    this.process.stdout.on('data', (chunk) => {
      this._stdoutBuffer = Buffer.concat([this._stdoutBuffer, chunk]);
      this._flushPendingQueries();
    });

    this.process.stdin.on('error', () => {
      this.isOpen = false;
    });

    this.isOpen = false;

    await new Promise((resolveReady, rejectReady) => {
      let isReady = false;
      const readyTimer = setTimeout(() => {
        if (!isReady) {
          this.isOpen = false;
          try { this.process?.kill(); } catch (e) {}
          rejectReady(new Error('[InputInjector] Timed out waiting for [Bridge] Ready signal (10s)'));
        }
      }, 10000);

      this.process.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        process.stderr.write(text);
        if (text.includes('[Bridge] Ready')) {
          isReady = true;
          this.isOpen = true;
          clearTimeout(readyTimer);
          resolveReady();
        }
      });

      this.process.once('error', (err) => {
        clearTimeout(readyTimer);
        rejectReady(err);
      });

      this.process.once('exit', (code) => {
        if (!isReady) {
          clearTimeout(readyTimer);
          rejectReady(new Error(`[InputInjector] Bridge process exited prematurely with code ${code}`));
        }
      });
    });
  }

  _flushPendingQueries() {
    while (this._pendingResolvers.length > 0 && this._stdoutBuffer.length >= 8) {
      const resolver = this._pendingResolvers.shift();
      const x = this._stdoutBuffer.readInt32BE(0);
      const y = this._stdoutBuffer.readInt32BE(4);
      this._stdoutBuffer = this._stdoutBuffer.subarray(8);
      resolver({ x, y });
    }
  }

  /**
   * 獲取真實 Windows 游標座標 (Win32 GetCursorPos)
   */
  async getCursorPos() {
    if (!this.isOpen) {
      throw new Error('[InputInjector] Cannot get cursor position: injector is not open!');
    }

    if (this.mock) {
      return null;
    }

    if (!this.process?.stdin?.writable) {
      throw new Error('[InputInjector] Process stdin is not writable!');
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('[InputInjector] GetCursorPos timeout after 1500ms'));
      }, 1500);

      this._pendingResolvers.push((pos) => {
        clearTimeout(timeout);
        resolve(pos);
      });

      this.process.stdin.write(Buffer.from([0x00]));
    });
  }

  /**
   * 注入滑鼠位移與按鈕
   * @param {Buffer|Object} mousePacket 8-Byte Buffer 或滑鼠物件
   */
  injectMouseMove(mousePacket) {
    if (!this.isOpen) {
      throw new Error('[InputInjector] Cannot inject mouse: injector is closed!');
    }

    const buf = Buffer.isBuffer(mousePacket) ? mousePacket : encodeMouseMove(mousePacket);

    if (this.mock) {
      this.injectedEvents.push({ type: PACKET_TYPE.MOUSE_MOVE_REL, raw: buf });
      return true;
    }

    if (this.process?.stdin?.writable) {
      return this.process.stdin.write(buf);
    }
    return false;
  }

  /**
   * 注入鍵盤動作
   * @param {Buffer|Object} keyPacket 6-Byte Buffer 或按鍵物件
   */
  injectKeyAction(keyPacket) {
    if (!this.isOpen) {
      throw new Error('[InputInjector] Cannot inject key: injector is closed!');
    }

    const buf = Buffer.isBuffer(keyPacket) ? keyPacket : encodeKeyAction(keyPacket);

    if (this.mock) {
      this.injectedEvents.push({ type: PACKET_TYPE.KEY_ACTION, raw: buf });
      return true;
    }

    if (this.process?.stdin?.writable) {
      return this.process.stdin.write(buf);
    }
    return false;
  }

  /**
   * 急停釋放所有按鍵
   */
  emergencyRelease() {
    if (!this.isOpen) return false;

    if (this.mock) {
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
