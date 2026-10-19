# 專案技術規格書: DuoTab-KVM 雙 Android 平板低延遲工作站系統

> **版本**：v1.0.0  
> **狀態**：正式規格 (Approved Specification)  
> **編寫人**：Antigravity 首席架構師  

---

## 1. 問題陳述 (Problem Statement)
現代使用者需要將桌上型電腦（Windows 10/11）的高效能算力帶入便攜或多屏場景，但受限於實體顯示器體積笨重、缺乏靈活性。雖然手邊擁有兩台高效能 Android 平板，但市售現成解決方案存在以下嚴重缺陷：
1. **輸入與顯示脫節**：現有無線延伸螢幕工具（如 Spacedesk）滑鼠延遲明顯（>40ms），且對 Android OTG 鍵盤滑鼠的「右鍵、滾輪、側鍵、系統組合鍵（Win 鍵、Alt+Tab）」存在嚴重系統攔截與功能閹割。
2. **多螢幕串流架構繁瑣**：電競級低延遲工具（如 Moonlight/Sunshine）天生以「單螢幕串流遊戲」為中心，無法以單一拓撲自動將 Display 1 映射給主控制台平板（含鍵鼠 I/O）、同時將 Display 2 映射給純延伸平板。
3. **硬體依賴僵化**：多數工具若遇到目標主機更換顯卡（例如不同晶片製造商），即出現驅動報錯或效能驟降，缺乏全自動降級與頻寬自適應防護。

---

## 2. 解決方案 (Solution Overview)
打造專屬的 **DuoTab-KVM** 雙端系統，實現：
1. **單一免安裝 PC 主控端 (`duotab-server.exe`)**：支援 Windows 10/11，以 DXGI 顯存直出捕捉雙螢幕，結合動態探測硬體編碼（NVENC ➔ QSV ➔ AMF ➔ CPU），在 Wi-Fi 5G/6 區網下串流輸出兩路最高 1080p 60fps 畫面，並具備動態頻寬自適應（ABR）。
2. **單一 Android 雙模客戶端 (`duotab-client.apk`)**：
   * **主要螢幕模式 (Console)**：接收 Display 1，透過 Android 原生 `PointerCapture` 與獨占 `KeyEvent` 攔截，將實體 OTG 鍵盤滑鼠 100% 穿透注入 PC。
   * **延伸螢幕模式 (Display)**：接收 Display 2，進入純硬體解碼省電放映狀態。
3. **極致連線體驗**：mDNS 區域網自動探索，開機/打開 App 自動配對，免手動輸入 IP。

---

## 3. 使用者故事與驗收情境 (User Stories & Scenarios)

### 場景 1：開機自動配對與雙角色上線
* **作為** 操作者，我希望將兩台平板打開 App 並分別點擊「主控制台」與「延伸螢幕」，
* **以便於** 系統在 2 秒內透過 Wi-Fi 自動發現 Windows 主機，分別流暢顯示主螢幕與第二螢幕，無須手動輸入 IP 或進行配對設定。

### 場景 2：OTG 鍵盤滑鼠 100% 沉浸式操控
* **作為** 在主平板 A 操作鍵盤與滑鼠的使用者，我希望按下 `Win 鍵`、`Alt + Tab`、`Ctrl + Shift + Esc` 或使用滑鼠右鍵/滾輪/側鍵時，
* **以便於** 所有操作直接作用於 Windows 桌機，完全不觸發 Android 系統層級的多工或返回手勢。

### 場景 3：無縫跨屏游標移動
* **作為** 使用者，當我將滑鼠從主平板 A 的右邊緣移出時，
* **以便於** 滑鼠游標順暢出現在副平板 B（延伸螢幕）上，完全保留 Windows 原生多顯示器座標無縫跨越體驗。

### 場景 4：動態網路頻寬波動防護
* **作為** 在 Wi-Fi 波動環境下的使用者，當頻寬短暫下降時，
* **以便於** 系統自動平滑降低畫面碼率或分辨率，優先保證 60fps 與鍵鼠極低延遲（<15ms），絕不發生連線中斷或凍結卡死。

---

## 5. 測試策略與驗證接縫 (Testing Strategy)
* **PC 輸入注入接縫**：獨立於網路層的 `InputInjectionService`，可在本機發送 Mock 二進制 Packet 驗證 Win32 `SendInput` 座標計算與按鍵還原。
* **自適應編碼鏈接縫**：編碼器工廠暴露 `createEncoder(deviceContext)`，在無實體 GPU 時保證平滑回退至軟體編碼器且 Exit Code 為 0。
* **Android 解碼接縫**：`MediaCodecRenderer` 暴露 Frame Feed 介面，支援注入 H.264 NAL 單元斷言渲染成功率。
