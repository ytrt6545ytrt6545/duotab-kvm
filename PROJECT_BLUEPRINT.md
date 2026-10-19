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
- [ ] **M2: PC 端 DXGI 畫面捕獲與自適應編碼原型驗證**
- [ ] **M3: PC 端 Win32 SendInput 鍵鼠注入驗證**
- [ ] **M4: Android 端 PointerCapture 與 OTG 鍵鼠攔截轉發**
- [ ] **M5: Android 端 MediaCodec 硬解與雙通道串流整合**
- [ ] **M6: mDNS 自動尋標與端到端 Live Reality 實體驗收**
