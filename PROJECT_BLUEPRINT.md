# DuoTab-KVM 專案總藍圖 (Project Blueprint)

> 本文件為 DuoTab-KVM 子專案之核心架構、里程碑與驗證接縫指南。

---

## 1. 專案定位與核心價值
* **專案代號**：`duotab-kvm`
* **目標**：讓兩台 Android 平板透過 Wi-Fi 5G/6，分別作為 Windows 10/11 桌機的「主要螢幕（含 OTG 鍵盤滑鼠完整穿透）」與「純延伸螢幕」。
* **極致指標**：
  * 畫面串流：最高 1080p 60fps，延遲 $\le 20\text{ms}$，具備動態 ABR 自適應降碼率。
  * 鍵鼠操控：OTG 實體按鍵 100% 獨占穿透，延遲 $\le 8\text{ms}$。

---

## 2. 聯邦目錄劃分
* `server/`：Windows 10/11 主控端（DXGI 顯存捕捉、硬體編碼自適應鏈、Win32 鍵鼠注入）。
* `android/`：Android 雙模 App（Console 主控台 + Display 放映艙，MediaCodec 硬解）。
* `protocol/`：雙端二進制封包協議、常數與 Headless 測試。
* `docs/`：正式規格書 `SPECIFICATION.md` 與架構決策紀錄。

---

## 3. 里程碑切片規劃
- [x] **M0: 專案沙盒建立與規格落鎖** (已完成)
- [x] **M1: 雙端二進制通訊協議與 Headless 測試驗證** (npm test 全綠 7/7)
- [x] **M3: PC 端 Win32 SendInput 鍵鼠注入驗證** (Ticket 02 完成 · 純記憶體反射 0 觸發防毒 + 專屬 WorkerThread 穿透 + 物理位移硬鎖)
- [x] **M5: PC 端 DXGI 畫面捕獲與自適應編碼原型驗證** (Ticket 04 完成 · 實體 3 螢幕拓撲 + 雙顯卡自適應備援 + ABR 動態調控 + 19/19 測試全綠)
- [x] **M6: Android 端 MediaCodec 硬解與雙通道串流整合** (Ticket 05 完成 · 無頭 NALU 分幀 + 丟包自癒重傳 + MediaCodec Surface 零拷貝 + 23/23 測試全綠)
- [x] **M7: mDNS 自動尋標與端到端 Live Reality 實體驗收** (Ticket 06 完成 · 局域網 UDP 自動尋標 + TCP/UDP 雙通道全雙工協調 + 斷線急停防黏鍵 + 25/25 測試全綠)

---

## 4. 低功耗視訊與網路升級里程碑 (Video & Low-Power Upgrade Slices)
- [x] **Ticket 07: H.264 NALU 封裝協議與雙端二進制合約升級** (Protocol & Constants & Headless 測試 · 32/32 全綠 · Gradle assembleDebug 雙端編譯通過)
- [x] **Ticket 08: PC 伺服器端 H.264 硬體加速編碼管線實裝** (QSV / NVENC / CPU 自適應鏈 + 淘汰 MJPEG + 36/36 測試全綠)
- [ ] **Ticket 09: Android 平板端 MediaCodec 零拷貝硬解直出與淘汰軟解** (Surface 直刷 + 徹底消滅發熱與 GC)
- [ ] **Ticket 10: 弱網自癒看門狗 (Instant IDR Watchdog) 與 ABR 動態調控** (即時關鍵幀插入 + 100ms 破圖自癒)
