import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const distDir = path.resolve(rootDir, 'dist');
const bundleDir = path.resolve(distDir, 'DuoTab-Host-Windows');
const zipFile = path.resolve(distDir, 'DuoTab-Host-Windows.zip');

console.log('[Bundle] 正在為新桌機準備免安裝綠色部署包...');

// 確保 dist 目錄存在
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir, { recursive: true });
}
if (fs.existsSync(bundleDir)) {
  fs.rmSync(bundleDir, { recursive: true, force: true });
}
fs.mkdirSync(bundleDir, { recursive: true });

// 複製核心目錄與檔案
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// 1. 複製 server 與 protocol
console.log('[Bundle] 複製伺服端程式碼 (server, protocol)...');
copyDir(path.join(rootDir, 'server'), path.join(bundleDir, 'server'));
copyDir(path.join(rootDir, 'protocol'), path.join(bundleDir, 'protocol'));

// 2. 複製 scripts (僅保留 setup-host-prerequisites.ps1)
fs.mkdirSync(path.join(bundleDir, 'scripts'), { recursive: true });
fs.copyFileSync(
  path.join(rootDir, 'scripts', 'setup-host-prerequisites.ps1'),
  path.join(bundleDir, 'scripts', 'setup-host-prerequisites.ps1')
);

// 3. 複製根目錄必要檔案
const rootFiles = ['package.json', 'Setup-New-PC.bat', 'Start-DuoTab.bat'];
for (const f of rootFiles) {
  const p = path.join(rootDir, f);
  if (fs.existsSync(p)) {
    fs.copyFileSync(p, path.join(bundleDir, f));
  }
}

// 4. 寫入清晰的繁體中文說明文件
const readmeContent = `=========================================================
  ⚡ DuoTab-KVM 新桌機 (PC/筆電) 綠色免安裝部署包
=========================================================

這是一個超低延遲的雙平板遠端桌面主機端伺服器。
請按照以下步驟快速在另一台電腦上啟用：

【步驟 1：首次環境設定 (只需執行一次)】
👉 右鍵點擊「Setup-New-PC.bat」，選擇【以系統管理員身分執行】。
   - 系統會自動檢測 Node.js 與 FFmpeg (若無會自動安裝)。
   - 自動開通 Windows 防火牆規則 (Port 5858 與 5859)。
   - 自動編譯並就緒 Win32 原生輸入穿透器 (InputBridge.exe)。
   - 視窗最下方會顯示您這台電腦的區網 IP (例如 192.168.0.xxx)。

【步驟 2：平時日常啟動】
👉 平常只要雙擊「Start-DuoTab.bat」即可啟動伺服器！
   - 啟動後視窗請保持開啟。
   - 拿起手機/平板開啟 DuoTab App，App 會自動搜尋並秒連！

【系統規格要求】
- 作業系統：Windows 10 / Windows 11 (64 位元)
- 網路環境：與手機/平板處於同一個 Wi-Fi 路由器或區域網路。
=========================================================
`;
fs.writeFileSync(path.join(bundleDir, '使用說明_README.txt'), readmeContent, 'utf-8');

console.log('[Bundle] 正在壓縮成 ZIP 發布包...');
if (fs.existsSync(zipFile)) {
  fs.rmSync(zipFile, { force: true });
}

// 調用 PowerShell Compress-Archive 產出 ZIP
execSync(`powershell -NoProfile -Command "Compress-Archive -Path '${bundleDir}\\*' -DestinationPath '${zipFile}' -Force"`);

console.log(`[Bundle] ✅ 打包完成！發布包位於:\n  👉 ${zipFile}`);
