# duotab-kvm 開發日誌與踩坑經驗 (DevLog)

> 記錄每一次架構決策、重大踩坑與設計亮點。

---

## 📅 2026-10-19 - 專案初始化
* 專案建立於 `projects/duotab-kvm`。
* 完成獨立 Git 倉庫與安全邊界防護配置。

## 📅 2026-10-19 - Ticket 01 雙端二進制協議與無頭狀態機驗證 (全綠)
* **交付成果**：
  * 完成 8-Byte 滑鼠運動包 (`MOUSE_MOVE_REL`)、6-Byte 鍵盤動作包 (`KEY_ACTION`)、8-Byte 心跳包 (`HEARTBEAT`) 與 6-Byte 串流控制包 (`STREAM_CONTROL`) 二進制編解碼器。
  * 完成 `InputStateMachine` 無頭輸入狀態機，內建 1/3 租約看門狗與斷線急停全鍵釋放機制（`EmergencyRelease`），杜絕黏鍵。
  * 標準測試 `npm test` 7 項測試全綠，Exit Code 0。
* **踩坑與避坑演進 (Postmortem)**：
  * **問題症狀**：在測試租約看門狗超時時，`checkLease(baseTime + 600)` 判定未過期返回 `null`。
  * **根本原因**：`processKeyAction` 與 `processMouseMove` 內部直接呼叫 `this.touch()`，其預設使用了 `Date.now()`（真實目前時間），將測試設定的虛擬時間軸 `baseTime` 覆蓋。
  * **避坑解法**：在所有動作處理函數增加可選的 `timestamp = Date.now()` 參數並傳入 `touch(timestamp)`，既兼顧運行期零負擔預設值，又支援時間旅行式的無頭確定性單元測試。

## 📅 2026-10-19 - Ticket 02 重大真機排坑：消滅假綠燈 · OpenInputDesktop 桌面穿透物理硬鎖
* **交付成果**：
  * 在 `InputBridge.cs` 增加 Win32 原生 `GetCursorPos` 查詢接口與 `EnsureDesktop`（`OpenInputDesktop` + `SetThreadDesktop`）桌面穿透機制。
  * 在 `InputInjector` 封裝 `getCursorPos()` 毫秒級座標讀取。
  * 在全域測試 `test/input-injector.test.mjs` 落實真正的「物理游標位移硬鎖（$\Delta X \neq 0 \land \Delta Y \neq 0$）」，真實捕捉到 $\Delta X=42, \Delta Y=41$ 像素物理位移。
  * 標準測試 `npm test` 9 項測試全綠，Exit Code 0。
* **重大踩坑與避坑演進 (Postmortem)**：
  * **問題 1（假綠燈與長官質詢）**：先前測試只斷言 `stdin.write() === true`，未斷言 OS 實體游標真實位移，屬於表面功夫假綠燈。
  * **問題 2（Windows Access Denied 5 阻斷）**：當加入真實座標檢查後，發現 `SendInput` 回傳 0 且錯誤碼為 `ERROR_ACCESS_DENIED (5)`，背景進程無權控制游標！
  * **根本原因**：Windows 核心安全機制將背景進程隔離於非互動式桌面，除非將線程附加至活動輸入桌面（Input Desktop），否則所有輸入注入與游標讀取均被物理攔截。
  * **避坑解法**：在 C# 原生宿主每次注入前調用 `OpenInputDesktop(0, false, GENERIC_ALL)` 與 `SetThreadDesktop(hDesk)`，成功穿透至使用者活動桌面，`SendInput` 瞬間成功回傳 1，游標在實體螢幕真實位移！
## 📅 2026-10-20 - Ticket 03 Android 端 OTG 鍵鼠獨占捕獲與轉發切片 (全綠)
* **交付成果**：
  * 完成 `protocol/android-keycodes.mjs`，建立 100+ 個 Android 原生 KeyCode 與 Windows Virtual-Key (VK) Code 精準對齊字典。
  * 支援 Windows 核心系統組合鍵（`Win+D`, `Alt+Tab`, `Ctrl+Shift+Esc`）、功能鍵（F1~F12）、方向鍵、NumPad 與符號鍵之雙向無損轉換。
  * 支援 Android `buttonState` 到 Windows 5 鍵遮罩（左/右/中/側退/側進）與修飾鍵（Meta/Ctrl/Alt/Shift）精準翻譯。
  * 完成 Android ➔ PC 雙端 Round-Trip 全鏈路閉環測試，標準測試 `npm test` 13 項測試全綠，Exit Code 0。

## 📅 2026-10-20 - 深度走查與邊界錯誤修正 (消滅 3 大隱患 + 防毒軟體隔離自癒)
* **修正錯誤 1（負數滾輪溢出）**：
  * C# 原生代碼中 `(uint)(wheel * 120)` 當滾輪向下滾動（負數，如 `-1`）時，強制轉型造成符號遺失變成溢出正數 `4294967176`。
  * 修正：採用 `unchecked((uint)(wheel * 120))` 正確保留負數整數之 32 位補碼，讓 Windows 正確識別向下滾動。
* **修正錯誤 2（滾輪與側鍵 mouseData 衝突）**：
  * 原先滾輪與側鍵共用同一 `INPUT` 的 `mouseData` 欄位，導致同時按著側鍵滾動時滾輪被沖掉。
  * 修正：將滾輪事件與側鍵（XBUTTON1/2）拆分為獨立 `INPUT` 呼叫派發，杜絕數值覆蓋。
* **修正錯誤 3（Windows 修飾鍵通用碼相容性）**：
  * 增加 `genericModifiers` 相容模式，將 Android 的 Ctrl/Alt/Shift 映射為標準通用碼 `VK_CONTROL (0x11)`、`VK_MENU (0x12)`、`VK_SHIFT (0x10)`，並在 C# 端為右側 Alt/Ctrl 與方向鍵補齊 `KEYEVENTF_EXTENDEDKEY`。
* **修正錯誤 4（防毒軟體隔離與自癒）**：
  * 當本地即時防毒（McAfee Real Protect）攔截並刪除 `InputBridge.exe` 時，`InputInjector.start()` 不再拋出致命崩潰，而是精準捕獲 `errno -4094` 並自動無感啟用安全降級自癒機制。
  * 標準全域測試 `npm test` 14 項測試全綠，Exit Code 0。





