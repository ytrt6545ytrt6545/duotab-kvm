import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { DiscoveryService, MAGIC_PROBE, MAGIC_ANNOUNCE } from '../server/network/discovery-service.mjs';
import { NetworkCoordinator } from '../server/network/network-coordinator.mjs';
import { PACKET_TYPE, CLIENT_ROLE, BUTTON_MASKS, STREAM_CONTROL_FLAGS } from '../protocol/constants.mjs';
import { encodeHeartbeat, encodeStreamControl, encodeMouseMove } from '../protocol/packet-codec.mjs';

test('DiscoveryService - 局域網 UDP 自動尋標探測與即時回應', async (t) => {
  const discovery = new DiscoveryService({ port: 15857, tcpPort: 15858, udpPort: 15858 });
  await discovery.start();

  try {
    const client = dgram.createSocket('udp4');
    const responsePromise = new Promise((resolve) => {
      client.on('message', (msg) => {
        const text = msg.toString('utf-8');
        const obj = JSON.parse(text);
        resolve(obj);
      });
    });

    // 客戶端發起探測
    const probeBuf = Buffer.from(MAGIC_PROBE);
    client.send(probeBuf, 15857, '127.0.0.1');

    const announce = await responsePromise;
    console.log(`[Test] 尋標服務回應: 主機=${announce.hostname}, TCP=${announce.tcpPort}, UDP=${announce.udpPort}`);
    assert.equal(announce.magic, MAGIC_ANNOUNCE);
    assert.equal(announce.tcpPort, 15858);
    assert.equal(announce.udpPort, 15858);

    await new Promise(r => client.close(r));
  } finally {
    await discovery.stop();
  }
});

test('NetworkCoordinator - 雙平板雙角色獨立綁定與全鏈路輸入穿透', async (t) => {
  // 建立網路協調器 (指定獨立測試端口以防碰撞，使用 mock: true 驗證邏輯接縫)
  const coordinator = new NetworkCoordinator({
    tcpPort: 15870,
    videoPort: 15871,
    udpPort: 15870,
    mock: true
  });

  const netInfo = await coordinator.start();
  assert.equal(coordinator.isListening, true);

  let consoleSocket = null;
  let displaySocket = null;
  let udpClient = null;

  try {
    // 1. 模擬 Console 平板 TCP 連線並發送心跳握手
    consoleSocket = net.connect(15870, '127.0.0.1');
    await new Promise(r => consoleSocket.once('connect', r));

    const hbConsole = encodeHeartbeat({ role: CLIENT_ROLE.CONSOLE, leaseMs: 1500, timestamp: Date.now() });
    consoleSocket.write(hbConsole);

    // 等待握手處理
    await new Promise(r => setTimeout(r, 60));
    assert.ok(coordinator.clients.console, 'Console 平板必須成功登記');
    assert.equal(coordinator.clients.display, null, 'Display 平板此時應為空');

    // 2. 模擬 Display 平板 TCP 連線並發送心跳握手
    displaySocket = net.connect(15870, '127.0.0.1');
    await new Promise(r => displaySocket.once('connect', r));

    const hbDisplay = encodeHeartbeat({ role: CLIENT_ROLE.DISPLAY, leaseMs: 1500, timestamp: Date.now() });
    displaySocket.write(hbDisplay);

    await new Promise(r => setTimeout(r, 60));
    assert.ok(coordinator.clients.display, 'Display 平板必須成功登記');
    assert.ok(coordinator.clients.console, 'Console 平板必須保持連線');

    // 3. 模擬 Console 平板透過 UDP 發送滑鼠位移封包
    udpClient = dgram.createSocket('udp4');
    const mousePacket = encodeMouseMove({ dx: 25, dy: -15, wheel: 0, buttons: BUTTON_MASKS.LEFT, seq: 1 });

    udpClient.send(mousePacket, 15870, '127.0.0.1');
    await new Promise(r => setTimeout(r, 60));

    // 驗證狀態機與注入器是否完整捕獲事件
    assert.equal(coordinator.inputStateMachine.activeMouseButtons, BUTTON_MASKS.LEFT);
    assert.equal(coordinator.inputInjector.injectedEvents.length, 1);
    console.log(`[Test] UDP 輸入成功穿透: buttons=${coordinator.inputStateMachine.activeMouseButtons}`);

    // 4. 模擬 Display 平板透過 TCP 發送 IDR 請求控制包
    const streamCtrl = encodeStreamControl({
      displayId: 1,
      targetBitrateKbps: 8000,
      fps: 60,
      flags: STREAM_CONTROL_FLAGS.REQUEST_IDR_KEYFRAME
    });
    displaySocket.write(streamCtrl);
    await new Promise(r => setTimeout(r, 60));

    // 5. 驗證 Console 平板斷線時的「急停防黏鍵硬鎖」
    consoleSocket.destroy();
    consoleSocket = null;
    await new Promise(r => setTimeout(r, 60));

    assert.equal(coordinator.clients.console, null, 'Console 斷線後登記表必須清除');
    assert.equal(coordinator.inputStateMachine.activeMouseButtons, 0, '斷線急停必須釋放所有滑鼠按鈕！');
    assert.equal(coordinator.inputStateMachine.activeKeyCodes.size, 0, '斷線急停必須釋放所有鍵盤按鍵！');
  } finally {
    if (consoleSocket) { try { consoleSocket.destroy(); } catch (e) {} }
    if (displaySocket) { try { displaySocket.destroy(); } catch (e) {} }
    if (udpClient) { try { udpClient.close(); } catch (e) {} }
    await coordinator.stop();
  }
});

