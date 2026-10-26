import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * DuoTab-KVM 多螢幕拓撲探針
 * 讀取 Windows 系統實體顯示器幾何位置與主/副螢幕拓撲
 */
export class TopologyProbe {
  constructor(options = {}) {
    this._mockScreens = options.mockScreens || null;
    this._cache = null;
    this._cacheTime = 0;
    this._cacheTtlMs = options.cacheTtlMs ?? 10000;
  }

  /**
   * 獲取目前所有連線的螢幕資訊（具備 TTL 快取，避免高頻重複拉起進程）
   * @param {boolean} forceRefresh 是否強制刷新
   * @returns {Array<{ id: number, name: string, isPrimary: boolean, bounds: { x: number, y: number, width: number, height: number } }>}
   */
  getScreens(forceRefresh = false) {
    if (this._mockScreens) {
      return this._mockScreens;
    }

    const now = Date.now();
    if (!forceRefresh && this._cache && now - this._cacheTime < this._cacheTtlMs) {
      return this._cache;
    }

    try {
      // 透過 Windows 原生 EnumDisplaySettings 腳本快速讀取真實實體顯示器解析度 (繞過 DPI 縮放虛擬化)
      const scriptPath = fileURLToPath(new URL('./display-probe.ps1', import.meta.url));
      const psCmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
      const output = execSync(psCmd, { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!output) {
        return this._getFallbackDefaultScreen();
      }

      const parsed = JSON.parse(output);
      const list = Array.isArray(parsed) ? parsed : [parsed];

      const screens = list.map((s, index) => {
        const w = Number(s.Width) || 1920;
        const h = Number(s.Height) || 1080;
        const x = Number(s.X) || 0;
        const y = Number(s.Y) || 0;
        return {
          id: index,
          name: s.DeviceName || `Display-${index + 1}`,
          isPrimary: Boolean(s.Primary),
          width: w,
          height: h,
          bounds: { x, y, width: w, height: h }
        };
      });

      this._cache = screens;
      this._cacheTime = now;
      return screens;
    } catch (err) {
      // 容錯回退：若在非 Windows 或無顯示器環境，提供標準 1080p 預設螢幕
      return this._getFallbackDefaultScreen();
    }
  }

  /**
   * 區分 Console (主控制台螢幕) 與 Display (延伸第二螢幕)
   * 當現場有超過 2 個螢幕時，智慧挑選面積最大、解析度最高的延伸螢幕或指定 ID
   * @param {number|null} preferredSecondaryId 優先選定的副螢幕 ID
   */
  getDualScreenTopology(preferredSecondaryId = null) {
    const screens = this.getScreens();
    const primary = screens.find(s => s.isPrimary) || screens[0];
    const nonPrimaries = screens.filter(s => !s.isPrimary);

    let secondary = null;
    if (nonPrimaries.length > 0) {
      if (preferredSecondaryId !== null) {
        secondary = nonPrimaries.find(s => s.id === preferredSecondaryId) || null;
      }

      if (!secondary) {
        // 智慧選擇：按可視面積 (寬 x 高) 降序排序，優先選擇解析度最高的主力延伸螢幕
        const sorted = [...nonPrimaries].sort((a, b) => {
          const areaA = a.bounds.width * a.bounds.height;
          const areaB = b.bounds.width * b.bounds.height;
          return areaB - areaA;
        });
        secondary = sorted[0];
      }
    }

    return {
      consoleScreen: primary,
      displayScreen: secondary,
      hasDualScreens: screens.length >= 2,
      totalScreens: screens.length,
      allScreens: screens
    };
  }

  _getFallbackDefaultScreen() {
    return [{
      id: 0,
      name: 'Default Display',
      isPrimary: true,
      bounds: { x: 0, y: 0, width: 1920, height: 1080 }
    }];
  }
}
