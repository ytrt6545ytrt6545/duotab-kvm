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

