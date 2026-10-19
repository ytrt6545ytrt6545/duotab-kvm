package com.aimade.duotab.input

import android.os.Build
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View
import com.aimade.duotab.protocol.PacketBuilder

/**
 * Android OTG 鍵鼠獨占捕獲與轉發模組
 * 負責透過 PointerCapture 隱藏本機游標、獲取 Raw Delta，並 100% 攔截系統組合鍵
 */
class RawInputCapture(
    private val onPacketReady: (ByteArray) -> Unit
) : View.OnGenericMotionListener, View.OnKeyListener {

    private var mouseSeq: Int = 0
    private var keySeq: Int = 0

    fun attach(view: View) {
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.requestFocus()
        view.setOnGenericMotionListener(this)
        view.setOnKeyListener(this)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.requestPointerCapture()
        }
    }

    fun detach(view: View) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            view.releasePointerCapture()
        }
        view.setOnGenericMotionListener(null)
        view.setOnKeyListener(null)
    }

    override fun onGenericMotion(v: View?, event: MotionEvent?): Boolean {
        if (event == null) return false
        val source = event.source

        if ((source and InputDevice.SOURCE_MOUSE) != 0 || (source and InputDevice.SOURCE_MOUSE_RELATIVE) != 0) {
            when (event.actionMasked) {
                MotionEvent.ACTION_HOVER_MOVE,
                MotionEvent.ACTION_MOVE -> {
                    val dx = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        event.getAxisValue(MotionEvent.AXIS_RELATIVE_X).toInt()
                    } else {
                        0
                    }
                    val dy = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                        event.getAxisValue(MotionEvent.AXIS_RELATIVE_Y).toInt()
                    } else {
                        0
                    }

                    val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
                    val buttons = translateButtons(event.buttonState)

                    mouseSeq = (mouseSeq + 1) and 0xFF
                    val packet = PacketBuilder.buildMouseMove(dx, dy, vScroll, buttons, mouseSeq)
                    onPacketReady(packet)
                    return true
                }
                MotionEvent.ACTION_SCROLL -> {
                    val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL).toInt()
                    val buttons = translateButtons(event.buttonState)

                    mouseSeq = (mouseSeq + 1) and 0xFF
                    val packet = PacketBuilder.buildMouseMove(0, 0, vScroll, buttons, mouseSeq)
                    onPacketReady(packet)
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
            // 未知鍵碼，仍返回 true 避免系統截胡
            return true
        }

        val modifiers = translateModifiers(event.metaState)
        keySeq = (keySeq + 1) and 0xFF

        val packet = PacketBuilder.buildKeyAction(action, vkCode, modifiers, keySeq)
        onPacketReady(packet)

        // 100% 消費事件，阻止 Android 系統處理 (如 Back, Home, App Switcher)
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
                else -> 0
            }
        }
    }
}
