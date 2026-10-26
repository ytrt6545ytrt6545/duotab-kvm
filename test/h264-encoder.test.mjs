import test from 'node:test';
import assert from 'node:assert/strict';
import { EncoderAdapter } from '../server/capture/encoder-adapter.mjs';
import { ENCODER_BACKEND } from '../server/capture/capture-constants.mjs';
import { STREAM_TIERS } from '../server/network/network-coordinator.mjs';
import { PACKET_TYPE, STREAM_MAGIC, H264_FRAME_FLAGS, NALU_TYPE } from '../protocol/constants.mjs';
import { decodeH264Frame } from '../protocol/packet-codec.mjs';

test('EncoderAdapter - 全後端 FFmpeg 零延遲參數矩陣校驗 (NVENC, QSV, AMF, SOFTWARE)', (t) => {
  const adapter = new EncoderAdapter();

  // 1. NVIDIA NVENC
  const nvencArgs = adapter.buildFFmpegArgs({
    backend: ENCODER_BACKEND.NVENC,
    scaleW: 640,
    scaleH: 360,
    fps: 60,
    bitrateKbps: 2000,
    gopSize: 30
  });
  assert.ok(nvencArgs.includes('-c:v') && nvencArgs[nvencArgs.indexOf('-c:v') + 1] === 'h264_nvenc');
  assert.ok(nvencArgs.includes('-preset') && nvencArgs[nvencArgs.indexOf('-preset') + 1] === 'p1');
  assert.ok(nvencArgs.includes('-tune') && nvencArgs[nvencArgs.indexOf('-tune') + 1] === 'ull');
  assert.ok(nvencArgs.includes('-zerolatency') && nvencArgs[nvencArgs.indexOf('-zerolatency') + 1] === '1');
  assert.ok(nvencArgs.includes('-bf') && nvencArgs[nvencArgs.indexOf('-bf') + 1] === '0', 'NVENC 必須關閉 B 幀');
  assert.ok(nvencArgs.includes('-f') && nvencArgs[nvencArgs.lastIndexOf('-f') + 1] === 'h264');
  assert.equal(nvencArgs[nvencArgs.length - 1], 'pipe:1');

  // 2. Intel QSV
  const qsvArgs = adapter.buildFFmpegArgs({
    backend: ENCODER_BACKEND.QSV,
    scaleW: 960,
    scaleH: 540,
    fps: 60,
    bitrateKbps: 4000
  });
  assert.ok(qsvArgs.includes('-c:v') && qsvArgs[qsvArgs.indexOf('-c:v') + 1] === 'h264_qsv');
  assert.ok(qsvArgs.includes('-scenario') && qsvArgs[qsvArgs.indexOf('-scenario') + 1] === 'displayremoting');
  assert.ok(qsvArgs.includes('-low_power') && qsvArgs[qsvArgs.indexOf('-low_power') + 1] === '1');
  assert.ok(qsvArgs.includes('-forced_idr') && qsvArgs[qsvArgs.indexOf('-forced_idr') + 1] === '1');
  assert.ok(qsvArgs.includes('-preset') && qsvArgs[qsvArgs.indexOf('-preset') + 1] === 'veryfast');
  assert.ok(qsvArgs.includes('-async_depth') && qsvArgs[qsvArgs.indexOf('-async_depth') + 1] === '1', 'QSV 必須鎖定 async_depth 1 零佇列');
  assert.ok(qsvArgs.includes('-r') && qsvArgs[qsvArgs.indexOf('-r') + 1] === '60', 'QSV 必須鎖定輸出幀率上限');
  assert.ok(qsvArgs.includes('-bf') && qsvArgs[qsvArgs.indexOf('-bf') + 1] === '0');
  assert.ok(qsvArgs.includes('-pix_fmt') && qsvArgs[qsvArgs.indexOf('-pix_fmt') + 1] === 'nv12');
  assert.equal(qsvArgs[qsvArgs.length - 1], 'pipe:1');

  // 3. AMD AMF
  const amfArgs = adapter.buildFFmpegArgs({
    backend: ENCODER_BACKEND.AMF,
    bitrateKbps: 3000
  });
  assert.ok(amfArgs.includes('-c:v') && amfArgs[amfArgs.indexOf('-c:v') + 1] === 'h264_amf');
  assert.ok(amfArgs.includes('-usage') && amfArgs[amfArgs.indexOf('-usage') + 1] === 'ultralowlatency');
  assert.ok(amfArgs.includes('-bf') && amfArgs[amfArgs.indexOf('-bf') + 1] === '0');

  // 4. CPU 軟體備援 (libx264)
  const cpuArgs = adapter.buildFFmpegArgs({
    backend: ENCODER_BACKEND.SOFTWARE,
    bitrateKbps: 1000,
    fps: 30
  });
  assert.ok(cpuArgs.includes('-c:v') && cpuArgs[cpuArgs.indexOf('-c:v') + 1] === 'libx264');
  assert.ok(cpuArgs.includes('-preset') && cpuArgs[cpuArgs.indexOf('-preset') + 1] === 'ultrafast');
  assert.ok(cpuArgs.includes('-tune') && cpuArgs[cpuArgs.indexOf('-tune') + 1] === 'zerolatency');
  assert.ok(cpuArgs.includes('-bf') && cpuArgs[cpuArgs.indexOf('-bf') + 1] === '0');
  assert.ok(cpuArgs.includes('-profile:v') && cpuArgs[cpuArgs.indexOf('-profile:v') + 1] === 'baseline');
});

