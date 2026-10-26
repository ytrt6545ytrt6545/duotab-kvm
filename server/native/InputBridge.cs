using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Collections.Concurrent;

namespace DuoTabKVM.Native
{
    public class Host
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

        [DllImport("user32.dll", CharSet = CharSet.Auto, ExactSpelling = true)]
        static extern uint MapVirtualKey(uint uCode, uint uMapType);

        [StructLayout(LayoutKind.Sequential)]
        struct POINT { public int X; public int Y; }

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
        struct INPUT { public int type; public InputUnion u; }

        [StructLayout(LayoutKind.Explicit)]
        struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }

        [StructLayout(LayoutKind.Sequential)]
        struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        [StructLayout(LayoutKind.Sequential)]
        struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

        static byte prevButtons = 0;
        static BlockingCollection<Action> taskQueue = new BlockingCollection<Action>();

        public static void Run()
        {
            Thread workerThread = new Thread(() =>
            {
                IntPtr hDesk = OpenInputDesktop(0, false, GENERIC_ALL);
                if (hDesk != IntPtr.Zero)
                {
                    bool ok = SetThreadDesktop(hDesk);
                    Console.Error.WriteLine("[Bridge] WorkerThread SetThreadDesktop=" + ok + ", hDesk=" + hDesk);
                }

                foreach (var action in taskQueue.GetConsumingEnumerable())
                {
                    try { action(); } catch {}
                }
            });

            workerThread.SetApartmentState(ApartmentState.STA);
            workerThread.IsBackground = true;
            workerThread.Start();

            Console.Error.WriteLine("[Bridge] Ready");

            using (var stdin = Console.OpenStandardInput())
            using (var stdout = Console.OpenStandardOutput())
            {
                byte[] header = new byte[1];
                while (true)
                {
                    int read = stdin.Read(header, 0, 1);
                    if (read <= 0) break;

                    byte packetType = header[0];
                    if (packetType == 0x00) // 查詢游標座標
                    {
                        var waitEvent = new ManualResetEvent(false);
                        POINT pt = new POINT();
                        taskQueue.Add(() =>
                        {
                            GetCursorPos(out pt);
                            waitEvent.Set();
                        });

                        waitEvent.WaitOne(500);

                        byte[] posBuf = new byte[8];
                        posBuf[0] = (byte)((pt.X >> 24) & 0xFF);
                        posBuf[1] = (byte)((pt.X >> 16) & 0xFF);
                        posBuf[2] = (byte)((pt.X >> 8) & 0xFF);
                        posBuf[3] = (byte)(pt.X & 0xFF);
                        posBuf[4] = (byte)((pt.Y >> 24) & 0xFF);
                        posBuf[5] = (byte)((pt.Y >> 16) & 0xFF);
                        posBuf[6] = (byte)((pt.Y >> 8) & 0xFF);
                        posBuf[7] = (byte)(pt.Y & 0xFF);
                        stdout.Write(posBuf, 0, 8);
                        stdout.Flush();
                    }
                    else if (packetType == 0x01) // MOUSE_MOVE_REL
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;
                        short dx = (short)((rest[0] << 8) | rest[1]);
                        short dy = (short)((rest[2] << 8) | rest[3]);
                        sbyte wheel = (sbyte)rest[4];
                        byte buttons = rest[5];

                        taskQueue.Add(() => InjectMouse(dx, dy, wheel, buttons));
                    }
                    else if (packetType == 0x02) // KEY_ACTION
                    {
                        byte[] rest = ReadExact(stdin, 5);
                        if (rest == null) break;
                        byte action = rest[0];
                        ushort vkCode = (ushort)((rest[1] << 8) | rest[2]);

                        taskQueue.Add(() => InjectKey(action, vkCode));
                    }
                    else if (packetType == 0x03) // HEARTBEAT
                    {
                        byte[] rest = ReadExact(stdin, 7);
                        if (rest == null) break;
                        stdout.WriteByte(0x06);
                        stdout.Flush();
                    }
                    else if (packetType == 0xFF) // EMERGENCY_RELEASE
                    {
                        taskQueue.Add(() => {
                            if (prevButtons != 0) InjectMouse(0, 0, 0, 0);
                        });
                    }
                }
            }

            taskQueue.CompleteAdding();
        }

        static byte[] ReadExact(Stream stream, int count)
        {
            byte[] buf = new byte[count];
            int offset = 0;
            while (offset < count) {
                int r = stream.Read(buf, offset, count - offset);
                if (r <= 0) return null;
                offset += r;
            }
            return buf;
        }

        static void InjectMouse(int dx, int dy, int wheel, byte buttons)
        {
            var list = new List<INPUT>();
            uint mainFlags = 0;
            if (dx != 0 || dy != 0) mainFlags |= MOUSEEVENTF_MOVE;
            if ((buttons & 0x01) != 0 && (prevButtons & 0x01) == 0) mainFlags |= MOUSEEVENTF_LEFTDOWN;
            if ((buttons & 0x01) == 0 && (prevButtons & 0x01) != 0) mainFlags |= MOUSEEVENTF_LEFTUP;
            if ((buttons & 0x02) != 0 && (prevButtons & 0x02) == 0) mainFlags |= MOUSEEVENTF_RIGHTDOWN;
            if ((buttons & 0x02) == 0 && (prevButtons & 0x02) != 0) mainFlags |= MOUSEEVENTF_RIGHTUP;
            if ((buttons & 0x04) != 0 && (prevButtons & 0x04) == 0) mainFlags |= MOUSEEVENTF_MIDDLEDOWN;
            if ((buttons & 0x04) == 0 && (prevButtons & 0x04) != 0) mainFlags |= MOUSEEVENTF_MIDDLEUP;

            if (mainFlags != 0) {
                INPUT inp = new INPUT();
                inp.type = INPUT_MOUSE;
                inp.u.mi.dx = dx; inp.u.mi.dy = dy;
                inp.u.mi.dwFlags = mainFlags;
                list.Add(inp);
            }

            if (wheel != 0) {
                INPUT w = new INPUT();
                w.type = INPUT_MOUSE;
                w.u.mi.mouseData = unchecked((uint)(wheel * 120));
                w.u.mi.dwFlags = MOUSEEVENTF_WHEEL;
                list.Add(w);
            }

            if ((buttons & 0x08) != 0 && (prevButtons & 0x08) == 0) {
                INPUT xd = new INPUT(); xd.type = INPUT_MOUSE; xd.u.mi.mouseData = 0x0001; xd.u.mi.dwFlags = MOUSEEVENTF_XDOWN; list.Add(xd);
            }
            if ((buttons & 0x08) == 0 && (prevButtons & 0x08) != 0) {
                INPUT xu = new INPUT(); xu.type = INPUT_MOUSE; xu.u.mi.mouseData = 0x0001; xu.u.mi.dwFlags = MOUSEEVENTF_XUP; list.Add(xu);
            }

            prevButtons = buttons;
            if (list.Count > 0) {
                SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
            }
        }

        static void InjectKey(byte action, ushort vkCode)
        {
            uint flags = 0;
            if (action == 0) flags |= KEYEVENTF_KEYUP;

            // 擴展鍵 (Extended Key): 左右Win、右Ctrl、右Alt、NumPad/、方向鍵等
            if (vkCode == 0x5B || vkCode == 0x5C || vkCode == 0xA3 || vkCode == 0xA5 || 
                vkCode == 0x6F || (vkCode >= 0x21 && vkCode <= 0x2E)) {
                flags |= KEYEVENTF_EXTENDEDKEY;
            }

            // 自動計算真實硬體掃描碼 (ScanCode)
            // MAPVK_VK_TO_VSC = 0: 將 Virtual-Key Code 轉換為物理硬體 ScanCode
            // 對微軟注音中英切換 (Shift 0x2A) 與小鍵盤字元識別至關重要
            ushort scanCode = (ushort)MapVirtualKey(vkCode, 0);

            INPUT inp = new INPUT();
            inp.type = INPUT_KEYBOARD;
            inp.u.ki.wVk = vkCode;
            inp.u.ki.wScan = scanCode;
            inp.u.ki.dwFlags = flags;
            SendInput(1, new INPUT[] { inp }, Marshal.SizeOf(typeof(INPUT)));
        }
    }
}
