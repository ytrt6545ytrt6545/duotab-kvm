package com.aimade.duotab.input

import android.os.Build
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import com.aimade.duotab.protocol.PacketBuilder

/**
 * Android OTG 鍵鼠獨占捕獲與轉發模組
 * 支援 PointerCapture 實體滑鼠 Raw Delta 穿透、觸控螢幕 Trackpad 模式與 100% 鍵盤攔截
 */
class RawInputCapture(
    private val onPacketReady: (ByteArray) -> Unit
) : View.OnGenericMotionListener, View.OnKeyListener, View.OnTouchListener, View.OnCapturedPointerListener {

    private var mouseSeq: Int = 0
    private var keySeq: Int = 0


    // 滑鼠游標差分回退追蹤 (未開 PointerCapture 時使用)
    private var lastMouseX: Float = 0f
    private var lastMouseY: Float = 0f
    private var hasLastMousePos: Boolean = false

    private fun calculateDeltas(event: MotionEvent): Pair<Int, Int> {
        var dx = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            event.getAxisValue(MotionEvent.AXIS_RELATIVE_X).toInt()
        } else 0
        var dy = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            event.getAxisValue(MotionEvent.AXIS_RELATIVE_Y).toInt()
        } else 0

        // 差分自動回退：若系統未提供 AXIS_RELATIVE 則自動計算前後座標差分
        if (dx == 0 && dy == 0) {
            if (hasLastMousePos) {
                val rawDx = (event.x - lastMouseX).toInt()
                val rawDy = (event.y - lastMouseY).toInt()
                // 防抖保護：單幀過大跳躍 (如跨螢幕瞬移) 予以平滑過濾
                if (Math.abs(rawDx) < 400 && Math.abs(rawDy) < 400) {
                    dx = rawDx
                    dy = rawDy
                }
            }
            lastMouseX = event.x
            lastMouseY = event.y
            hasLastMousePos = true
        } else {
            lastMouseX = event.x
            lastMouseY = event.y
            hasLastMousePos = true
        }
        return Pair(dx, dy)
    }

    fun attach(view: View) {
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.requestFocus()
        view.setOnGenericMotionListener(this)
        view.setOnKeyListener(this)
        view.setOnTouchListener(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.setOnCapturedPointerListener(this)
            view.requestPointerCapture()
        }
    }

    fun detach(view: View) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.setOnCapturedPointerListener(null)
            view.releasePointerCapture()
        }
        view.setOnGenericMotionListener(null)
        view.setOnKeyListener(null)
        view.setOnTouchListener(null)
        hasLastMousePos = false
    }

    /**
     * 專門處理 Android 8.0+ PointerCapture 獨占模式下的實體滑鼠事件
     * 官方保證：開啟 PointerCapture 後，所有實體滑鼠移動與按鈕均進入此回調
     */
    override fun onCapturedPointer(view: View?, event: MotionEvent?): Boolean {
        if (event == null) return false

        when (event.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val dx = event.getAxisValue(MotionEvent.AXIS_RELATIVE_X).toInt()
                val dy = event.getAxisValue(MotionEvent.AXIS_RELATIVE_Y).toInt()
                val buttons = translateButtons(event.buttonState)
                val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()

                if (dx != 0 || dy != 0 || buttons != 0 || vScroll != 0) {
                    mouseSeq = (mouseSeq + 1) and 0xFF
                    val packet = PacketBuilder.buildMouseMove(dx, dy, vScroll, buttons, mouseSeq)
                    onPacketReady(packet)
                }
                return true
            }
            MotionEvent.ACTION_BUTTON_PRESS,
            MotionEvent.ACTION_BUTTON_RELEASE -> {
                val buttons = translateButtons(event.buttonState)
                mouseSeq = (mouseSeq + 1) and 0xFF
                val packet = PacketBuilder.buildMouseMove(0, 0, 0, buttons, mouseSeq)
                onPacketReady(packet)
                return true
            }
            MotionEvent.ACTION_SCROLL -> {
                val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
                val buttons = translateButtons(event.buttonState)
                if (vScroll != 0 || buttons != 0) {
                    mouseSeq = (mouseSeq + 1) and 0xFF
                    val packet = PacketBuilder.buildMouseMove(0, 0, vScroll, buttons, mouseSeq)
                    onPacketReady(packet)
                }
                return true
            }
        }
        return false
    }

    /**
     * 實體外接滑鼠點擊與拖曳處理 (已徹底取消手機螢幕觸控轉滑鼠)
     */
    override fun onTouch(v: View?, event: MotionEvent?): Boolean {
        if (event == null) return false

        // 嚴格判斷：是否真正來自實體外接滑鼠 (避免與手機螢幕觸控混淆)
        val isRealMouse = event.isFromSource(InputDevice.SOURCE_MOUSE)

        if (isRealMouse) {
            val buttons = translateButtons(event.buttonState)
            val (dx, dy) = calculateDeltas(event)

            if (dx != 0 || dy != 0 || buttons != 0) {
                mouseSeq = (mouseSeq + 1) and 0xFF
                val packet = PacketBuilder.buildMouseMove(dx, dy, 0, buttons, mouseSeq)
                onPacketReady(packet)
            }
            return true
        }

        // 依長官指示：徹底取消手機螢幕滑動/輕點控制 PC 滑鼠功能，根除按鍵衝突與誤觸！
        // 手機螢幕觸摸 100% 回歸 Android 原生分發，用於 HUD 介面操作與點擊喚醒
        return false
    }

    /**
     * 未進入 PointerCapture 時的滑鼠懸停與滾輪事件
     */
    override fun onGenericMotion(v: View?, event: MotionEvent?): Boolean {
        if (event == null) return false

        if (event.isFromSource(InputDevice.SOURCE_MOUSE)) {
            when (event.actionMasked) {
                MotionEvent.ACTION_HOVER_MOVE,
                MotionEvent.ACTION_MOVE -> {
                    val (dx, dy) = calculateDeltas(event)
                    val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
                    val buttons = translateButtons(event.buttonState)

                    if (dx != 0 || dy != 0 || buttons != 0 || vScroll != 0) {
                        mouseSeq = (mouseSeq + 1) and 0xFF
                        val packet = PacketBuilder.buildMouseMove(dx, dy, vScroll, buttons, mouseSeq)
                        onPacketReady(packet)
                    }
                    return true
                }
                MotionEvent.ACTION_SCROLL -> {
                    val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
                    val buttons = translateButtons(event.buttonState)

                    if (vScroll != 0 || buttons != 0) {
                        mouseSeq = (mouseSeq + 1) and 0xFF
                        val packet = PacketBuilder.buildMouseMove(0, 0, vScroll, buttons, mouseSeq)
                        onPacketReady(packet)
                    }
                    return true
                }
            }
        }
        return false
    }

    override fun onKey(v: View?, keyCode: Int, event: KeyEvent?): Boolean {
        if (event == null) return false

        // 攔截所有實體鍵盤事件
        val action = when (event.action) {
            KeyEvent.ACTION_DOWN -> 1
            KeyEvent.ACTION_UP -> 0
            else -> return false
        }

        val vkCode = mapAndroidKeyToWindowsVk(keyCode)
        if (vkCode == 0) {
            return true
        }

        val modifiers = translateModifiers(event.metaState)
        keySeq = (keySeq + 1) and 0xFF

        val packet = PacketBuilder.buildKeyAction(action, vkCode, modifiers, keySeq)
        onPacketReady(packet)

        return true
    }

    companion object {
        fun translateButtons(buttonState: Int): Int {
            var b = 0
            if ((buttonState and MotionEvent.BUTTON_PRIMARY) != 0) b = b or 0x01
            if ((buttonState and MotionEvent.BUTTON_SECONDARY) != 0) b = b or 0x02
            if ((buttonState and MotionEvent.BUTTON_TERTIARY) != 0) b = b or 0x04
            if ((buttonState and MotionEvent.BUTTON_BACK) != 0) b = b or 0x08
            if ((buttonState and MotionEvent.BUTTON_FORWARD) != 0) b = b or 0x10
            return b
        }

        fun translateModifiers(metaState: Int): Int {
            var m = 0
            if ((metaState and 0xC1) != 0) m = m or 0x01 // Shift
            if ((metaState and 0x7000) != 0) m = m or 0x02 // Ctrl
            if ((metaState and 0x32) != 0) m = m or 0x04 // Alt
            if ((metaState and 0x70000) != 0) m = m or 0x08 // Meta / Win
            return m
        }

        fun mapAndroidKeyToWindowsVk(keyCode: Int): Int {
            return when (keyCode) {
                // 字母 A~Z
                in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> 0x41 + (keyCode - KeyEvent.KEYCODE_A)
                // 數字 0~9
                in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> 0x30 + (keyCode - KeyEvent.KEYCODE_0)
                // F1~F12
                in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> 0x70 + (keyCode - KeyEvent.KEYCODE_F1)
                // 方向鍵
                KeyEvent.KEYCODE_DPAD_UP -> 0x26
                KeyEvent.KEYCODE_DPAD_DOWN -> 0x28
                KeyEvent.KEYCODE_DPAD_LEFT -> 0x25
                KeyEvent.KEYCODE_DPAD_RIGHT -> 0x27
                // 系統控制與修飾鍵
                KeyEvent.KEYCODE_ENTER -> 0x0D
                KeyEvent.KEYCODE_SPACE -> 0x20
                KeyEvent.KEYCODE_TAB -> 0x09
                KeyEvent.KEYCODE_ESCAPE -> 0x1B
                KeyEvent.KEYCODE_DEL -> 0x08 // Backspace
                KeyEvent.KEYCODE_FORWARD_DEL -> 0x2E // Delete
                KeyEvent.KEYCODE_META_LEFT -> 0x5B // Left Windows
                KeyEvent.KEYCODE_META_RIGHT -> 0x5C // Right Windows
                KeyEvent.KEYCODE_CTRL_LEFT -> 0xA2
                KeyEvent.KEYCODE_CTRL_RIGHT -> 0xA3
                KeyEvent.KEYCODE_ALT_LEFT -> 0xA4
                KeyEvent.KEYCODE_ALT_RIGHT -> 0xA5
                KeyEvent.KEYCODE_SHIFT_LEFT -> 0xA0
                KeyEvent.KEYCODE_SHIFT_RIGHT -> 0xA1
                KeyEvent.KEYCODE_CAPS_LOCK -> 0x14
                KeyEvent.KEYCODE_MOVE_HOME -> 0x24
                KeyEvent.KEYCODE_MOVE_END -> 0x23
                KeyEvent.KEYCODE_PAGE_UP -> 0x21
                KeyEvent.KEYCODE_PAGE_DOWN -> 0x22
                KeyEvent.KEYCODE_INSERT -> 0x2D

                // 數字小鍵盤 NumPad 0~9 (VK_NUMPAD0 0x60 ~ VK_NUMPAD9 0x69)
                in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> 0x60 + (keyCode - KeyEvent.KEYCODE_NUMPAD_0)
                KeyEvent.KEYCODE_NUMPAD_DIVIDE -> 0x6F
                KeyEvent.KEYCODE_NUMPAD_MULTIPLY -> 0x6A
                KeyEvent.KEYCODE_NUMPAD_SUBTRACT -> 0x6D
                KeyEvent.KEYCODE_NUMPAD_ADD -> 0x6B
                KeyEvent.KEYCODE_NUMPAD_DOT -> 0x6E
                KeyEvent.KEYCODE_NUMPAD_ENTER -> 0x0D
                KeyEvent.KEYCODE_NUMPAD_EQUALS -> 0xBB
                KeyEvent.KEYCODE_NUM_LOCK -> 0x90

                // 標點符號與常用鍵
                KeyEvent.KEYCODE_GRAVE -> 0xC0 // `~
                KeyEvent.KEYCODE_MINUS -> 0xBD // -_
                KeyEvent.KEYCODE_EQUALS -> 0xBB // =+
                KeyEvent.KEYCODE_LEFT_BRACKET -> 0xDB // [{
                KeyEvent.KEYCODE_RIGHT_BRACKET -> 0xDD // ]}
                KeyEvent.KEYCODE_BACKSLASH -> 0xDC // \|
                KeyEvent.KEYCODE_SEMICOLON -> 0xBA // ;:
                KeyEvent.KEYCODE_APOSTROPHE -> 0xDE // '"
                KeyEvent.KEYCODE_COMMA -> 0xBC // ,<
                KeyEvent.KEYCODE_PERIOD -> 0xBE // .>
                KeyEvent.KEYCODE_SLASH -> 0xBF // /?
                else -> 0
            }
        }
    }
}
