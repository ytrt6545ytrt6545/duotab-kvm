package com.aimade.duotab

import android.app.Activity
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.GestureDetector
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import com.aimade.duotab.decoder.MediaCodecDecoder
import com.aimade.duotab.input.RawInputCapture
import com.aimade.duotab.network.NetworkClient

/**
 * DuoTab-KVM 廣播級操作艙 Activity
 * 具備 Cyberpunk 質感之狀態 HUD、手動 IP 連線、OTG 鍵鼠即時反饋與硬體零拷貝解碼
 */
class MainActivity : Activity(), MediaCodecDecoder.Callback, SurfaceHolder.Callback, NetworkClient.Callback {

    private lateinit var inputCapture: RawInputCapture
    private var decoder: MediaCodecDecoder? = null
    private var networkClient: NetworkClient? = null
    private lateinit var surfaceView: SurfaceView

    // UI 元件
    private lateinit var rootLayout: FrameLayout
    private lateinit var standbyOverlay: View
    private lateinit var hudOverlay: LinearLayout
    private lateinit var minimizedCapsule: Button
    private lateinit var statusTextView: TextView
    private lateinit var ipEditText: EditText
    private lateinit var connectButton: Button
    private lateinit var modeButton: Button
    private lateinit var qualityButton: Button
    private lateinit var pauseResumeButton: Button
    private lateinit var captureButton: Button
    private lateinit var debugTextView: TextView
    private lateinit var videoStatsTextView: TextView

    // MediaCodec 硬解零拷貝健康度統計變數
    private var rxFrameCount = 0
    private var rxByteCount = 0L
    private var lastStatsTime = 0L
    private var lastRenderDurationMs = 0L

