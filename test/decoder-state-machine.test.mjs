import test from 'node:test';
import assert from 'node:assert/strict';
import { DecoderStateMachine } from '../protocol/decoder-state-machine.mjs';
import { NALU_TYPE, DECODER_STATE } from '../protocol/constants.mjs';

function makeNalu(type, payloadLength = 10, useThreeByteStart = false) {
  const startCode = useThreeByteStart ? Buffer.from([0x00, 0x00, 0x01]) : Buffer.from([0x00, 0x00, 0x00, 0x01]);
  const header = Buffer.from([type & 0x1F]);
  const payload = Buffer.alloc(payloadLength, 0xAA);
  return Buffer.concat([startCode, header, payload]);
}

test('DecoderStateMachine - Annex-B NALU 解析器 (3-Byte 與 4-Byte 起始碼)', (t) => {
  const machine = new DecoderStateMachine({ displayId: 1 });

  // 構造包含 SPS(7) + PPS(8) + IDR(5) 的複合封包
  const sps = makeNalu(NALU_TYPE.SPS, 12, false); // 4-byte start
  const pps = makeNalu(NALU_TYPE.PPS, 8, true);   // 3-byte start
  const idr = makeNalu(NALU_TYPE.IDR, 30, false); // 4-byte start
  const compound = Buffer.concat([sps, pps, idr]);

  const nalus = machine.parseNalus(compound);
  assert.equal(nalus.length, 3);
  assert.equal(nalus[0].type, NALU_TYPE.SPS);
  assert.equal(nalus[1].type, NALU_TYPE.PPS);
  assert.equal(nalus[2].type, NALU_TYPE.IDR);
});

test('DecoderStateMachine - 狀態機生命週期 (SPS/PPS 捕獲 -> IDR 門禁 -> 正常串流)', (t) => {
  const machine = new DecoderStateMachine({ displayId: 0 });
  assert.equal(machine.state, DECODER_STATE.UNINITIALIZED);

  // 1. 僅收到普通 P 幀 (Non-IDR) -> 尚未初始化，不可渲染
  const pFrame = makeNalu(NALU_TYPE.NON_IDR, 20);
  let res = machine.feedPacket(pFrame, 0);
  assert.equal(res.state, DECODER_STATE.UNINITIALIZED);
  assert.equal(res.renderable, false, '未收到參數集前絕不可渲染');

  // 2. 收到 SPS + PPS -> 進入 WAITING_FOR_IDR
  const configPacket = Buffer.concat([makeNalu(NALU_TYPE.SPS, 15), makeNalu(NALU_TYPE.PPS, 10)]);
  res = machine.feedPacket(configPacket, 1);
  assert.equal(res.state, DECODER_STATE.WAITING_FOR_IDR);
  assert.equal(res.renderable, false);
  assert.equal(res.requestKeyframe, true, '已收齊參數集，必須主動請求首幀 IDR');

  // 3. 在 WAITING_FOR_IDR 期間收到 P 幀 -> 依舊不可渲染 (防綠屏)
  res = machine.feedPacket(pFrame, 2);
  assert.equal(res.state, DECODER_STATE.WAITING_FOR_IDR);
  assert.equal(res.renderable, false);

  // 4. 首幀 IDR 關鍵幀抵達 -> 進入 ACTIVE_STREAMING 且可渲染
  const idrPacket = makeNalu(NALU_TYPE.IDR, 50);
  res = machine.feedPacket(idrPacket, 3);
  assert.equal(res.state, DECODER_STATE.ACTIVE_STREAMING);
  assert.equal(res.renderable, true, '首幀 IDR 抵達必須觸發可渲染');
  assert.equal(machine.decodedFrameCount, 1);

  // 5. 隨後的 P 幀抵達 -> 正常解碼渲染
  res = machine.feedPacket(pFrame, 4);
  assert.equal(res.state, DECODER_STATE.ACTIVE_STREAMING);
  assert.equal(res.renderable, true);
  assert.equal(machine.decodedFrameCount, 2);
});

test('DecoderStateMachine - 丟包異常自癒與 IDR 重傳門禁 (防馬賽克花屏)', (t) => {
  const machine = new DecoderStateMachine({ displayId: 1 });

  // 初始化並進入正常串流
  const initPacket = Buffer.concat([
    makeNalu(NALU_TYPE.SPS, 10),
    makeNalu(NALU_TYPE.PPS, 8),
    makeNalu(NALU_TYPE.IDR, 40)
  ]);
  machine.feedPacket(initPacket, 10);
  assert.equal(machine.state, DECODER_STATE.ACTIVE_STREAMING);

  // 正常接收 seq 11
  const pFrame = makeNalu(NALU_TYPE.NON_IDR, 20);
  machine.feedPacket(pFrame, 11);

  // 模擬嚴重網路丟包：seq 從 11 直接跳到 15 (丟了 12, 13, 14)，時間為 t0
  const t0 = 1000;
  const lostPacket = machine.feedPacket(pFrame, 15, t0);
  console.log(`[Test] 丟包自癒狀態: ${lostPacket.state}, RequestKeyframe=${lostPacket.requestKeyframe}`);
  assert.equal(lostPacket.state, DECODER_STATE.ERROR_RECOVERY);
  assert.equal(lostPacket.requestKeyframe, true, '跳號丟包時必須立即要求 PC 端重傳 IDR');
  assert.equal(lostPacket.renderable, false, '丟失參考幀時絕不可渲染損壞的 P 幀');

  // 在 50ms 內收到後續幀 (seq 16, t0 + 50ms) -> 在 250ms 冷卻窗口內，禁止重複發送請求！
  const dropResInCooldown = machine.feedPacket(pFrame, 16, t0 + 50);
  assert.equal(dropResInCooldown.state, DECODER_STATE.ERROR_RECOVERY);
  assert.equal(dropResInCooldown.renderable, false);
  assert.equal(dropResInCooldown.requestKeyframe, false, '冷卻窗口內嚴禁觸發重複 IDR 請求風暴！');

  // 若經過 300ms (t0 + 300ms) 仍未收到 IDR -> 允許再次重試發起 IDR 請求
  const retryRequest = machine.feedPacket(pFrame, 17, t0 + 300);
  assert.equal(retryRequest.requestKeyframe, true, '超過冷卻窗口且仍未恢復時，允許發起第二次 IDR 重傳！');

  // PC 端收到重傳請求，發送全新 IDR 關鍵幀 (seq 18)
  const recoveryIdr = makeNalu(NALU_TYPE.IDR, 60);
  const recovered = machine.feedPacket(recoveryIdr, 18, t0 + 320);
  console.log(`[Test] 重傳 IDR 抵達自癒: ${recovered.state}, Renderable=${recovered.renderable}`);
  assert.equal(recovered.state, DECODER_STATE.ACTIVE_STREAMING);
  assert.equal(recovered.renderable, true, '重傳關鍵幀抵達後解除異常恢復正常串流');
});

test('DecoderStateMachine - 底層解碼報錯主動自癒', (t) => {
  const machine = new DecoderStateMachine({ displayId: 0 });
  const errorAction = machine.notifyDecodeError();
  assert.equal(errorAction.state, DECODER_STATE.ERROR_RECOVERY);
  assert.equal(errorAction.requestKeyframe, true);
});
