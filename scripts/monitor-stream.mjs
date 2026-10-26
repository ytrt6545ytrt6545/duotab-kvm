import net from 'node:net';
import readline from 'node:readline';

const TCP_PORT = parseInt(process.env.DUOTAB_VIDEO_PORT || '5859', 10);
const HOST = process.env.DUOTAB_HOST || '127.0.0.1';

console.clear();
console.log('===========================================================');
console.log('   DuoTab-KVM 串流傳輸即時物理監看儀表板 (Live HUD)');
console.log('===========================================================');
console.log(`[Monitor] 正在連線至 DuoTab 視訊傳輸通道 (${HOST}:${TCP_PORT})...`);

const socket = net.connect(TCP_PORT, HOST);
try { socket.setNoDelay(true); } catch (e) {}

let totalFrames = 0;
let totalBytes = 0;
let secFrames = 0;
let secBytes = 0;
let lastTime = Date.now();
let startTime = Date.now();
let rxBuffer = Buffer.alloc(0);

socket.on('connect', () => {
  console.log(`[Monitor] 🟢 成功接入視訊通道！開始實時監看傳輸訊號...\n`);
  lastTime = Date.now();
});

socket.on('data', (chunk) => {
  totalBytes += chunk.length;
  secBytes += chunk.length;
  rxBuffer = Buffer.concat([rxBuffer, chunk]);

  while (rxBuffer.length >= 7) {
    if (rxBuffer[0] === 0x44 && rxBuffer[1] === 0x54 && rxBuffer[2] === 0x05) {
      const frameLen = (rxBuffer[3] << 24) | (rxBuffer[4] << 16) | (rxBuffer[5] << 8) | rxBuffer[6];
      if (rxBuffer.length >= 7 + frameLen) {
        totalFrames++;
        secFrames++;
        rxBuffer = rxBuffer.subarray(7 + frameLen);
      } else {
        break;
      }
    } else {
      // 尋找下一個魔數
      const idx = rxBuffer.indexOf(Buffer.from([0x44, 0x54, 0x05]));
      if (idx !== -1) {
        rxBuffer = rxBuffer.subarray(idx);
      } else {
        rxBuffer = Buffer.alloc(0);
        break;
      }
    }
  }

  const now = Date.now();
  if (now - lastTime >= 1000) {
    const delta = (now - lastTime) / 1000;
    const fps = (secFrames / delta).toFixed(1);
    const mbps = ((secBytes * 8) / (delta * 1024 * 1024)).toFixed(2);
    const avgKb = secFrames > 0 ? (secBytes / secFrames / 1024).toFixed(1) : '0';
    const totalMb = (totalBytes / (1024 * 1024)).toFixed(2);
    const uptimeSec = Math.floor((now - startTime) / 1000);

    const healthLight = parseFloat(fps) >= 20 ? '🟢 流暢' : parseFloat(fps) > 0 ? '🟡 緩慢' : '🔴 等待';

    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`[HUD] ${healthLight} | FPS: ${fps.padStart(4)} | 碼率: ${mbps.padStart(5)} Mbps | 單幀: ${avgKb.padStart(5)} KB | 累計幀: ${String(totalFrames).padStart(6)} | 總量: ${totalMb} MB | 監看: ${uptimeSec}s   `);

    secFrames = 0;
    secBytes = 0;
    lastTime = now;
  }
});

socket.on('error', (err) => {
  console.log(`\n[Monitor] 🔴 連線異常: ${err.message}`);
  console.log('[Monitor] 提示: 請確認 DuoTab 伺服器 (npm start) 已啟動並有平板接入串流。');
});

socket.on('close', () => {
  console.log(`\n[Monitor] 視訊通道已關閉。監看結束。`);
  process.exit(0);
});