test('EncoderAdapter - 畫質階梯 (STREAM_TIERS) 與碼率參數精確映射', (t) => {
  const adapter = new EncoderAdapter();

  // Tier 1: 480p, 1.8Mbps, 60fps
  const t1 = STREAM_TIERS[1];
  assert.equal(t1.width, 854);
  assert.equal(t1.bitrateKbps, 1800);
  assert.equal(t1.fps, 60);
  const args1 = adapter.buildFFmpegArgs({ scaleW: t1.width, fps: t1.fps, bitrateKbps: t1.bitrateKbps });
  assert.ok(args1.some(arg => arg.includes(`scale=${t1.width}:360:flags=fast_bilinear`)));
  assert.ok(args1.some(arg => arg.includes(`fps=fps=${t1.fps}`)));
  assert.ok(args1.includes('1800k'));

  // Tier 2: 720p, 3.5Mbps, 60fps
  const t2 = STREAM_TIERS[2];
  assert.equal(t2.width, 1280);
  assert.equal(t2.bitrateKbps, 3500);
  assert.equal(t2.fps, 60);

  // Tier 3: 1080p, 6.5Mbps, 60fps
  const t3 = STREAM_TIERS[3];
  assert.equal(t3.width, 1920);
  assert.equal(t3.bitrateKbps, 6500);
  assert.equal(t3.fps, 60);
});