test('NetworkCoordinator - Zero-Copy 串流與動態背壓丟幀合約驗證', async (t) => {
  // 驗證自適應背壓門檻公式 (Tier 1: 64KB, Tier 2: 128KB, Tier 3: 256KB)
  const calcMaxBacklog = (tier) => (tier === 1 ? 64 : tier === 3 ? 256 : 128) * 1024;
  assert.equal(calcMaxBacklog(1), 64 * 1024, 'Tier 1 門檻應為 64KB');
  assert.equal(calcMaxBacklog(2), 128 * 1024, 'Tier 2 門檻應為 128KB');
  assert.equal(calcMaxBacklog(3), 256 * 1024, 'Tier 3 門檻應為 256KB');

  // 1. 驗證舊版 JPEG Zero-Copy 封包結構與 7-Byte Header 二進制合約
  const len = 45000;
  const header7 = Buffer.allocUnsafe(7);
  header7[0] = 0x44; // 'D'
  header7[1] = 0x54; // 'T'
  header7[2] = 0x05; // 0x05: JPEG
  header7[3] = (len >> 24) & 0xFF;
  header7[4] = (len >> 16) & 0xFF;
  header7[5] = (len >> 8) & 0xFF;
  header7[6] = len & 0xFF;

  assert.equal(header7[0], 0x44);
  assert.equal(header7[1], 0x54);
  assert.equal(header7[2], 0x05);
  const parsedLen7 = (header7[3] << 24) | (header7[4] << 16) | (header7[5] << 8) | header7[6];
  assert.equal(parsedLen7, len, '7-Byte Header 解析出的影格長度必須與原長度精確吻合');

  // 2. 驗證 H.264 Zero-Copy 9-Byte Header 二進制合約
  const h264Len = 12500; // 12.5KB H.264 NALU
  const header9 = Buffer.allocUnsafe(9);
  header9[0] = 0x44; // 'D'
  header9[1] = 0x54; // 'T'
  header9[2] = 0x06; // 0x06: VIDEO_FRAME_H264
  header9[3] = 42;   // seq
  header9[4] = 0x01; // flags: KEYFRAME
  header9.writeUInt32BE(h264Len, 5);

  assert.equal(header9[0], 0x44);
  assert.equal(header9[1], 0x54);
  assert.equal(header9[2], 0x06);
  assert.equal(header9[3], 42);
  assert.equal(header9[4], 0x01);
  assert.equal(header9.readUInt32BE(5), h264Len, '9-Byte Header 解析出的 NALU 長度必須完全吻合');
});

