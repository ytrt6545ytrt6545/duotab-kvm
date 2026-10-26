#!/usr/bin/env node
/**
 * demo-simulate.mjs - 本地端到端實境模擬測試工具
 * 模擬一台 Android Console 平板連線至本機 DuoTab-Server：
 * 1. 建立 TCP 5858 控制連線並每 500ms 傳送心跳租約
 * 2. 透過 UDP 5858 發送平滑滑鼠移動軌跡（長官可在螢幕上看見游標移動）
 * 3. 測試斷線急停看門狗 (Deadman Release)
 */

import net from 'node:net';
import dgram from 'node:dgram';
import { encodeHeartbeat, encodeMouseMove } from '../protocol/packet-codec.mjs';
import { CLIENT_ROLE, BUTTON_MASKS } from '../protocol/constants.mjs';

const TCP_PORT = 5858;
const UDP_PORT = 5858;
const HOST = '127.0.0.1';

console.log('🎮 [DuoTab-Sim] 正在啟動虛擬 Android Console 平板模擬端...');

// 1. 連線至 TCP 控制通道
const tcpClient = new net.Socket();
const udpClient = dgram.createSocket('udp4');

tcpClient.connect(TCP_PORT, HOST, () => {
  console.log(`✅ [DuoTab-Sim] 已成功連線至 PC 控制通道 (${HOST}:${TCP_PORT})`);

  // 2. 啟動 500ms 租約心跳
  const hbTimer = setInterval(() => {
    const hbPacket = encodeHeartbeat({
      role: CLIENT_ROLE.CONSOLE,
      leaseMs: 1500,
      timestamp: Date.now()
    });
    tcpClient.write(hbPacket);
  }, 500);

  console.log('📡 [DuoTab-Sim] 心跳已啟用 (週期 500ms, 租約 1500ms)');
  console.log('🖱️ [DuoTab-Sim] 開始發送滑鼠相對位移封包 (長官請觀察螢幕上的滑鼠游標)...');

  let step = 0;
  const radius = 20;
  const moveTimer = setInterval(() => {
    step++;
    const angle = (step * 0.15);
    const dx = Math.round(Math.cos(angle) * radius);
    const dy = Math.round(Math.sin(angle) * radius);

    const mousePacket = encodeMouseMove({
      dx,
      dy,
      wheel: 0,
      buttons: BUTTON_MASKS.NONE
    });

    udpClient.send(mousePacket, UDP_PORT, HOST);

    if (step >= 40) {
      clearInterval(moveTimer);
      clearInterval(hbTimer);
      console.log('🏁 [DuoTab-Sim] 滑鼠圓形軌跡示範完畢！');
      console.log('🔌 [DuoTab-Sim] 模擬平板斷線，測試 PC 端看門狗防黏鍵急停...');
      tcpClient.destroy();
      udpClient.close();
      console.log('🎉 [DuoTab-Sim] 測試圓滿完成！');
      process.exit(0);
    }
  }, 50);
});

tcpClient.on('error', (err) => {
  console.error(`❌ [DuoTab-Sim] 連線失敗: ${err.message}`);
  console.log('💡 請確認是否已先啟動主機伺服器: node server/index.mjs');
  udpClient.close();
  process.exit(1);
});
