import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SCRIPT_PATH = path.join(__dirname, 'query-process-perf.ps1');

/**
 * DuoTab-KVM FFmpeg 進程 CPU 與 GPU 性能即時觀測器 (ProcessPerfMonitor)
 * 遵循深模組架構與非同步快取設計：採樣完全非同步進行，HUD 讀取為 0ms 記憶體快取
 */
export class ProcessPerfMonitor {
  constructor(options = {}) {
    this.targetPid = options.targetPid || null;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 2500;
    this.cpuCount = options.cpuCount || (os.cpus().length || 4);
    this.queryRunner = options.queryRunner || this._defaultQueryRunner.bind(this);

    this.timer = null;
    this.isSampling = false;
    this.lastSampleTime = 0;
    this.lastCpuSec = 0;

    this.metrics = {
      cpuPercent: '--',
      gpuPercent: '--',
      memoryMb: '--',
      isAvailable: false
    };
  }

  setTargetPid(pid) {
    if (this.targetPid !== pid) {
      this.targetPid = pid;
      this.lastSampleTime = 0;
      this.lastCpuSec = 0;
      if (!pid) {
        this.metrics = {
          cpuPercent: '--',
          gpuPercent: '--',
          memoryMb: '--',
          isAvailable: false
        };
      }
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.sample().catch(() => {});
    }, this.sampleIntervalMs);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sample(now = Date.now()) {
    if (!this.targetPid || this.isSampling) return this.metrics;
    this.isSampling = true;

    try {
      const output = await this.queryRunner(this.targetPid);
      // 輸出格式: "cpuSec,gpuPercent,wsMB"
      const parts = output.trim().split(',');
      if (parts.length >= 3) {
        const cpuSec = parseFloat(parts[0]) || 0;
        const gpuVal = parseFloat(parts[1]) || 0;
        const memMb = parseFloat(parts[2]) || 0;

        let cpuPercentStr = '0.0';
        if (this.lastSampleTime > 0 && now > this.lastSampleTime && cpuSec >= this.lastCpuSec) {
          const deltaSec = (now - this.lastSampleTime) / 1000;
          const deltaCpu = cpuSec - this.lastCpuSec;
          // 全局 CPU 百分比 (全核心均攤)
          const pct = Math.min(100, Math.max(0, (deltaCpu / (deltaSec * this.cpuCount)) * 100));
          cpuPercentStr = pct.toFixed(1);
        }

        this.lastSampleTime = now;
        this.lastCpuSec = cpuSec;

        this.metrics = {
          cpuPercent: cpuPercentStr,
          gpuPercent: gpuVal.toFixed(1),
          memoryMb: memMb.toFixed(1),
          isAvailable: true
        };
      }
    } catch {
      // 遇到異常保持安全快取
    } finally {
      this.isSampling = false;
    }

    return this.metrics;
  }

  getMetrics() {
    return this.metrics;
  }

  _defaultQueryRunner(pid) {
    return new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${SCRIPT_PATH}" -ProcessId ${pid}`;
      exec(cmd, { timeout: 3000 }, (error, stdout) => {
        if (error) {
          reject(error);
        } else {
          resolve(stdout || '0,0,0');
        }
      });
    });
  }
}
