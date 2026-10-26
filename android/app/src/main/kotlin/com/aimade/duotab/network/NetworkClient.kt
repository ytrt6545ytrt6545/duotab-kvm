package com.aimade.duotab.network

import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * DuoTab-KVM Android 端雙通道網路客戶端
 * 整合 mDNS UDP 自動尋標、TCP 控制通道與 UDP 極低延遲輸入發送
 */
class NetworkClient(
    @Volatile private var role: Byte, // 0x01: CONSOLE, 0x02: DISPLAY
    private val callback: Callback
) {
    data class ServerInfo(
        val hostId: String,
        val hostname: String,
        val ip: String,
        val tcpPort: Int = 5858,
        val videoPort: Int = 5859,
        val udpPort: Int = 5858
    )

    interface Callback {
        fun onServerFound(server: ServerInfo)
        fun onConnected()
        fun onDisconnected()
        fun onVideoData(data: ByteArray)
        fun onH264Frame(naluData: ByteArray, seq: Int, flags: Int, isKeyframe: Boolean, isConfig: Boolean) {}
        fun onError(e: Exception)
    }

    @Volatile
    private var executor: ExecutorService = Executors.newCachedThreadPool()
    private val mainHandler = Handler(Looper.getMainLooper())

    private var tcpSocket: Socket? = null
    private var videoSocket: Socket? = null // 獨立專屬視訊通道 Socket
    private var udpSocket: DatagramSocket? = null
    private var serverIp: String? = null
    private var serverUdpPort: Int = 5858

    @Volatile
    private var isRunning = false

    @Volatile
    private var cachedServerAddress: InetAddress? = null

    // 專屬高優先級低延遲輸入發送隊列
    private val inputQueue = java.util.concurrent.LinkedBlockingQueue<DatagramPacket>(120)
    @Volatile
    private var isInputSenderRunning = false
    @Volatile
    private var tcpOutputStream: java.io.OutputStream? = null

    // 弱網自癒看門狗 (Instant IDR Watchdog) 狀態追蹤
    @Volatile
    private var lastVideoSeq = -1
    @Volatile
    private var lastIdrRequestTime = 0L

    /**
     * 弱網自癒看門狗 (Instant IDR Watchdog)：檢測 H.264 序號連續性，偵測丟包跳躍瞬時請求 IDR 關鍵幀
     */
    private fun checkH264SeqAndAutoHeal(seq: Int, isKeyframe: Boolean, isConfig: Boolean) {
        if (isKeyframe || isConfig) {
            lastVideoSeq = seq
            return
        }
        val prev = lastVideoSeq
        if (prev != -1) {
            val expected = (prev + 1) and 0xFF
            if (seq != expected) {
                val now = System.currentTimeMillis()
                if (now - lastIdrRequestTime >= 150) { // 150ms 節流防風暴
                    lastIdrRequestTime = now
                    requestKeyframe(if (role == 0x02.toByte()) 1 else 0)
                }
            }
        }
        lastVideoSeq = seq
    }

    /**
     * 自癒式線程池巡檢：確保 executor 永遠健康可用，物理杜絕 RejectedExecutionException
     */
    @Synchronized
    private fun getSafeExecutor(): ExecutorService {
        if (executor.isShutdown || executor.isTerminated) {
            executor = Executors.newCachedThreadPool()
        }
        return executor
    }

    /**
     * 發起局域網自動尋標 (mDNS UDP Broadcast，解析主機 ID 與雙通道埠)
     */
    fun startDiscovery(discoveryPort: Int = 5857) {
        try {
            getSafeExecutor().execute {
                try {
                    val socket = DatagramSocket()
                    socket.broadcast = true
                    socket.soTimeout = 3000

                    val probeMsg = "DUOTAB_DISCOVERY_PROBE".toByteArray(Charsets.UTF_8)
                    val broadcastAddr = InetAddress.getByName("255.255.255.255")
                    val probePacket = DatagramPacket(probeMsg, probeMsg.size, broadcastAddr, discoveryPort)

                    // 發送探測包
                    socket.send(probePacket)

                    // 等待主機回應
                    val rxBuf = ByteArray(1024)
                    val rxPacket = DatagramPacket(rxBuf, rxBuf.size)
                    socket.receive(rxPacket)

                    val responseJson = String(rxPacket.data, 0, rxPacket.length, Charsets.UTF_8)
                    val obj = JSONObject(responseJson)

                    if (obj.optString("magic") == "DUOTAB_DISCOVERY_ANNOUNCE") {
                        val host = rxPacket.address.hostAddress ?: "127.0.0.1"
                        val tcpPort = obj.optInt("tcpPort", 5858)
                        val videoPort = obj.optInt("videoPort", 5859)
                        val udpPort = obj.optInt("udpPort", 5858)
                        val hostname = obj.optString("hostname", "DuoTab-Host")
                        val hostId = obj.optString("hostId", "duotab-$host")

                        serverIp = host
                        serverUdpPort = udpPort

                        val sInfo = ServerInfo(hostId, hostname, host, tcpPort, videoPort, udpPort)
                        mainHandler.post {
                            callback.onServerFound(sInfo)
                        }
                    }
                    socket.close()
                } catch (e: Exception) {
                    mainHandler.post { callback.onError(e) }
                }
            }
        } catch (e: Exception) {
            mainHandler.post { callback.onError(e) }
        }
    }

    @Volatile
    private var connectionGeneration: Long = 0L

    @Volatile
    private var currentQualityTier: Int = 2 // 預設 2: 中畫質 (720p, 3.5Mbps, 60fps 最佳平衡)

    private fun closeSocketsQuietly() {
        try { tcpSocket?.close() } catch (e: Exception) {}
        try { videoSocket?.close() } catch (e: Exception) {}
        try { udpSocket?.close() } catch (e: Exception) {}
        tcpSocket = null
        videoSocket = null
        udpSocket = null
        tcpOutputStream = null
    }

    fun connect(server: ServerInfo) {
        connect(server.ip, server.tcpPort, server.udpPort, server.videoPort)
    }

    /**
     * 連線至 PC 主控端 (三網解耦架構：控制信令 + 獨立視訊 + 鍵鼠輸入)
     */
    fun connect(host: String, tcpPort: Int = 5858, udpPort: Int = 5858, videoPort: Int = 5859) {
        serverIp = host
        serverUdpPort = udpPort

        val currentGen = synchronized(this) {
            closeSocketsQuietly()
            isRunning = true
            ++connectionGeneration
        }

        try {
            getSafeExecutor().execute {
                try {
                    cachedServerAddress = InetAddress.getByName(host)
                    val localUdpSocket = DatagramSocket()
                    val localTcpSocket = Socket(host, tcpPort).apply {
                        tcpNoDelay = true // 啟用 TCP_NODELAY 關閉 Nagle 緩衝，達成 < 0.5ms 零延遲直發
                    }
                    val localTcpOut = localTcpSocket.getOutputStream()

                    synchronized(this) {
                        if (currentGen != connectionGeneration) {
                            try { localTcpSocket.close() } catch (e: Exception) {}
                            try { localUdpSocket.close() } catch (e: Exception) {}
                            return@execute
                        }
                        udpSocket = localUdpSocket
                        tcpSocket = localTcpSocket
                        tcpOutputStream = localTcpOut
                    }

                    mainHandler.post { callback.onConnected() }

                    // 1. 優先同步啟動獨立視訊接收通道 (Port 5859)
                    startDedicatedVideoChannel(host, videoPort, currentGen)

                    // 2. 啟動專屬超低延遲輸入發送循環與租約心跳
                    startInputSenderLoop(localUdpSocket)
                    startTcpInputSenderLoop(localTcpOut)
                    startHeartbeatLoop(localTcpSocket, currentGen)

                    // 3. 通知上層連線就緒並向 PC 同步最新畫質設定與角色
                    sendStreamControl(if (role == 0x02.toByte()) 1 else 0, 0x00.toByte(), currentQualityTier)

                    // 4. 控制通道接收循環 (處理心跳 ACK，並安全消耗任何過渡期混流視訊封包，杜絕協定錯位)
                    val inputStream = localTcpSocket.getInputStream()
                    val dis = java.io.DataInputStream(java.io.BufferedInputStream(inputStream, 16 * 1024))
                    var frameBuffer = ByteArray(512 * 1024)
                    var state = 0

                    while (isRunning && currentGen == connectionGeneration && !localTcpSocket.isClosed) {
                        val b = dis.readUnsignedByte()
                        if (b == 0x06) {
                            // 伺服器 ACK 心跳響應，直接保活
                            continue
                        }
                        // 協定狀態機解析視訊封包 (無論獨立視訊是否連上，控制通道若收到視訊都必須乾淨讀出消耗)
                        if (state == 0) {
                            if (b == 0x44) state = 1
                        } else if (state == 1) {
                            if (b == 0x54) {
                                state = 0
                                val frameType = dis.readUnsignedByte()
                                if (frameType == 0x06) {
                                    // H.264 9-Byte Header: [0x44, 0x54, 0x06, seq:1B, flags:1B, len:4B uint32BE]
                                    val seq = dis.readUnsignedByte()
                                    val flags = dis.readUnsignedByte()
                                    val frameLen = dis.readInt()
                                    if (frameLen in 1..10485760) {
                                        if (frameBuffer.size < frameLen) {
                                            frameBuffer = ByteArray(frameLen + 65536)
                                        }
                                        dis.readFully(frameBuffer, 0, frameLen)
                                        // 僅在獨立通道尚未就緒時作為 fallback 餵給解碼器；若獨立通道已就緒則安全消耗拋棄
                                        val curVidSocket = videoSocket
                                        if (curVidSocket == null || curVidSocket.isClosed) {
                                            val frameData = frameBuffer.copyOf(frameLen)
                                            val isKeyframe = (flags and 0x01) != 0
                                            val isConfig = (flags and 0x02) != 0
                                            checkH264SeqAndAutoHeal(seq, isKeyframe, isConfig)
                                            callback.onH264Frame(frameData, seq, flags, isKeyframe, isConfig)
                                        }
                                    }
                                } else {
                                    // 舊版 7-Byte Header: [0x44, 0x54, type:1B, len:4B uint32BE]
                                    val frameLen = dis.readInt()
                                    if (frameLen in 1..10485760) {
                                        if (frameBuffer.size < frameLen) {
                                            frameBuffer = ByteArray(frameLen + 65536)
                                        }
                                        dis.readFully(frameBuffer, 0, frameLen)
                                        val curVidSocket = videoSocket
                                        if (curVidSocket == null || curVidSocket.isClosed) {
                                            val frameData = frameBuffer.copyOf(frameLen)
                                            callback.onVideoData(frameData)
                                        }
                                    }
                                }
                            } else if (b == 0x44) {
                                state = 1
                            } else {
                                state = 0
                            }
                        }
                    }
                } catch (e: Throwable) {
                    if (isRunning && currentGen == connectionGeneration) {
                        val ex = if (e is Exception) e else Exception(e.message, e)
                        mainHandler.post { callback.onError(ex) }
                    }
                } finally {
                    synchronized(this) {
                        if (currentGen == connectionGeneration) {
                            disconnect()
                        }
                    }
                }
            }
        } catch (e: Throwable) {
            val ex = if (e is Exception) e else Exception(e.message, e)
            mainHandler.post { callback.onError(ex) }
        }
    }

    /**
     * 專屬獨立視訊串流接收通道 (Port 5859，完全脫離控制通道，物理杜絕隊頭阻塞)
     */
    private fun startDedicatedVideoChannel(host: String, videoPort: Int, currentGen: Long) {
        getSafeExecutor().execute {
            try {
                val localVideoSocket = Socket(host, videoPort).apply {
                    tcpNoDelay = true
                }
                synchronized(this) {
                    if (currentGen != connectionGeneration) {
                        try { localVideoSocket.close() } catch (e: Exception) {}
                        return@execute
                    }
                    videoSocket = localVideoSocket
                }

                val inputStream = localVideoSocket.getInputStream()
                val dis = java.io.DataInputStream(java.io.BufferedInputStream(inputStream, 4 * 1024))
                var frameBuffer = ByteArray(512 * 1024)
                var state = 0

                while (isRunning && currentGen == connectionGeneration && !localVideoSocket.isClosed) {
                    val b = dis.readUnsignedByte()
                    if (state == 0) {
                        if (b == 0x44) state = 1
                    } else if (state == 1) {
                        if (b == 0x54) {
                            state = 0
                            val frameType = dis.readUnsignedByte()
                            if (frameType == 0x06) {
                                // H.264 9-Byte Header: [0x44, 0x54, 0x06, seq:1B, flags:1B, len:4B uint32BE]
                                val seq = dis.readUnsignedByte()
                                val flags = dis.readUnsignedByte()
                                val frameLen = dis.readInt()
                                if (frameLen in 1..10485760) {
                                    if (frameBuffer.size < frameLen) {
                                        frameBuffer = ByteArray(frameLen + 65536)
                                    }
                                    dis.readFully(frameBuffer, 0, frameLen)
                                    val frameData = frameBuffer.copyOf(frameLen)
                                    val isKeyframe = (flags and 0x01) != 0
                                    val isConfig = (flags and 0x02) != 0
                                    checkH264SeqAndAutoHeal(seq, isKeyframe, isConfig)
                                    callback.onH264Frame(frameData, seq, flags, isKeyframe, isConfig)
                                }
                            } else {
                                // 舊版 7-Byte Header: [0x44, 0x54, type:1B, len:4B uint32BE]
                                val frameLen = dis.readInt()
                                if (frameLen in 1..10485760) {
                                    if (frameBuffer.size < frameLen) {
                                        frameBuffer = ByteArray(frameLen + 65536)
                                    }
                                    dis.readFully(frameBuffer, 0, frameLen)
                                    val frameData = frameBuffer.copyOf(frameLen)
                                    callback.onVideoData(frameData)
                                }
                            }
                        } else if (b == 0x44) {
                            state = 1
                        } else {
                            state = 0
                        }
                    }
                }
            } catch (e: Exception) {
                // 獨立視訊通道若遇暫態網路抖動，僅關閉視訊通道，絕不中斷控制生命線！
                try { videoSocket?.close() } catch (ex: Exception) {}
                videoSocket = null
            }
        }
    }

    private val tcpWriteLock = Any()

    private fun startHeartbeatLoop(socket: Socket, currentGen: Long) {
        try {
            getSafeExecutor().execute {
                val outputStream = socket.getOutputStream()
                val hbBuf = ByteArray(8)
                hbBuf[0] = 0x03 // HEARTBEAT
                hbBuf[1] = role // 角色 (Console / Display)
                // 租約 1500ms (Big-Endian)
                hbBuf[2] = 0x05
                hbBuf[3] = 0xDC.toByte()

                while (isRunning && currentGen == connectionGeneration && !socket.isClosed) {
                    try {
                        hbBuf[1] = role // 動態讀取最新角色 (Console / Display)
                        val now = System.currentTimeMillis()
                        hbBuf[4] = ((now shr 24) and 0xFF).toByte()
                        hbBuf[5] = ((now shr 16) and 0xFF).toByte()
                        hbBuf[6] = ((now shr 8) and 0xFF).toByte()
                        hbBuf[7] = (now and 0xFF).toByte()

                        synchronized(tcpWriteLock) {
                            outputStream.write(hbBuf)
                            outputStream.flush()
                        }
                        Thread.sleep(500) // 1/3 租約心跳週期
                    } catch (e: Exception) {
                        break
                    }
                }
            }
        } catch (e: Exception) {}
    }

    /**
     * 透過 UDP 極速發送按鍵或滑鼠封包 (Console 專用)
     * 採用預解析 InetAddress 快取，達成 0 開銷直發
     */
    private fun startInputSenderLoop(socket: DatagramSocket) {
        isInputSenderRunning = true
        getSafeExecutor().execute {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY)
            while (isInputSenderRunning && isRunning && !socket.isClosed) {
                try {
                    val packet = inputQueue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue
                    socket.send(packet)
                } catch (e: Exception) {
                    try { Thread.sleep(10) } catch (te: Exception) {}
                }
            }
        }
    }

    // 專屬 TCP 輸入序列化發送佇列，防止線程暴增與並發交疊
    private val tcpInputQueue = java.util.concurrent.LinkedBlockingQueue<ByteArray>(120)
    @Volatile
    private var isTcpSenderRunning = false

    private fun startTcpInputSenderLoop(out: java.io.OutputStream) {
        isTcpSenderRunning = true
        getSafeExecutor().execute {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_DISPLAY)
            while (isTcpSenderRunning && isRunning) {
                try {
                    val packet = tcpInputQueue.poll(500, java.util.concurrent.TimeUnit.MILLISECONDS) ?: continue
                    synchronized(tcpWriteLock) {
                        out.write(packet)
                        out.flush()
                    }
                } catch (e: Exception) {
                    try { Thread.sleep(10) } catch (te: Exception) {}
                }
            }
        }
    }

    /**
     * 智慧單軌分流發送輸入封包 (Console 專用)
     * 鍵盤封包 (Type 0x02): 嚴格走可靠 TCP，杜絕任何 UDP 雙發踩踏，保證微軟注音單次點擊中英切換！
     * 滑鼠封包 (Type 0x01): 優先走 UDP 達到極速零延遲位移；若 UDP 未就緒則走 TCP。
     */
    fun sendInputPacket(packet: ByteArray) {
        val isKeyboard = packet.isNotEmpty() && packet[0] == 0x02.toByte()

        if (isKeyboard) {
            // 鍵盤事件嚴格僅走可靠 TCP，消滅重複注入與雙發踩踏
            if (isTcpSenderRunning && isRunning) {
                if (!tcpInputQueue.offer(packet)) {
                    tcpInputQueue.poll()
                    tcpInputQueue.offer(packet)
                }
            }
        } else {
            // 滑鼠位移事件優先走 UDP 達到極速零延遲；若 UDP 未連線則 fallback TCP
            val target = cachedServerAddress
            if (target != null && isInputSenderRunning) {
                val dPacket = DatagramPacket(packet, packet.size, target, serverUdpPort)
                if (!inputQueue.offer(dPacket)) {
                    inputQueue.poll() // 滿載時拋棄舊封包，確保最新游標無延遲
                    inputQueue.offer(dPacket)
                }
            } else if (isTcpSenderRunning && isRunning) {
                if (!tcpInputQueue.offer(packet)) {
                    tcpInputQueue.poll()
                    tcpInputQueue.offer(packet)
                }
            }
        }
    }

    /**
     * 發送請求 IDR 關鍵幀控制包
     */
    fun requestKeyframe(displayId: Int = 0) {
        val socket = tcpSocket ?: return
        try {
            getSafeExecutor().execute {
                try {
                    val ctrlBuf = ByteArray(6)
                    ctrlBuf[0] = 0x04 // STREAM_CONTROL
                    ctrlBuf[1] = displayId.toByte()
                    ctrlBuf[2] = 0 // targetBitrate 高字節
                    ctrlBuf[3] = 0 // targetBitrate 低字節
                    ctrlBuf[4] = 24 // fps
                    ctrlBuf[5] = 0x01 // REQUEST_IDR_KEYFRAME
                    synchronized(tcpWriteLock) {
                        socket.getOutputStream().write(ctrlBuf)
                        socket.getOutputStream().flush()
                    }
                } catch (e: Exception) {}
            }
        } catch (e: Exception) {}
    }

    /**
     * 動態切換角色 (Console / Display)，並立即通知伺服器切換推流螢幕
     */
    fun setRole(newRole: Byte) {
        this.role = newRole
        val displayId = if (newRole == 0x02.toByte()) 1 else 0
        sendStreamControl(displayId, 0x00.toByte())
    }

    /**
     * 動態設定畫質 (1: 低畫質 480p, 2: 中畫質 640p, 3: 高畫質 960p, 0: 自動 ABR)
     */
    fun setQuality(tier: Int) {
        this.currentQualityTier = tier
        val displayId = if (role == 0x02.toByte()) 1 else 0
        sendStreamControl(displayId, 0x00.toByte(), tier)
    }

    fun getQualityTier(): Int = currentQualityTier

    /**
     * 暫停串流（省電、省頻寬、完全釋放伺服器負載）
     */
    fun pauseStream() {
        val displayId = if (role == 0x02.toByte()) 1 else 0
        sendStreamControl(displayId, 0x02.toByte(), currentQualityTier) // 0x02: PAUSE_STREAM
    }

    /**
     * 恢復串流
     */
    fun resumeStream() {
        val displayId = if (role == 0x02.toByte()) 1 else 0
        sendStreamControl(displayId, 0x04.toByte(), currentQualityTier) // 0x04: RESUME_STREAM
    }

    /**
     * 發送通用串流控制包 (包含畫質 Tier 參數)
     */
    fun sendStreamControl(displayId: Int, flags: Byte, qualityTier: Int = currentQualityTier) {
        val socket = tcpSocket ?: return
        try {
            getSafeExecutor().execute {
                try {
                    val ctrlBuf = ByteArray(6)
                    ctrlBuf[0] = 0x04 // STREAM_CONTROL
                    ctrlBuf[1] = displayId.toByte()
                    // targetBitrateKbps 高低字節攜帶畫質 Tier (1:低, 2:中, 3:高, 0:自動)
                    ctrlBuf[2] = ((qualityTier shr 8) and 0xFF).toByte()
                    ctrlBuf[3] = (qualityTier and 0xFF).toByte()
                    ctrlBuf[4] = 24 // fps
                    ctrlBuf[5] = flags
                    synchronized(tcpWriteLock) {
                        socket.getOutputStream().write(ctrlBuf)
                        socket.getOutputStream().flush()
                    }
                } catch (e: Exception) {}
            }
        } catch (e: Exception) {}
    }

    /**
     * 暫態斷開連線（保持 executor 存活，以便下一次連線）
     */
    fun disconnect() {
        isRunning = false
        isInputSenderRunning = false
        isTcpSenderRunning = false
        inputQueue.clear()
        tcpInputQueue.clear()
        tcpOutputStream = null
        try { tcpSocket?.close() } catch (e: Exception) {}
        try { videoSocket?.close() } catch (e: Exception) {}
        try { udpSocket?.close() } catch (e: Exception) {}
        tcpSocket = null
        videoSocket = null
        udpSocket = null
        cachedServerAddress = null
        mainHandler.post { callback.onDisconnected() }
    }

    /**
     * 終局徹底銷毀（僅在 Activity.onDestroy 時調用）
     */
    fun destroy() {
        disconnect()
        try { executor.shutdownNow() } catch (e: Exception) {}
    }
}