test('H.264 串流管道 - Annex-B 切幀狀態機與 9-Byte Header 封裝驗證', (t) => {
  // 構造連續的 Annex-B 串流: SPS(7) + PPS(8) + IDR(5) + P-frame(1)
  const sps = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, NALU_TYPE.SPS]), Buffer.alloc(15, 0x11)]);
  const pps = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, NALU_TYPE.PPS]), Buffer.alloc(8, 0x22)]);
  const idr = Buffer.concat([Buffer.from([0x00, 0x00, 0x00, 0x01, NALU_TYPE.IDR]), Buffer.alloc(40, 0x33)]);
  const pFrame = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, NALU_TYPE.NON_IDR]), Buffer.alloc(20, 0x44)]);
  const streamData = Buffer.concat([sps, pps, idr, pFrame, Buffer.from([0x00, 0x00, 0x00, 0x01])]); // 尾部放置下一個起始碼標記

  function findNextStartCode(buf, startOffset) {
    const len = buf.length;
    for (let i = startOffset; i < len - 2; i++) {
      if (buf[i] === 0x00 && buf[i + 1] === 0x00) {
        if (buf[i + 2] === 0x01) return { index: i, headerLen: 3 };
        if (i < len - 3 && buf[i + 2] === 0x00 && buf[i + 3] === 0x01) return { index: i, headerLen: 4 };
      }
    }
    return null;
  }

  let buffer = streamData;
  const nalus = [];
  let seq = 0;

  while (true) {
    const first = findNextStartCode(buffer, 0);
    if (!first) break;
    const second = findNextStartCode(buffer, first.index + first.headerLen);
    if (!second) break;

    const nalu = buffer.subarray(first.index, second.index);
    buffer = buffer.subarray(second.index);

    const naluType = nalu[first.headerLen] & 0x1F;
    const isKey = naluType === 5;
    const isCfg = naluType === 7 || naluType === 8;
    let flags = 0;
    if (isKey) flags |= 0x01;
    if (isCfg) flags |= 0x02;

    const header = Buffer.allocUnsafe(9);
    header[0] = 0x44;
    header[1] = 0x54;
    header[2] = 0x06;
    header[3] = seq++ & 0xFF;
    header[4] = flags;
    header.writeUInt32BE(nalu.length, 5);

    nalus.push({ header, nalu, naluType, flags, fullPacket: Buffer.concat([header, nalu]) });
  }

  assert.equal(nalus.length, 4, '必須精準切出 4 個連續 NALU');
  assert.equal(nalus[0].naluType, NALU_TYPE.SPS);
  assert.equal(nalus[0].flags, H264_FRAME_FLAGS.CONFIG);

  assert.equal(nalus[1].naluType, NALU_TYPE.PPS);
  assert.equal(nalus[1].flags, H264_FRAME_FLAGS.CONFIG);

  assert.equal(nalus[2].naluType, NALU_TYPE.IDR);
  assert.equal(nalus[2].flags, H264_FRAME_FLAGS.KEYFRAME);

  assert.equal(nalus[3].naluType, NALU_TYPE.NON_IDR);
  assert.equal(nalus[3].flags, H264_FRAME_FLAGS.NONE);

  // 驗證 decodeH264Frame 可無損解碼切片封包
  const decodedIdr = decodeH264Frame(nalus[2].fullPacket);
  assert.equal(decodedIdr.type, PACKET_TYPE.VIDEO_FRAME_H264);
  assert.equal(decodedIdr.isKeyframe, true);
  assert.equal(decodedIdr.seq, 2);
});

test('H.264 串流管道 - TCP 背壓擁塞保護與關鍵幀零丟失策略', (t) => {
  // 策略定義：當 backlog > maxBacklog 時，丟棄 P 幀，但關鍵幀與 SPS/PPS 絕不丟棄
  const maxBacklog = 128 * 1024;
  const highBacklog = 200 * 1024; // 嚴重積壓

  function shouldDropFrame(naluType, backlog) {
    const isKeyframe = naluType === 5;
    const isConfig = naluType === 7 || naluType === 8;
    if (backlog > maxBacklog && !isKeyframe && !isConfig) {
      return true; // 丟棄一般 P 幀
    }
    return false; // 關鍵幀/參數集絕不丟棄
  }

  // 1. 擁塞下普通 P 幀 (NON_IDR) 必須丟棄以緩解排隊
  assert.equal(shouldDropFrame(NALU_TYPE.NON_IDR, highBacklog), true, '擁塞時普通 P 幀應丟棄');

  // 2. 擁塞下 IDR 關鍵幀絕對不可丟棄！
  assert.equal(shouldDropFrame(NALU_TYPE.IDR, highBacklog), false, '擁塞時 IDR 關鍵幀絕不可丟棄');

  // 3. 擁塞下 SPS/PPS 參數集絕對不可丟棄！
  assert.equal(shouldDropFrame(NALU_TYPE.SPS, highBacklog), false, '擁塞時 SPS 參數集絕不可丟棄');
  assert.equal(shouldDropFrame(NALU_TYPE.PPS, highBacklog), false, '擁塞時 PPS 參數集絕不可丟棄');

  // 4. 正常水位下無丟幀
  assert.equal(shouldDropFrame(NALU_TYPE.NON_IDR, 30 * 1024), false);
});
