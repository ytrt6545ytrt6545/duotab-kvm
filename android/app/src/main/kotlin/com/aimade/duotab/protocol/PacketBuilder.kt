package com.aimade.duotab.protocol

import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * DuoTab-KVM Android 端二進制封包構造器
 * 嚴格遵循網絡字節序 (Big-Endian)，與 PC 端二進制協議 100% 對齊
 */
object PacketBuilder {
    const val PACKET_MOUSE_MOVE: Byte = 0x01 // 8 Bytes
    const val PACKET_KEY_ACTION: Byte = 0x02 // 6 Bytes
    const val PACKET_HEARTBEAT: Byte = 0x03  // 8 Bytes

    /**
     * 構建 8-Byte 滑鼠相對運動封包
     * [type:1B][dx:int16BE][dy:int16BE][wheel:int8][buttons:uint8][seq:uint8]
     */
    fun buildMouseMove(dx: Int, dy: Int, wheel: Int, buttons: Int, seq: Int): ByteArray {
        val buf = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
        buf.put(PACKET_MOUSE_MOVE)
        buf.putShort(clampShort(dx))
        buf.putShort(clampShort(dy))
        buf.put(clampByte(wheel))
        buf.put((buttons and 0xFF).toByte())
        buf.put((seq and 0xFF).toByte())
        return buf.array()
    }

    /**
     * 構建 6-Byte 鍵盤動作封包
     * [type:1B][action:uint8][vkCode:uint16BE][modifiers:uint8][seq:uint8]
     */
    fun buildKeyAction(action: Int, vkCode: Int, modifiers: Int, seq: Int): ByteArray {
        val buf = ByteBuffer.allocate(6).order(ByteOrder.BIG_ENDIAN)
        buf.put(PACKET_KEY_ACTION)
        buf.put((action and 0xFF).toByte())
        buf.putShort((vkCode and 0xFFFF).toShort())
        buf.put((modifiers and 0xFF).toByte())
        buf.put((seq and 0xFF).toByte())
        return buf.array()
    }

    /**
     * 構建 8-Byte 心跳租約封包
     * [type:1B][role:uint8][leaseMs:uint16BE][timestamp:uint32BE]
     */
    fun buildHeartbeat(role: Int, leaseMs: Int, timestamp: Long): ByteArray {
        val buf = ByteBuffer.allocate(8).order(ByteOrder.BIG_ENDIAN)
        buf.put(PACKET_HEARTBEAT)
        buf.put((role and 0xFF).toByte())
        buf.putShort((leaseMs and 0xFFFF).toShort())
        buf.putInt((timestamp and 0xFFFFFFFFL).toInt())
        return buf.array()
    }

    private fun clampShort(v: Int): Short {
        return when {
            v > Short.MAX_VALUE -> Short.MAX_VALUE
            v < Short.MIN_VALUE -> Short.MIN_VALUE
            else -> v.toShort()
        }
    }

    private fun clampByte(v: Int): Byte {
        return when {
            v > Byte.MAX_VALUE -> Byte.MAX_VALUE
            v < Byte.MIN_VALUE -> Byte.MIN_VALUE
            else -> v.toByte()
        }
    }
}