    private var currentRole: Byte = 0x01 // 0x01: Console, 0x02: Display
    private var currentQualityTier: Int = 2 // 1: 低(480p), 2: 中(720p 推薦預設), 3: 高(1080p 原畫), 0: 自動(ABR)
    private var isConnected = false
    private var isHudVisible = true
    private var isStreamPaused = false
    private var lastBackPressTime = 0L
    private var touchDownX = 0f
    private var touchDownY = 0f
    private var touchDownTimeMs = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // 雙擊手勢監聽器：全螢幕觀看模式下，只要在螢幕任一處「雙擊（Double Tap）」，立即釋放滑鼠獨占並叫出控制艙！
        val gestureDetector = GestureDetector(this, object : GestureDetector.SimpleOnGestureListener() {
            override fun onDoubleTap(e: MotionEvent): Boolean {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    surfaceView.releasePointerCapture()
                }
                toggleHud(true)
                return true
            }
        })

        // 1. 建立底層 SurfaceView
        surfaceView = SurfaceView(this).apply {
            isFocusable = true
            isFocusableInTouchMode = true
            holder.addCallback(this@MainActivity)
            setOnTouchListener { _, event ->
                gestureDetector.onTouchEvent(event)
                false // 允許事件繼續向下傳遞給輸入捕獲器
            }
            setOnClickListener {
                if (!isHudVisible) {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        releasePointerCapture()
                    }
                    toggleHud(true)
                }
            }
        }

        // 2. 建立待機指示層 (獨立 View，嚴禁直接 lockCanvas 污染底層 SurfaceView)
        standbyOverlay = buildStandbyOverlay()

        // 3. 建立根佈局
        rootLayout = FrameLayout(this).apply {
            setBackgroundColor(Color.parseColor("#0F111A"))
            addView(
                surfaceView,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
            addView(
                standbyOverlay,
                FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
            )
        }

        // 3. 建立操作艙 HUD 介面
        buildControlHud()
        rootLayout.addView(hudOverlay)
        rootLayout.addView(minimizedCapsule)

        setContentView(rootLayout)
        hideSystemUI()

        // 4. 初始化網路客戶端與尋標
        networkClient = NetworkClient(currentRole, this).apply {
            startDiscovery() // 局域網自動尋標
        }

        // 5. 初始化鍵鼠捕獲器
        inputCapture = RawInputCapture { packet ->
            networkClient?.sendInputPacket(packet)
            updateDebugMonitor(packet)
        }

        surfaceView.post {
            inputCapture.attach(surfaceView)
        }
    }

    private fun buildControlHud() {
        // 最小化懸浮膠囊 (置中置頂，elevation 100f，點擊即可隨時叫回控制面板並釋放滑鼠)
        minimizedCapsule = Button(this).apply {
            text = "⚡ 點擊叫回控制選單 (雙擊畫面亦可叫出)"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setBackgroundColor(Color.parseColor("#E60284C7")) // 科技藍高亮半透明
            visibility = View.GONE
            setPadding(36, 16, 36, 16)
            elevation = 100f
            val lp = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                setMargins(0, 20, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    surfaceView.releasePointerCapture()
                }
                toggleHud(true)
            }
        }

        // 主控制艙面板 (覆蓋在 SurfaceView 之上)
        hudOverlay = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(Color.parseColor("#E60F172A")) // 深色半透明背景
            setPadding(48, 40, 48, 40)
            val lp = FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                gravity = Gravity.TOP or Gravity.CENTER_HORIZONTAL
                setMargins(48, 32, 48, 0)
            }
            layoutParams = lp
        }

        // 標題列
        val headerLayout = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }

        val titleView = TextView(this).apply {
            text = "⚡ DUOTAB-KVM 操作艙"
            setTextColor(Color.parseColor("#38BDF8")) // 科技藍
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f)
            typeface = Typeface.DEFAULT_BOLD
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        val hideButton = Button(this).apply {
            text = "隱藏選單 ✕"
            setTextColor(Color.parseColor("#94A3B8"))
            setBackgroundColor(Color.TRANSPARENT)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setOnClickListener {
                toggleHud(false)
            }
        }

        // 🔴 長官指示之「直接關閉退出程式」按鈕
        val exitAppButton = Button(this).apply {
            text = "✕ 關閉程式"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#DC2626")) // 醒目鮮紅
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(16, 0, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                networkClient?.disconnect()
                finishAffinity() // 徹底退出整個 App
            }
        }

        headerLayout.addView(titleView)
        headerLayout.addView(hideButton)
        headerLayout.addView(exitAppButton)
        hudOverlay.addView(headerLayout)

        // 狀態顯示行
        statusTextView = TextView(this).apply {
            text = "🟡 正在局域網自動搜尋 PC 主機 (UDP 5857)..."
            setTextColor(Color.parseColor("#FBBF24")) // 琥珀黃
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(0, 16, 0, 24)
        }
        hudOverlay.addView(statusTextView)

        // 手動 IP 連線控制行
        val connectRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 0, 0, 16)
        }

        val ipLabel = TextView(this).apply {
            text = "主機 IP:"
            setTextColor(Color.WHITE)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            setPadding(0, 0, 16, 0)
        }

        ipEditText = EditText(this).apply {
            hint = "192.168.0.107"
            setText("192.168.0.107") // 預填長官的 PC 局域網 IP
            setTextColor(Color.WHITE)
            setHintTextColor(Color.parseColor("#64748B"))
            setBackgroundColor(Color.parseColor("#334155"))
            setPadding(24, 16, 24, 16)
            inputType = InputType.TYPE_CLASS_PHONE
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }

        connectButton = Button(this).apply {
            text = "手動連線"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#0284C7"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(16, 0, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                val ip = ipEditText.text.toString().trim()
                if (ip.isNotEmpty()) {
                    statusTextView.text = "🔄 正在連線至 $ip (雙通道 5858/5859) ..."
                    statusTextView.setTextColor(Color.parseColor("#38BDF8"))
                    networkClient?.connect(ip, 5858, 5858, 5859)
                }
            }
        }

        connectRow.addView(ipLabel)
        connectRow.addView(ipEditText)
        connectRow.addView(connectButton)
        hudOverlay.addView(connectRow)

        // 模式切換與控制行
        val actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(0, 8, 0, 16)
        }

        modeButton = Button(this).apply {
            text = "🖥️ 檢視: 主螢幕 (點擊切換延伸螢幕)"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#475569"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.1f)
            setOnClickListener {
                if (currentRole == 0x01.toByte()) {
                    currentRole = 0x02.toByte()
                    text = "🖥️ 檢視: 延伸第 2 螢幕 (點擊切換主螢幕)"
                    setBackgroundColor(Color.parseColor("#0284C7")) // 藍色高亮
                    statusTextView.text = "🖥️ 目前檢視: 延伸第 2 螢幕 (Display 2)"
                } else {
                    currentRole = 0x01.toByte()
                    text = "🖥️ 檢視: 主螢幕 (點擊切換延伸螢幕)"
                    setBackgroundColor(Color.parseColor("#475569"))
                    statusTextView.text = "🖥️ 目前檢視: 主控制台螢幕 (Console)"
                }
                networkClient?.setRole(currentRole)
            }
        }

        // 🎨 畫質切換按鈕 (低 480p / 中 640p / 高 960p / 自動 ABR)
        qualityButton = Button(this).apply {
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            setTextColor(Color.WHITE)
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.0f).apply {
                setMargins(10, 0, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                currentQualityTier = when (currentQualityTier) {
                    2 -> 3 // 中 -> 高
                    3 -> 1 // 高 -> 低
                    1 -> 0 // 低 -> 自動
                    else -> 2 // 自動 -> 中
                }
                updateQualityButtonUi(currentQualityTier)
                networkClient?.setQuality(currentQualityTier)
                val label = when (currentQualityTier) {
                    1 -> "低畫質 (480p, 省電保底)"
                    2 -> "中畫質 (720p, 最佳平衡)"
                    3 -> "高畫質 (1080p 原畫, 極致清晰)"
                    else -> "自動畫質 (ABR 自適應)"
                }
                statusTextView.text = "🎨 畫質已設定為: $label"
                statusTextView.setTextColor(Color.parseColor("#38BDF8"))
            }
        }
        updateQualityButtonUi(currentQualityTier) // 於賦值完成後安全呼叫更新 UI

        pauseResumeButton = Button(this).apply {
            text = "⏸️ 暫停串流"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#334155"))
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.8f).apply {
                setMargins(10, 0, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                if (!isStreamPaused) {
                    isStreamPaused = true
                    networkClient?.pauseStream()
                    text = "▶️ 繼續串流"
                    setBackgroundColor(Color.parseColor("#D97706")) // 琥珀橙
                    statusTextView.text = "⏸️ 視訊串流已暫停 (頻寬與筆電負載歸零)"
                } else {
                    isStreamPaused = false
                    networkClient?.resumeStream()
                    text = "⏸️ 暫停串流"
                    setBackgroundColor(Color.parseColor("#334155"))
                    statusTextView.text = "▶️ 視訊串流已恢復推流"
                }
            }
        }

        captureButton = Button(this).apply {
            text = "🖱️ 鎖定滑鼠"
            setTextColor(Color.WHITE)
            setBackgroundColor(Color.parseColor("#059669")) // 翡翠綠
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f)
            val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 0.8f).apply {
                setMargins(10, 0, 0, 0)
            }
            layoutParams = lp
            setOnClickListener {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    surfaceView.requestFocus()
                    surfaceView.requestPointerCapture()
                    toggleHud(false) // 進入獨占時自動隱藏 HUD
                }
            }
        }

        actionRow.addView(modeButton)
        actionRow.addView(qualityButton)
        actionRow.addView(pauseResumeButton)
        actionRow.addView(captureButton)
        hudOverlay.addView(actionRow)

        // 鍵鼠即時訊號儀表 (讓長官親眼看見 OTG 鍵鼠已捕獲)
        debugTextView = TextView(this).apply {
            text = "🎮 OTG 訊號儀表: [等待鍵鼠輸入... 插入 OTG 鍵鼠後隨意滑動即可測試]"
            setTextColor(Color.parseColor("#A7F3D0")) // 亮綠
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setBackgroundColor(Color.parseColor("#1E293B"))
            setPadding(20, 12, 20, 12)
        }
        hudOverlay.addView(debugTextView)

        // 視訊串流即時健康度儀表 (即時掌握接收 FPS、繪圖延遲與碼率)
        videoStatsTextView = TextView(this).apply {
            text = "📺 視訊串流健康度: [等待串流影格...]"
            setTextColor(Color.parseColor("#38BDF8")) // 科技藍
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f)
            setBackgroundColor(Color.parseColor("#0F172A"))
            setPadding(20, 12, 20, 12)
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            ).apply {
                setMargins(0, 12, 0, 0)
            }
            layoutParams = lp
        }
        hudOverlay.addView(videoStatsTextView)
    }

    private fun updateQualityButtonUi(tier: Int) {
        when (tier) {
            1 -> {
                qualityButton.text = "🎨 畫質: 低 (480p)"
                qualityButton.setBackgroundColor(Color.parseColor("#059669")) // 翡翠綠
            }
            2 -> {
                qualityButton.text = "🎨 畫質: 中 (720p)"
                qualityButton.setBackgroundColor(Color.parseColor("#0284C7")) // 科技藍
            }
            3 -> {
                qualityButton.text = "🎨 畫質: 高 (1080p)"
                qualityButton.setBackgroundColor(Color.parseColor("#7C3AED")) // 極光紫
            }
            else -> {
                qualityButton.text = "🎨 畫質: 自動"
                qualityButton.setBackgroundColor(Color.parseColor("#475569")) // 板岩灰
            }
        }
    }

    private fun toggleHud(show: Boolean) {
        isHudVisible = show
        hudOverlay.visibility = if (show) View.VISIBLE else View.GONE
        minimizedCapsule.visibility = if (show) View.GONE else View.VISIBLE
        if (show) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                surfaceView.releasePointerCapture() // 叫出 HUD 時物理釋放滑鼠獨占，手指點擊立即恢復！
            }
            hudOverlay.bringToFront()
        } else {
            minimizedCapsule.bringToFront()
            hideSystemUI()
        }
    }

    private fun updateDebugMonitor(packet: ByteArray) {
        if (packet.isEmpty()) return
        val type = packet[0].toInt()
        val info = when (type) {
            0x01 -> { // MOUSE_MOVE_REL
                val dx = (packet[1].toInt() shl 8) or (packet[2].toInt() and 0xFF)
                val dy = (packet[3].toInt() shl 8) or (packet[4].toInt() and 0xFF)
                val btn = packet[6].toInt()
                "🖱️ 滑鼠動態: ΔX=$dx, ΔY=$dy, 按鍵遮罩=0x${Integer.toHexString(btn)}"
            }
            0x02 -> { // KEY_ACTION
                val action = if (packet[1].toInt() == 1) "DOWN" else "UP"
                val vk = packet[2].toInt() and 0xFF
                val mod = packet[3].toInt() and 0xFF
                "⌨️ 按鍵信號: $action (VK=0x${Integer.toHexString(vk)}, Mod=0x${Integer.toHexString(mod)})"
            }
            else -> "封包 Type: 0x${Integer.toHexString(type)}"
        }

        runOnUiThread {
            debugTextView.text = "🎮 OTG 訊號儀表: $info"
        }
    }

    override fun onResume() {
        super.onResume()
        hideSystemUI()
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        if (!isHudVisible) {
            // 若 HUD 目前是隱藏狀態，按返回鍵優先彈出 HUD 控制面板並釋放滑鼠，絕不直接退出斷線！
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                surfaceView.releasePointerCapture()
            }
            toggleHud(true)
            return
        }

        // 若 HUD 已經是顯示狀態，防誤退雙擊保護
        val now = System.currentTimeMillis()
        if (now - lastBackPressTime < 2000) {
            networkClient?.disconnect()
            finishAffinity()
        } else {
            lastBackPressTime = now
            android.widget.Toast.makeText(this, "再按一次返回鍵退出，或點擊右上角「✕ 關閉程式」", android.widget.Toast.LENGTH_SHORT).show()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        inputCapture.detach(surfaceView)
        networkClient?.destroy()
        networkClient = null
        decoder?.release()
        decoder = null
    }

    private fun hideSystemUI() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let { controller ->
                controller.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                controller.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
            )
        }
    }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (inputCapture.onKey(surfaceView, event.keyCode, event)) {
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun dispatchGenericMotionEvent(event: MotionEvent): Boolean {
        if (inputCapture.onGenericMotion(surfaceView, event)) {
            return true
        }
        return super.dispatchGenericMotionEvent(event)
    }

    override fun dispatchTouchEvent(event: MotionEvent): Boolean {
        val isRealMouse = event.isFromSource(InputDevice.SOURCE_MOUSE)

        if (isRealMouse) {
            // 實體外接滑鼠 (USB OTG / 藍牙)：若點在 HUD 內則操作 HUD，否則轉發 PC 滑鼠
            if (isHudVisible && hudOverlay.visibility == View.VISIBLE) {
                val loc = IntArray(2)
                hudOverlay.getLocationOnScreen(loc)
                if (event.rawX >= loc[0] && event.rawX <= loc[0] + hudOverlay.width &&
                    event.rawY >= loc[1] && event.rawY <= loc[1] + hudOverlay.height) {
                    return super.dispatchTouchEvent(event)
                }
            }
            if (inputCapture.onTouch(surfaceView, event)) {
                return true
            }
            return super.dispatchTouchEvent(event)
        }

        // --- 以下為純手機/平板螢幕手指觸控 (100% 服務於 Android 操作艙，絕不發送 PC 滑鼠) ---

        // 1. 若頂部「⚡ 選單」膠囊顯示中，優先判斷點擊膠囊
        if (minimizedCapsule.visibility == View.VISIBLE) {
            val loc = IntArray(2)
            minimizedCapsule.getLocationOnScreen(loc)
            if (event.rawX >= loc[0] && event.rawX <= loc[0] + minimizedCapsule.width &&
                event.rawY >= loc[1] && event.rawY <= loc[1] + minimizedCapsule.height) {
                if (event.action == MotionEvent.ACTION_UP) {
                    toggleHud(true)
                }
                return true
            }
        }

        // 2. 若 HUD 操作艙正在顯示
        if (isHudVisible && hudOverlay.visibility == View.VISIBLE) {
            val loc = IntArray(2)
            hudOverlay.getLocationOnScreen(loc)
            val inHud = (event.rawX >= loc[0] && event.rawX <= loc[0] + hudOverlay.width &&
                         event.rawY >= loc[1] && event.rawY <= loc[1] + hudOverlay.height)
            if (inHud) {
                // 點在 HUD 操作艙內部：交由各按鈕 (暫停、關閉、切換等) 正常響應點擊
                return super.dispatchTouchEvent(event)
            } else {
                // 點在 HUD 操作艙外圍空白處：輕點自動收合 HUD
                if (event.action == MotionEvent.ACTION_UP) {
                    toggleHud(false)
                }
                return true
            }
        }

        // 3. 若 HUD 為隱藏狀態 (純螢幕觀看模式)：輕點螢幕任意處立即彈出 HUD 操作艙！
        when (event.action) {
            MotionEvent.ACTION_DOWN -> {
                touchDownX = event.rawX
                touchDownY = event.rawY
                touchDownTimeMs = System.currentTimeMillis()
            }
            MotionEvent.ACTION_UP -> {
                val dt = System.currentTimeMillis() - touchDownTimeMs
                val dist = Math.hypot((event.rawX - touchDownX).toDouble(), (event.rawY - touchDownY).toDouble())
                if (dt < 400 && dist < 50.0) {
                    // 短輕點 -> 喚出 HUD 操作艙
                    toggleHud(true)
                    return true
                }
            }
        }

        return super.dispatchTouchEvent(event)
    }

    // --- SurfaceHolder.Callback 回調 ---

    override fun surfaceCreated(holder: SurfaceHolder) {
        // 嚴禁在此處調用 holder.lockCanvas()！lockCanvas 會強制將 Surface 轉為 CPU 軟體渲染模式，
        // 徹底破壞 MediaCodec GPU 零拷貝 Direct Surface 渲染管線！
        if (decoder == null && holder.surface.isValid) {
            decoder = MediaCodecDecoder(holder.surface, this@MainActivity).apply {
                initialize(1920, 1080)
            }
        }
    }

    private fun buildStandbyOverlay(): View {
        return object : View(this@MainActivity) {
            private val gridPaint = Paint().apply {
                isAntiAlias = true
                color = Color.parseColor("#1E293B")
                strokeWidth = 2f
            }
            private val titlePaint = Paint().apply {
                isAntiAlias = true
                color = Color.parseColor("#38BDF8")
                textSize = 52f
                typeface = Typeface.DEFAULT_BOLD
                textAlign = Paint.Align.CENTER
            }
            private val descPaint = Paint().apply {
                isAntiAlias = true
                color = Color.parseColor("#94A3B8")
                textSize = 28f
                typeface = Typeface.DEFAULT
                textAlign = Paint.Align.CENTER
            }

            override fun onDraw(canvas: Canvas) {
                super.onDraw(canvas)
                canvas.drawColor(Color.parseColor("#0B0F19"))
                val w = width.toFloat()
                val h = height.toFloat()
                val step = 80f
                var x = 0f
                while (x < w) {
                    canvas.drawLine(x, 0f, x, h, gridPaint)
                    x += step
                }
                var y = 0f
                while (y < h) {
                    canvas.drawLine(0f, y, w, y, gridPaint)
                    y += step
                }
                canvas.drawText("⚡ DUOTAB-KVM 操作艙待機中", w / 2, h / 2 - 60, titlePaint)
                canvas.drawText("請點擊左上角 [⚙️ DuoTab HUD] 展開操作面板", w / 2, h / 2 + 20, descPaint)
                canvas.drawText("PC 端伺服器預設 IP: 192.168.0.107:5858", w / 2, h / 2 + 80, descPaint)
            }
        }
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        decoder?.release()
        decoder = null
    }

    // --- MediaCodecDecoder.Callback 回調 ---

    override fun onFirstFrameRendered() {
        runOnUiThread {
            standbyOverlay.visibility = View.GONE // 瞬間隱藏待機層，露出底層 MediaCodec 硬體渲染之實體桌面！
            statusTextView.text = "🟢 視訊串流已就緒 (零拷貝硬體解碼)"
            statusTextView.setTextColor(Color.parseColor("#34D399"))
        }
    }

    override fun onRequestKeyframe() {
        networkClient?.requestKeyframe()
    }

    override fun onDecodeError(exception: Exception) {
        runOnUiThread {
            statusTextView.text = "⚠️ 解碼警示: ${exception.message}"
            statusTextView.setTextColor(Color.parseColor("#F87171"))
        }
    }

    // --- NetworkClient.Callback 回調 ---

    private val discoveredServers = java.util.concurrent.ConcurrentHashMap<String, NetworkClient.ServerInfo>()
    private var boundHostId: String? = null

    override fun onServerFound(server: NetworkClient.ServerInfo) {
        discoveredServers[server.hostId] = server
        runOnUiThread {
            ipEditText.setText(server.ip)
            statusTextView.text = "🟢 找到主機: ${server.hostname} (${server.ip})，雙通道就緒"
            statusTextView.setTextColor(Color.parseColor("#34D399"))

            // 防連錯機制：若尚未連線且 (尚未綁定 或 命中已綁定主機)，自動連線
            if (!isConnected && (boundHostId == null || boundHostId == server.hostId)) {
                boundHostId = server.hostId
                networkClient?.connect(server)
            }
        }
    }

    override fun onConnected() {
        isConnected = true
        runOnUiThread {
            statusTextView.text = "🟢 已連線至 PC 主機！雙通道輸入串流中"
            statusTextView.setTextColor(Color.parseColor("#34D399"))
            connectButton.text = "已連線"
            connectButton.setBackgroundColor(Color.parseColor("#059669"))
        }
    }

    override fun onDisconnected() {
        isConnected = false
        runOnUiThread {
            standbyOverlay.visibility = View.VISIBLE // 斷線時重新浮現待機提示
            statusTextView.text = "🔴 主機已斷開連線 (點擊手動連線重試)"
            statusTextView.setTextColor(Color.parseColor("#F87171"))
            connectButton.text = "重新連線"
            connectButton.setBackgroundColor(Color.parseColor("#0284C7"))
            toggleHud(true) // 斷線時主動彈出 HUD 提示長官
        }
    }

    private var hasShownStreamSuccess = false

    override fun onH264Frame(naluData: ByteArray, seq: Int, flags: Int, isKeyframe: Boolean, isConfig: Boolean) {
        if (!isConfig) {
            rxFrameCount++ // 僅統計真實影像畫面 (IDR/P-Frame)，絕不將 SPS/PPS 參數集重複算入 FPS！
        }
        rxByteCount += naluData.size

        if (decoder == null && surfaceView.holder.surface.isValid) {
            decoder = MediaCodecDecoder(surfaceView.holder.surface, this).apply {
                initialize(1920, 1080)
            }
        }

        val t0 = System.currentTimeMillis()
        decoder?.feedNalu(naluData, isConfig = isConfig, isKeyframe = isKeyframe)
        lastRenderDurationMs = System.currentTimeMillis() - t0

        if (!hasShownStreamSuccess) {
            hasShownStreamSuccess = true
            runOnUiThread {
                standbyOverlay.visibility = View.GONE // 首批 H.264 幀抵達時確保待機層瞬間消失
                statusTextView.text = "🟢 H.264 硬體零拷貝串流中！極致低延遲"
                statusTextView.setTextColor(Color.parseColor("#34D399"))
            }
        }

        updateVideoTelemetryIfNeeded()
    }

    override fun onVideoData(data: ByteArray) {
        // 向後相容接口：若直接傳入二進制資料，自動識別 Annex-B NALU 類型並轉發 onH264Frame
        if (data.size >= 2 && data[0] == 0xFF.toByte() && data[1] == 0xD8.toByte()) {
            // 已徹底淘汰 MJPEG 軟解軟繪舊路徑，拋棄過期幀以節省 CPU
            return
        }
        val isConfig = data.size >= 5 && ((data[4].toInt() and 0x1F) == 7 || (data[4].toInt() and 0x1F) == 8)
        val isKeyframe = data.size >= 5 && ((data[4].toInt() and 0x1F) == 5)
        onH264Frame(data, seq = 0, flags = 0, isKeyframe = isKeyframe, isConfig = isConfig)
    }

    override fun onVideoFormatChanged(width: Int, height: Int) {
        runOnUiThread {
            statusTextView.text = "🟢 解析度已動態切換至 ${width}x${height} (MediaCodec 硬解)"
            statusTextView.setTextColor(Color.parseColor("#34D399"))
        }
    }

    /**
     * 每秒即時計算並刷新視訊健康度指標 (FPS、繪圖延遲、碼率)
     */
    private fun updateVideoTelemetryIfNeeded() {
        val now = System.currentTimeMillis()
        if (lastStatsTime == 0L) {
            lastStatsTime = now
            return
        }

        if (now - lastStatsTime >= 1000) {
            val deltaSec = (now - lastStatsTime) / 1000.0
            val fps = rxFrameCount / deltaSec
            val kbps = rxByteCount / 1024.0 / deltaSec
            val renderMs = lastRenderDurationMs
            val light = if (fps >= 24) "🟢 流暢" else if (fps >= 15) "🟡 良好" else "🔴 輕微延遲"

            val info = String.format(java.util.Locale.US, "📺 視訊串流: %.1f FPS | 繪圖耗時: %dms | 碼率: %.1f KB/s (%s)", fps, renderMs, kbps, light)
            val capsuleText = String.format(java.util.Locale.US, "⚙️ HUD (%.0f FPS)", fps)

            rxFrameCount = 0
            rxByteCount = 0L
            lastStatsTime = now

            runOnUiThread {
                videoStatsTextView.text = info
                minimizedCapsule.text = capsuleText
            }
        }
    }

    override fun onError(e: Exception) {
        runOnUiThread {
            statusTextView.text = "⚠️ 網路異常: ${e.message}"
            statusTextView.setTextColor(Color.parseColor("#F87171"))
        }
    }

}
