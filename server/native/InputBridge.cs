using System;
using System.IO;
using System.Runtime.InteropServices;

namespace DuoTabKVM.Native
{
    class Program
    {
        // Win32 API 定義
        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        const int INPUT_MOUSE = 0;
        const int INPUT_KEYBOARD = 1;

        const uint MOUSEEVENTF_MOVE = 0x0001;
        const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        const uint MOUSEEVENTF_LEFTUP = 0x0004;
        const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
        const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
        const uint MOUSEEVENTF_XDOWN = 0x0080;
        const uint MOUSEEVENTF_XUP = 0x0100;
        const uint MOUSEEVENTF_WHEEL = 0x0800;

        const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        const uint KEYEVENTF_KEYUP = 0x0002;

        [StructLayout(LayoutKind.Sequential)]
        struct INPUT
        {
            public int type;
            public InputUnion u;
        }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        static byte prevButtons = 0;

        static void Main(string[] args)
        {
            // 將標準輸入流切換為二進制
            using (var stdin = Console.OpenStandardInput())
            using (var stdout = Console.OpenStandardOutput())
            {
                byte[] header = new byte[1];
                while (true)
                {
                    int read = stdin.Read(header, 0, 1);
                    if (read <= 0) break; // 管道關閉，安全退出

                    byte packetType = header[0];
                    if (packetType == 0x01) // MOUSE_MOVE_REL (7 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;

                        short dx = (short)((rest[0] << 8) | rest[1]);
                        short dy = (short)((rest[2] << 8) | rest[3]);
                        sbyte wheel = (sbyte)rest[4];
                        byte buttons = rest[5];
                        // rest[6] 是 seq

                        InjectMouse(dx, dy, wheel, buttons);
                    }
                    else if (packetType == 0x02) // KEY_ACTION (5 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 5);
                        if (rest == null) break;

                        byte action = rest[0]; // 0=UP, 1=DOWN
                        ushort vkCode = (ushort)((rest[1] << 8) | rest[2]);
                        byte modifiers = rest[3];
                        // rest[4] 是 seq

                        InjectKey(action, vkCode);
                    }
                    else if (packetType == 0x03) // HEARTBEAT (7 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;
                        // 回傳 ACK 0x06
                        stdout.WriteByte(0x06);
                        stdout.Flush();
                    }
                    else if (packetType == 0xFF) // 急停釋放
                    {
                        ReleaseAll();
                    }
                }
            }
        }

        static byte[] ReadExact(Stream stream, int count)
        {
            byte[] buf = new byte[count];
            int offset = 0;
            while (offset < count)
            {
                int r = stream.Read(buf, offset, count - offset);
                if (r <= 0) return null;
                offset += r;
            }
            return buf;
        }

        static void InjectMouse(int dx, int dy, int wheel, byte buttons)
        {
            uint flags = 0;
            if (dx != 0 || dy != 0) flags |= MOUSEEVENTF_MOVE;
            if (wheel != 0) flags |= MOUSEEVENTF_WHEEL;

            // 檢查左鍵
            if ((buttons & 0x01) != 0 && (prevButtons & 0x01) == 0) flags |= MOUSEEVENTF_LEFTDOWN;
            if ((buttons & 0x01) == 0 && (prevButtons & 0x01) != 0) flags |= MOUSEEVENTF_LEFTUP;

            // 檢查右鍵
            if ((buttons & 0x02) != 0 && (prevButtons & 0x02) == 0) flags |= MOUSEEVENTF_RIGHTDOWN;
            if ((buttons & 0x02) == 0 && (prevButtons & 0x02) != 0) flags |= MOUSEEVENTF_RIGHTUP;

            // 檢查中鍵
            if ((buttons & 0x04) != 0 && (prevButtons & 0x04) == 0) flags |= MOUSEEVENTF_MIDDLEDOWN;
            if ((buttons & 0x04) == 0 && (prevButtons & 0x04) != 0) flags |= MOUSEEVENTF_MIDDLEUP;

            // 檢查側鍵後退 (XBUTTON1)
            uint mouseData = 0;
            if (wheel != 0) mouseData = (uint)(wheel * 120);

            if ((buttons & 0x08) != 0 && (prevButtons & 0x08) == 0) { flags |= MOUSEEVENTF_XDOWN; mouseData = 0x0001; }
            if ((buttons & 0x08) == 0 && (prevButtons & 0x08) != 0) { flags |= MOUSEEVENTF_XUP; mouseData = 0x0001; }

            // 檢查側鍵前進 (XBUTTON2)
            if ((buttons & 0x10) != 0 && (prevButtons & 0x10) == 0) { flags |= MOUSEEVENTF_XDOWN; mouseData = 0x0002; }
            if ((buttons & 0x10) == 0 && (prevButtons & 0x10) != 0) { flags |= MOUSEEVENTF_XUP; mouseData = 0x0002; }

            prevButtons = buttons;

            if (flags != 0)
            {
                INPUT input = new INPUT();
                input.type = INPUT_MOUSE;
                input.u.mi.dx = dx;
                input.u.mi.dy = dy;
                input.u.mi.mouseData = mouseData;
                input.u.mi.dwFlags = flags;
                SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
            }
        }

        static void InjectKey(byte action, ushort vkCode)
        {
            uint flags = 0;
            if (action == 0) flags |= KEYEVENTF_KEYUP; // UP

            // 延伸鍵處理 (例如右側 Alt/Ctrl, 方向鍵, Win 鍵等)
            if (vkCode == 0x5B || vkCode == 0x5C || (vkCode >= 0x21 && vkCode <= 0x28))
            {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }

            INPUT input = new INPUT();
            input.type = INPUT_KEYBOARD;
            input.u.ki.wVk = vkCode;
            input.u.ki.wScan = 0;
            input.u.ki.dwFlags = flags;
            SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT)));
        }

        static void ReleaseAll()
        {
            // 釋放左中右鍵
            if (prevButtons != 0)
            {
                InjectMouse(0, 0, 0, 0);
            }
        }
    }
}
