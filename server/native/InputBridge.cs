using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;

namespace DuoTabKVM.Native
{
    class Program
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetThreadDesktop(IntPtr hDesktop);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

        [DllImport("user32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetCursorPos(out POINT lpPoint);

        [StructLayout(LayoutKind.Sequential)]
        struct POINT
        {
            public int X;
            public int Y;
        }

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
        const uint GENERIC_ALL = 0x10000000;

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

        static void EnsureDesktop()
        {
            try
            {
                IntPtr hDesk = OpenInputDesktop(0, false, GENERIC_ALL);
                if (hDesk != IntPtr.Zero)
                {
                    SetThreadDesktop(hDesk);
                }
            }
            catch { }
        }

        static void Main(string[] args)
        {
            EnsureDesktop();

            using (var stdin = Console.OpenStandardInput())
            using (var stdout = Console.OpenStandardOutput())
            {
                byte[] header = new byte[1];
                while (true)
                {
                    int read = stdin.Read(header, 0, 1);
                    if (read <= 0) break; // 管道關閉，安全退出

                    byte packetType = header[0];
                    if (packetType == 0x00) // 查詢真實游標座標 (Win32 GetCursorPos)
                    {
                        EnsureDesktop();
                        POINT pt;
                        GetCursorPos(out pt);
                        byte[] posBuf = new byte[4];
                        posBuf[0] = (byte)((pt.X >> 8) & 0xFF);
                        posBuf[1] = (byte)(pt.X & 0xFF);
                        posBuf[2] = (byte)((pt.Y >> 8) & 0xFF);
                        posBuf[3] = (byte)(pt.Y & 0xFF);
                        stdout.Write(posBuf, 0, 4);
                        stdout.Flush();
                    }
                    else if (packetType == 0x01) // MOUSE_MOVE_REL (7 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;

                        short dx = (short)((rest[0] << 8) | rest[1]);
                        short dy = (short)((rest[2] << 8) | rest[3]);
                        sbyte wheel = (sbyte)rest[4];
                        byte buttons = rest[5];

                        InjectMouse(dx, dy, wheel, buttons);
                    }
                    else if (packetType == 0x02) // KEY_ACTION (5 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 5);
                        if (rest == null) break;

                        byte action = rest[0]; // 0=UP, 1=DOWN
                        ushort vkCode = (ushort)((rest[1] << 8) | rest[2]);
                        byte modifiers = rest[3];

                        InjectKey(action, vkCode);
                    }
                    else if (packetType == 0x03) // HEARTBEAT (7 bytes 剩餘)
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;
                        stdout.WriteByte(0x06); // ACK
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
            EnsureDesktop();
            var inputList = new List<INPUT>();

            // 1. 移動與主要按鍵 (左/右/中)
            uint mainFlags = 0;
            if (dx != 0 || dy != 0) mainFlags |= MOUSEEVENTF_MOVE;
            if ((buttons & 0x01) != 0 && (prevButtons & 0x01) == 0) mainFlags |= MOUSEEVENTF_LEFTDOWN;
            if ((buttons & 0x01) == 0 && (prevButtons & 0x01) != 0) mainFlags |= MOUSEEVENTF_LEFTUP;
            if ((buttons & 0x02) != 0 && (prevButtons & 0x02) == 0) mainFlags |= MOUSEEVENTF_RIGHTDOWN;
            if ((buttons & 0x02) == 0 && (prevButtons & 0x02) != 0) mainFlags |= MOUSEEVENTF_RIGHTUP;
            if ((buttons & 0x04) != 0 && (prevButtons & 0x04) == 0) mainFlags |= MOUSEEVENTF_MIDDLEDOWN;
            if ((buttons & 0x04) == 0 && (prevButtons & 0x04) != 0) mainFlags |= MOUSEEVENTF_MIDDLEUP;

            if (mainFlags != 0)
            {
                INPUT input = new INPUT();
                input.type = INPUT_MOUSE;
                input.u.mi.dx = dx;
                input.u.mi.dy = dy;
                input.u.mi.mouseData = 0;
                input.u.mi.dwFlags = mainFlags;
                inputList.Add(input);
            }

            // 2. 獨立發送滾輪事件 (防 mouseData 衝突，並保留負數符號補碼)
            if (wheel != 0)
            {
                INPUT wheelInput = new INPUT();
                wheelInput.type = INPUT_MOUSE;
                wheelInput.u.mi.dx = 0;
                wheelInput.u.mi.dy = 0;
                // 正確保留負數整數之 32 位補碼
                int deltaVal = wheel * 120;
                wheelInput.u.mi.mouseData = unchecked((uint)deltaVal);
                wheelInput.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
                inputList.Add(wheelInput);
            }

            // 3. 獨立發送側鍵 XBUTTON1 / XBUTTON2 (防 mouseData 覆蓋)
            if ((buttons & 0x08) != 0 && (prevButtons & 0x08) == 0)
            {
                INPUT xDown = new INPUT();
                xDown.type = INPUT_MOUSE;
                xDown.u.mi.mouseData = 0x0001; // XBUTTON1
                xDown.u.mi.dwFlags = MOUSEEVENTF_XDOWN;
                inputList.Add(xDown);
            }
            if ((buttons & 0x08) == 0 && (prevButtons & 0x08) != 0)
            {
                INPUT xUp = new INPUT();
                xUp.type = INPUT_MOUSE;
                xUp.u.mi.mouseData = 0x0001;
                xUp.u.mi.dwFlags = MOUSEEVENTF_XUP;
                inputList.Add(xUp);
            }

            if ((buttons & 0x10) != 0 && (prevButtons & 0x10) == 0)
            {
                INPUT xDown = new INPUT();
                xDown.type = INPUT_MOUSE;
                xDown.u.mi.mouseData = 0x0002; // XBUTTON2
                xDown.u.mi.dwFlags = MOUSEEVENTF_XDOWN;
                inputList.Add(xDown);
            }
            if ((buttons & 0x10) == 0 && (prevButtons & 0x10) != 0)
            {
                INPUT xUp = new INPUT();
                xUp.type = INPUT_MOUSE;
                xUp.u.mi.mouseData = 0x0002;
                xUp.u.mi.dwFlags = MOUSEEVENTF_XUP;
                inputList.Add(xUp);
            }

            prevButtons = buttons;

            if (inputList.Count > 0)
            {
                SendInput((uint)inputList.Count, inputList.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            }
        }

        static void InjectKey(byte action, ushort vkCode)
        {
            EnsureDesktop();
            uint flags = 0;
            if (action == 0) flags |= KEYEVENTF_KEYUP;

            // 延伸鍵處理 (右側 Win, 右側 Alt, 右側 Ctrl, 方向鍵, 翻頁鍵, Insert, Delete)
            if (vkCode == 0x5B || vkCode == 0x5C || 
                vkCode == 0xA3 || vkCode == 0xA5 || 
                (vkCode >= 0x21 && vkCode <= 0x2E))
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
            if (prevButtons != 0)
            {
                InjectMouse(0, 0, 0, 0);
            }
        }
    }
}
