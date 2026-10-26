import { spawn } from 'node:child_process';
import fs from 'node:fs';

console.log('[TestCapture] 正在測試 FFmpeg 抓取桌面 (修正 probesize 與輸入選項)...');
const ffmpeg = spawn('ffmpeg', [
  '-probesize', '32M',
  '-analyzeduration', '32M',
  '-f', 'gdigrab',
  '-framerate', '30',
  '-video_size', '1536x864',
  '-offset_x', '0',
  '-offset_y', '0',
  '-i', 'desktop',
  '-c:v', 'libx264',
  '-preset', 'ultrafast',
  '-tune', 'zerolatency',
  '-pix_fmt', 'yuv420p',
  '-g', '30',
  '-f', 'h264',
  '-y',
  'test_out.h264'
]);

let errLog = '';
ffmpeg.stderr.on('data', d => errLog += d.toString());

setTimeout(() => {
  ffmpeg.kill('SIGKILL');
  console.log('[TestCapture] 測試結束，檢查產物...');
  if (fs.existsSync('test_out.h264')) {
    const size = fs.statSync('test_out.h264').size;
    console.log(`✅ 成功捕獲桌面 H.264 串流！大小: ${size} bytes`);
    fs.unlinkSync('test_out.h264');
  } else {
    console.log('❌ 未生成檔案，錯誤日誌:');
    console.log(errLog.split('\n').slice(-15).join('\n'));
  }
  process.exit(0);
}, 3000);
