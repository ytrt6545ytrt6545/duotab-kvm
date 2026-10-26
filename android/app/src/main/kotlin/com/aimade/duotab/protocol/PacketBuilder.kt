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
    const val PACKET_STREAM_CONTROL: Byte = 0x04 // 6 Bytes
    const val PACKET_VIDEO_FRAME_JPEG: Byte = 0x05 // 舊版 JPEG
    const val PACKET_VIDEO_FRAME_H264: Byte = 0x06 // 9 Bytes Header + NALU: [magic:2B 'DT'][type:1B][seq:1B][flags:1B][len:4B]

    const val STREAM_MAGIC_1: Byte = 0x44 // 'D'
    const val STREAM_MAGIC_2: Byte = 0x54 // 'T'
    const val H264_HEADER_SIZE: Int = 9

    const val FLAG_NONE: Byte = 0x00
    const val FLAG_KEYFRAME: Byte = 0x01
    const val FLAG_CONFIG: Byte = 0x02
    const val FLAG_END_OF_FRAME: Byte = 0x04

    const val NALU_NON_IDR: Byte = 1
    const val NALU_IDR: Byte = 5
    const val NALU_SEI: Byte = 6
    const val NALU_SPS: Byte = 7
    const val NALU_PPS: Byte = 8

    const val STREAM_CTRL_NONE: Byte = 0x00
    const val STREAM_CTRL_REQUEST_IDR: Byte = 0x01
    const val STREAM_CTRL_PAUSE: Byte = 0x02
    const val STREAM_CTRL_RESUME: Byte = 0x04

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

    /**
     * 構建 6-Byte 串流控制封包
     * [type:1B][displayId:uint8][targetBitrateKbps:uint16BE][fps:uint8][flags:uint8]
     */
    fun buildStreamControl(displayId: Int, targetBitrateKbps: Int, fps: Int, flags: Int): ByteArray {
        val buf = ByteBuffer.allocate(6).order(ByteOrder.BIG_ENDIAN)
        buf.put(PACKET_STREAM_CONTROL)
        buf.put((displayId and 0xFF).toByte())
        buf.putShort((targetBitrateKbps and 0xFFFF).toShort())
        buf.put((fps and 0xFF).toByte())
        buf.put((flags and 0xFF).toByte())
        return buf.array()
    }

    /**
     * 構建 H.264 視訊幀封包
     * [magic:2B 'DT'][type:1B 0x06][seq:1B][flags:1B][len:4B uint32BE][payload:NB]
     */
    fun buildH264Frame(naluData: ByteArray, seq: Int = 0, flags: Int = 0): ByteArray {
        val totalLen = H264_HEADER_SIZE + naluData.size
        val buf = ByteBuffer.allocate(totalLen).order(ByteOrder.BIG_ENDIAN)
        buf.put(STREAM_MAGIC_1)
        buf.put(STREAM_MAGIC_2)
        buf.put(PACKET_VIDEO_FRAME_H264)
        buf.put((seq and 0xFF).toByte())
        buf.put((flags and 0xFF).toByte())
        buf.putInt(naluData.size)
        buf.put(naluData)
        return buf.array()
    }

    data class H264Frame(
        val seq: Int,
        val flags: Int,
        val payloadLength: Int,
        val payload: ByteArray,
        val isKeyframe: Boolean,
        val isConfig: Boolean
    )

    /**
     * 解析完整 H.264 封包
     */
    fun parseH264Frame(data: ByteArray): H264Frame? {
        if (data.size < H264_HEADER_SIZE) return null
        val buf = ByteBuffer.wrap(data).order(ByteOrder.BIG_ENDIAN)
        val m1 = buf.get()
        val m2 = buf.get()
        if (m1 != STREAM_MAGIC_1 || m2 != STREAM_MAGIC_2) return null
        val type = buf.get()
        if (type != PACKET_VIDEO_FRAME_H264) return null
        val seq = buf.get().toInt() and 0xFF
        val flags = buf.get().toInt() and 0xFF
        val len = buf.int
        if (len < 0 || data.size < H264_HEADER_SIZE + len) return null

        val payload = ByteArray(len)
        buf.get(payload)

        val isKey = (flags and FLAG_KEYFRAME.toInt()) != 0
        val isCfg = (flags and FLAG_CONFIG.toInt()) != 0

        return H264Frame(
            seq = seq,
            flags = flags,
            payloadLength = len,
            payload = payload,
            isKeyframe = isKey,
            isConfig = isCfg
        )
    }

    /**
     * 構建 6-Byte 串流控制封包
     * [type:1B][displayId:uint8][targetBitrateKbps:uint16BE][fps:uint8][flags:uint8]
     */
    fun buildStreamControl(displayId: Int, targetBitrateKbps: Int = 0, fps: Int = 30, flags: Byte = 0): ByteArray {
        val buf = ByteBuffer.allocate(6).order(ByteOrder.BIG_ENDIAN)
        buf.put(PACKET_STREAM_CONTROL)
        buf.put((displayId and 0xFF).toByte())
        buf.putShort((targetBitrateKbps and 0xFFFF).toShort())
        buf.put((fps and 0xFF).toByte())
        buf.put(flags)
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
