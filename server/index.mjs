import { NetworkCoordinator } from './network/network-coordinator.mjs';
import { DiscoveryService } from './network/discovery-service.mjs';

/**
 * DuoTab-KVM PC 端伺服器主入口
 */
export async function startServer(options = {}) {
  const coordinator = new NetworkCoordinator(options);
  const discovery = new DiscoveryService(options);

  console.log('[DuoTab-Server] 正在啟動雙通道網路協調器...');
  const netInfo = await coordinator.start();
  console.log(`[DuoTab-Server] TCP 控制通道已綁定於連接埠: ${netInfo.tcpPort}`);
  console.log(`[DuoTab-Server] TCP 獨立視訊通道已綁定於連接埠: ${netInfo.videoPort}`);
  console.log(`[DuoTab-Server] UDP 輸入通道已綁定於連接埠: ${netInfo.udpPort}`);
  console.log(`[DuoTab-Server] 實體螢幕拓撲: 雙螢幕=${netInfo.topology.hasDualScreens}, 主螢幕=${netInfo.topology.consoleScreen.name}`);

  console.log('[DuoTab-Server] 正在啟動局域網自動尋標廣播器...');
  await discovery.start();
  console.log(`[DuoTab-Server] mDNS 廣播已就緒 (主機: ${discovery.hostname}, ID: ${discovery.hostId})，等待 Android 平板自動連線配對！`);

  return {
    coordinator,
    discovery,
    async stop() {
      await discovery.stop();
      await coordinator.stop();
      console.log('[DuoTab-Server] 伺服器已優雅停機。');
    }
  };
}

// 註冊全域網路異常守護攔截器，防止客戶端無預警 RST 導致伺服器崩潰
process.on('uncaughtException', (err) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE' || err.code === 'ECONNABORTED') {
    console.warn(`[DuoTab-Server] ⚠️ 攔截客戶端非預期網路斷線 (${err.code})，守護主服務持續運行`);
    return;
  }
  console.error('[DuoTab-Server] 致命異常:', err);
  process.exit(1);
});

// 支援直接透過 node server/index.mjs 獨立執行
if (process.argv[1] && process.argv[1].endsWith('index.mjs')) {
  startServer().catch(err => {
    console.error('[DuoTab-Server] 啟動失敗:', err);
    process.exit(1);
  });
}

