import { startServer } from '../server/index.mjs';
import { spawn } from 'node:child_process';

console.log('[E2E-Demo] 正在啟動伺服器實例...');
const server = await startServer({ allowUnauthenticatedUdp: true });

console.log('[E2E-Demo] 正在啟動虛擬客戶端模擬程序...');
const clientProc = spawn('node', ['scripts/demo-simulate.mjs'], {
  cwd: process.cwd(),
  stdio: 'inherit'
});

clientProc.on('exit', async (code) => {
  console.log(`[E2E-Demo] 模擬端已完成，退出碼: ${code}`);
  console.log('[E2E-Demo] 正在關閉伺服器實例...');
  await server.stop();
  console.log('[E2E-Demo] 全鏈路演練驗證完成！');
  process.exit(code || 0);
});
