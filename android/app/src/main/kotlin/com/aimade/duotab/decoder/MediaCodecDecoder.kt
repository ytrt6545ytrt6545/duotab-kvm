package com.aimade.duotab.decoder

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.view.Surface
import java.nio.ByteBuffer

/**
 * DuoTab-KVM Android 原生 MediaCodec 超低延遲硬體解碼器
 * 直連 Surface 達成 GPU 零拷貝即時渲染 (Zero-Copy Direct Rendering)
 */
class MediaCodecDecoder(
    private val surface: Surface,
    private val callback: Callback
) {
    interface Callback {
        fun onFirstFrameRendered()
        fun onRequestKeyframe()
        fun onVideoFormatChanged(width: Int, height: Int) {}
        fun onDecodeError(exception: Exception)
    }

    val isReady: Boolean get() = isConfigured && codec != null

    private var codec: MediaCodec? = null
    private var isConfigured = false
    private var hasRenderedFirstFrame = false
    private val mimeType = "video/avc" // H.264

    /**
     * 以指定解析度初始化硬體解碼器與 Surface 綁定
     */
    fun initialize(width: Int = 1920, height: Int = 1080) {
        try {
            val format = MediaFormat.createVideoFormat(mimeType, width, height).apply {
                // 啟用 Android 11+ 原生低延遲解碼模式
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
                }
                // 最高即時調度優先級
                setInteger(MediaFormat.KEY_PRIORITY, 0)
                setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 2 * 1024 * 1024)
            }

            codec = MediaCodec.createDecoderByType(mimeType).apply {
                configure(format, surface, null, 0)
                start()
            }
            isConfigured = true
        } catch (e: Exception) {
            callback.onDecodeError(e)
        }
    }

    /**
     * 餵入 H.264 二進制資料包
     * @param data NALU 數據（若缺少 Annex-B 起始碼自動補齊 00 00 00 01）
     * @param isConfig 是否為 SPS/PPS 配置參數集
     * @param isKeyframe 是否為 IDR 關鍵幀
     */
    fun feedNalu(data: ByteArray, isConfig: Boolean = false, isKeyframe: Boolean = false) {
        val currentCodec = codec ?: return
        if (!isConfigured) return

        // 防禦性檢查：確保 Annex-B 4-Byte 起始碼完整
        val payload = if (data.size >= 4 && data[0] == 0.toByte() && data[1] == 0.toByte() && (data[2] == 1.toByte() || (data[2] == 0.toByte() && data[3] == 1.toByte()))) {
            data
        } else {
            val withStartCode = ByteArray(4 + data.size)
            withStartCode[0] = 0x00
            withStartCode[1] = 0x00
            withStartCode[2] = 0x00
            withStartCode[3] = 0x01
            System.arraycopy(data, 0, withStartCode, 4, data.size)
            withStartCode
        }

        try {
            val inputIndex = currentCodec.dequeueInputBuffer(1000) // 1ms 極速逾時，絕不阻塞 Socket 接收線程
            if (inputIndex >= 0) {
                val inputBuffer: ByteBuffer? = currentCodec.getInputBuffer(inputIndex)
                if (inputBuffer != null && inputBuffer.capacity() >= payload.size) {
                    inputBuffer.clear()
                    inputBuffer.put(payload)

                    var flags = 0
                    if (isConfig) {
                        flags = flags or MediaCodec.BUFFER_FLAG_CODEC_CONFIG
                    }
                    if (isKeyframe) {
                        flags = flags or MediaCodec.BUFFER_FLAG_KEY_FRAME
                    }

                    // 低延遲即時遠端桌面規範：PTS 固定設為 0，通知底層 Surface 立即無延遲呈現
                    currentCodec.queueInputBuffer(inputIndex, 0, payload.size, 0L, flags)
                } else if (inputBuffer != null) {
                    // 緩衝區容量不足，安全略過並請求關鍵幀自癒
                    callback.onRequestKeyframe()
                }
            }

            // 汲取已解碼幀並直接渲染至 Surface
            drainOutput(currentCodec)
        } catch (e: Exception) {
            callback.onDecodeError(e)
            callback.onRequestKeyframe()
        }
    }

    private fun drainOutput(currentCodec: MediaCodec) {
        val bufferInfo = MediaCodec.BufferInfo()
        var outputIndex = currentCodec.dequeueOutputBuffer(bufferInfo, 0)
        val availableIndices = ArrayList<Int>()

        while (outputIndex >= 0 || outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
            if (outputIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                val newFormat = currentCodec.outputFormat
                val w = if (newFormat.containsKey(MediaFormat.KEY_WIDTH)) newFormat.getInteger(MediaFormat.KEY_WIDTH) else 0
                val h = if (newFormat.containsKey(MediaFormat.KEY_HEIGHT)) newFormat.getInteger(MediaFormat.KEY_HEIGHT) else 0
                if (w > 0 && h > 0) {
                    callback.onVideoFormatChanged(w, h)
                }
            } else if (outputIndex >= 0) {
                availableIndices.add(outputIndex)
            }
            outputIndex = currentCodec.dequeueOutputBuffer(bufferInfo, 0)
        }

        if (availableIndices.isNotEmpty()) {
            val total = availableIndices.size
            if (total <= 2) {
                // 正常低延遲串流：所有就緒影格依序渲染，保證 60fps 絲滑連貫，杜絕跳幀鈍感與閃爍
                for (idx in availableIndices) {
                    currentCodec.releaseOutputBuffer(idx, true)
                }
            } else {
                // 嚴重突發積壓 (> 2 幀)：僅拋棄最舊的過期幀追幀，最新幀一律渲染
                val lastIdx = total - 1
                for (i in 0 until lastIdx - 1) {
                    currentCodec.releaseOutputBuffer(availableIndices[i], false)
                }
                for (i in (lastIdx - 1)..lastIdx) {
                    currentCodec.releaseOutputBuffer(availableIndices[i], true)
                }
            }

            if (!hasRenderedFirstFrame) {
                hasRenderedFirstFrame = true
                callback.onFirstFrameRendered()
            }
        }
    }

    /**
     * 刷新解碼器管道（在收到全新 IDR 關鍵幀或丟包自癒時調用）
     */
    fun flush() {
        try {
            codec?.flush()
        } catch (e: Exception) {
            callback.onDecodeError(e)
        }
    }

    /**
     * 釋放硬體解碼器與資源
     */
    fun release() {
        try {
            isConfigured = false
            codec?.stop()
            codec?.release()
            codec = null
        } catch (e: Exception) {
            // 忽略釋放期異常
        }
    }
}
