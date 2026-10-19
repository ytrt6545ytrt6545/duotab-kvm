# DuoTab-KVM 雙端二進制協議規格 (Binary Wire Protocol)

本協議為 PC 端（Windows）與 Android 端（Tablet）之間的極致低延遲二進制通訊規格。
**全域採用網絡字節序 (Big-Endian)，4-Byte / 2-Byte 自然對齊。**

---

## 1. 封包類型表 (Packet Types)

| 類型代碼 (1B) | 封包名稱 | 總長度 | 用途與流向 |
| :--- | :--- | :--- | :--- |
| `0x01` | `MOUSE_MOVE_REL` | 8 Bytes | Android (Console) ➔ PC (滑鼠相對位移與按鈕) |
| `0x02` | `KEY_ACTION` | 6 Bytes | Android (Console) ➔ PC (鍵盤按下/釋放) |
| `0x03` | `HEARTBEAT` | 8 Bytes | 雙向 1/3 心跳租約與連線保活 |
| `0x04` | `STREAM_CONTROL` | 6 Bytes | 雙向動態 ABR 碼率與幀率調整信令 |

---

## 2. 二進制字節結構詳解

### 2.1 滑鼠相對位移包 (`MOUSE_MOVE_REL` · 8 Bytes)
```
Offset | 類型   | 欄位名稱   | 說明
-------+--------+------------+---------------------------------------------
0      | uint8  | type       | 固定為 0x01
1..2   | int16  | dx         | X 軸相對位移 (-32768 ~ 32767)
3..4   | int16  | dy         | Y 軸相對位移 (-32768 ~ 32767)
5      | int8   | wheel      | 滾輪滾動刻度 (-128 ~ 127, 向上為正, 向下為負)
6      | uint8  | buttons    | 按鍵位元遮罩: 0x01=左鍵, 0x02=右鍵, 0x04=中鍵, 0x08=側退, 0x10=側進
7      | uint8  | seq        | 滾動序號 (0~255)，防亂序與丟包
```

### 2.2 鍵盤按鍵包 (`KEY_ACTION` · 6 Bytes)
```
Offset | 類型   | 欄位名稱   | 說明
-------+--------+------------+---------------------------------------------
0      | uint8  | type       | 固定為 0x02
1      | uint8  | action     | 0x00=UP (釋放), 0x01=DOWN (按下)
2..3   | uint16 | vkCode     | Windows Virtual-Key Code (例: 0x5B=LWIN, 0x11=CTRL)
4      | uint8  | modifiers  | 修飾鍵遮罩: 0x01=Shift, 0x02=Ctrl, 0x04=Alt, 0x08=Win
5      | uint8  | seq        | 滾動序號 (0~255)
```

### 2.3 心跳租約包 (`HEARTBEAT` · 8 Bytes)
```
Offset | 類型   | 欄位名稱   | 說明
-------+--------+------------+---------------------------------------------
0      | uint8  | type       | 固定為 0x03
1      | uint8  | role       | 0x01=CONSOLE (主螢幕), 0x02=DISPLAY (延伸螢幕)
2..3   | uint16 | leaseMs    | 租約時效 (預設 1500ms)
4..7   | uint32 | timestamp  | 發送端時間戳 (毫秒低 32 位)
```

---

## 3. 無頭狀態機與急停防護 (Lease Watchdog)
* **1/3 租約心跳守則**：心跳發送間隔為租約時效之 1/3（預設每 500ms 一跳，租約 1500ms）。
* **防黏鍵急停 (Emergency Release)**：若超過 1500ms 未收到任何有效輸入或心跳，PC 端狀態機自動釋放所有當前按住的鍵盤虛擬碼與滑鼠按鍵，徹底杜絕平板斷線或熄屏導致的 Windows 系統鎖死。
