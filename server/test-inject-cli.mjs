import { InputInjector } from './input-injector.mjs';
import { BUTTON_MASKS } from '../protocol/constants.mjs';

/**
 * 本機 Live Reality 示蹤腳本
 * 執行後會讓滑鼠在 Windows 桌面上自動順時針微幅畫一個圓形軌跡
 * 用於親眼驗證 Win32 SendInput 物理注入真實性！
 */
async function main() {
  console.log('🚀 [DuoTab-KVM] 啟動 Win32 SendInput 本機物理注入測試...');
  const injector = new InputInjector({ mock: false });
  await injector.start();

  console.log('🖱️ 注入滑鼠畫圓軌跡 (半徑 80px，36 步，間隔 20ms)...');

  const steps = 36;
  const radius = 80;
  let prevX = radius;
  let prevY = 0;

  for (let i = 1; i <= steps; i++) {
    const angle = (i / steps) * (2 * Math.PI);
    const currX = Math.round(radius * Math.cos(angle));
    const currY = Math.round(radius * Math.sin(angle));

    const dx = currX - prevX;
    const dy = currY - prevY;

    injector.injectMouseMove({ dx, dy, wheel: 0, buttons: BUTTON_MASKS.NONE, seq: i });

    prevX = currX;
    prevY = currY;

    await new Promise((r) => setTimeout(r, 20));
  }

  console.log('✅ 滑鼠軌跡注入完成！');
  await injector.close();
  console.log('🔒 注入器已安全關閉。');
}

main().catch(console.error);
