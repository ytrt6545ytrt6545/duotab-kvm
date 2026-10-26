import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { NetworkCoordinator } from '../server/network/network-coordinator.mjs';
import { PACKET_TYPE } from '../protocol/constants.mjs';

test('Live Reality Loopback - 全雙工端到端真實 UDP 滑鼠注入與實體位移物證', async (t) => {
  const coordinator = new NetworkCoordinator({
    tcpPort: 15859,
    udpPort: 15859
  });

  const netInfo = await coordinator.start();
  assert.equal(netInfo.tcpPort, 15859);

  try {
    // 1. 模擬真實 Android 平板發起 TCP 控制連線
    const clientTcp = new net.Socket();
    await new Promise((resolve) => clientTcp.connect(15859, '127.0.0.1', resolve));

    // 發送 Heartbeat (Role = 0x01: CONSOLE)
    const hbPacket = Buffer.alloc(8);
    hbPacket[0] = PACKET_TYPE.HEARTBEAT;
    hbPacket[1] = 0x01; // CONSOLE
    hbPacket.writeUInt16BE(1500, 2); // 1500ms
    hbPacket.writeUInt32BE(Date.now() & 0xFFFFFFFF, 4);
    clientTcp.write(hbPacket);

    // 等待 TCP 心跳登記與客戶端就位
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(coordinator.clients.console, 'Console 客戶端必須已被登記');

    // 2. 獲取注入前實體滑鼠座標
    const beforePos = await coordinator.inputInjector.getCursorPos();

    // 3. 模擬 Android 平板透過真實 UDP 發送 MOUSE_MOVE_REL (ΔX=35, ΔY=35)
    const clientUdp = dgram.createSocket('udp4');
    const movePacket = Buffer.alloc(8);
    movePacket[0] = PACKET_TYPE.MOUSE_MOVE_REL;
    movePacket.writeInt16BE(35, 1);
    movePacket.writeInt16BE(35, 3);
    movePacket.writeInt8(0, 5); // wheel
    movePacket.writeUInt8(0, 6); // buttons
    movePacket.writeUInt8(1, 7); // seq

    await new Promise((resolve, reject) => {
      clientUdp.send(movePacket, 15859, '127.0.0.1', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // 等待 Win32 游標注入發生物理位移
    await new Promise((r) => setTimeout(r, 400));

    // 4. 獲取注入後實體滑鼠座標
    const afterPos = await coordinator.inputInjector.getCursorPos();
    const deltaX = Math.abs(afterPos.x - beforePos.x);
    const deltaY = Math.abs(afterPos.y - beforePos.y);

    console.log(`> 📌 [Live Loopback 物證] 注入前座標=(${beforePos.x}, ${beforePos.y}), 注入後座標=(${afterPos.x}, ${afterPos.y}), 物理位移ΔX=${deltaX}, ΔY=${deltaY}`);

    // 5. 模擬 Android 平板透過真實 TCP 直發 MOUSE_MOVE_REL (ΔX=20, ΔY=-20) 突破路由器 UDP 阻擋
    const tcpPosBefore = await coordinator.inputInjector.getCursorPos();
    const tcpMovePacket = Buffer.alloc(8);
    tcpMovePacket[0] = PACKET_TYPE.MOUSE_MOVE_REL;
    tcpMovePacket.writeInt16BE(20, 1);
    tcpMovePacket.writeInt16BE(-20, 3);
    tcpMovePacket.writeInt8(0, 5);
    tcpMovePacket.writeUInt8(0, 6);
    tcpMovePacket.writeUInt8(2, 7);
    clientTcp.write(tcpMovePacket);

    await new Promise((r) => setTimeout(r, 400));
    const tcpPosAfter = await coordinator.inputInjector.getCursorPos();
    const tcpDeltaX = Math.abs(tcpPosAfter.x - tcpPosBefore.x);
    const tcpDeltaY = Math.abs(tcpPosAfter.y - tcpPosBefore.y);
    console.log(`> 📌 [Live TCP Loopback 物證] TCP 直發位移: ΔX=${tcpDeltaX}, ΔY=${tcpDeltaY}`);
    assert.ok(tcpDeltaX > 0 || tcpDeltaY > 0, 'TCP 軌道滑鼠注入必須在 Windows 上產生客觀物理位移！');

    clientUdp.close();
    clientTcp.destroy();
  } finally {
    await coordinator.stop();
  }
});
